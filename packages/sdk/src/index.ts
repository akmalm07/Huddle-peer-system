import { CRYPTO_IMPLEMENTATION_STATUS } from "@huddle/crypto";
import { TRANSPORT_LIMITS } from "@huddle/protocol";

declare const accountIdBrand: unique symbol;
declare const deviceIdBrand: unique symbol;
declare const huddleIdBrand: unique symbol;

export type AccountId = string & { readonly [accountIdBrand]: "AccountId" };
export type DeviceId = string & { readonly [deviceIdBrand]: "DeviceId" };
export type HuddleId = string & { readonly [huddleIdBrand]: "HuddleId" };

const identifier = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_PUBLIC_KEY_BYTES = 4_096;
const SIGNAL_TTL_MS = 5 * 60 * 1_000;

export function accountId(value: string): AccountId { return validateId(value, "ACCOUNT_ID_INVALID") as AccountId; }
export function deviceId(value: string): DeviceId { return validateId(value, "DEVICE_ID_INVALID") as DeviceId; }
export function huddleId(value: string): HuddleId { return validateId(value, "HUDDLE_ID_INVALID") as HuddleId; }

export interface Account {
  readonly id: AccountId;
  readonly username: string;
  readonly status: "active" | "disabled";
  readonly createdAtMs: number;
}

export interface Device {
  readonly id: DeviceId;
  readonly accountId: AccountId;
  /** Public directory data only. Private key material never enters this API. */
  readonly publicIdentityKey: Uint8Array;
  readonly fingerprint: string;
  readonly status: "active" | "revoked";
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
}

export interface Huddle {
  readonly id: HuddleId;
  readonly ownerAccountId: AccountId;
  readonly epoch: number;
  readonly members: ReadonlyMap<AccountId, "owner" | "member">;
  readonly createdAtMs: number;
}

export interface DeviceSession {
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
}

export interface TestSignal {
  readonly protocolVersion: 1;
  readonly signalId: string;
  readonly huddleId: HuddleId;
  readonly connectionId: string;
  readonly senderDeviceId: DeviceId;
  readonly recipientAccountId: AccountId;
  readonly recipientDeviceId: DeviceId;
  readonly kind: "offer" | "answer" | "candidate" | "connection-hint";
  /** Opaque SDP/ICE/test-event bytes. This API neither logs nor interprets them. */
  readonly body: Uint8Array;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface CreateAccountRequest {
  readonly id: AccountId;
  readonly username: string;
  readonly createdAtMs: number;
}

export interface RegisterDeviceRequest {
  readonly id: DeviceId;
  readonly publicIdentityKey: Uint8Array;
  readonly fingerprint: string;
  readonly createdAtMs: number;
}

/** A reusable control-plane facade. Chat-content operations remain fail-closed. */
export interface HuddleSdk {
  createAccount(request: CreateAccountRequest): Account;
  registerDevice(account: AccountId, request: RegisterDeviceRequest): Device;
  listDevices(account: AccountId): readonly Device[];
  revokeDevice(session: DeviceSession, target: DeviceId, atMs: number): Device;
  createHuddle(session: DeviceSession, id: HuddleId, createdAtMs: number): Huddle;
  addMember(session: DeviceSession, target: AccountId, huddle: HuddleId): Huddle;
  removeMember(session: DeviceSession, target: AccountId, huddle: HuddleId): Huddle;
  listHuddles(account: AccountId): readonly Huddle[];
  submitTestSignal(session: DeviceSession, signal: TestSignal): void;
  takeTestSignals(session: DeviceSession, nowMs: number): readonly TestSignal[];
  sendMessage(): never;
}

export type HuddleSdkErrorCode =
  | "ACCOUNT_ID_INVALID" | "DEVICE_ID_INVALID" | "HUDDLE_ID_INVALID" | "IDENTIFIER_INVALID"
  | "ACCOUNT_NOT_FOUND" | "ACCOUNT_EXISTS" | "DEVICE_NOT_FOUND" | "DEVICE_EXISTS"
  | "DEVICE_REVOKED" | "ACTOR_NOT_AUTHORIZED" | "HUDDLE_NOT_FOUND" | "HUDDLE_EXISTS"
  | "NOT_HUDDLE_OWNER" | "MEMBER_NOT_FOUND" | "DIRECT_MESH_CAPACITY_EXCEEDED"
  | "SIGNAL_INVALID" | "SIGNAL_LIMIT_EXCEEDED" | "CONTENT_DISABLED";

export class HuddleSdkError extends Error {
  public constructor(public readonly code: HuddleSdkErrorCode) { super(code); this.name = "HuddleSdkError"; }
}

/**
 * Deterministic reference implementation for tests and demo integration.
 * Production adapters must authorize each call using the authenticated Firebase/API
 * identity and write the equivalent data to Firestore/Realtime Database.
 */
export class InMemoryHuddleSdk implements HuddleSdk {
  private readonly accounts = new Map<AccountId, Account>();
  private readonly devices = new Map<DeviceId, Device>();
  private readonly huddles = new Map<HuddleId, Huddle>();
  private readonly signals = new Map<DeviceId, TestSignal[]>();

  public createAccount(request: CreateAccountRequest): Account {
    validateTimestamp(request.createdAtMs);
    if (!isUsername(request.username)) throw new HuddleSdkError("IDENTIFIER_INVALID");
    if (this.accounts.has(request.id)) throw new HuddleSdkError("ACCOUNT_EXISTS");
    const account = Object.freeze({ ...request, status: "active" as const });
    this.accounts.set(account.id, account);
    return account;
  }

  public registerDevice(owner: AccountId, request: RegisterDeviceRequest): Device {
    this.requireAccount(owner);
    validateTimestamp(request.createdAtMs);
    if (!isFingerprint(request.fingerprint) || request.publicIdentityKey.byteLength < 1 || request.publicIdentityKey.byteLength > MAX_PUBLIC_KEY_BYTES) {
      throw new HuddleSdkError("IDENTIFIER_INVALID");
    }
    if (this.devices.has(request.id)) throw new HuddleSdkError("DEVICE_EXISTS");
    const device: Device = Object.freeze({
      accountId: owner, createdAtMs: request.createdAtMs, fingerprint: request.fingerprint,
      id: request.id, publicIdentityKey: request.publicIdentityKey.slice(), status: "active",
    });
    this.devices.set(device.id, device);
    return device;
  }

  public listDevices(owner: AccountId): readonly Device[] {
    this.requireAccount(owner);
    return [...this.devices.values()].filter((candidate) => candidate.accountId === owner);
  }

  public revokeDevice(session: DeviceSession, target: DeviceId, atMs: number): Device {
    this.requireActiveSession(session);
    validateTimestamp(atMs);
    const device = this.requireDevice(target);
    if (device.accountId !== session.accountId) throw new HuddleSdkError("ACTOR_NOT_AUTHORIZED");
    if (device.status === "revoked") return device;
    const revoked = Object.freeze({ ...device, status: "revoked" as const, revokedAtMs: atMs });
    this.devices.set(target, revoked);
    return revoked;
  }

  public createHuddle(session: DeviceSession, id: HuddleId, createdAtMs: number): Huddle {
    this.requireActiveSession(session);
    validateTimestamp(createdAtMs);
    if (this.huddles.has(id)) throw new HuddleSdkError("HUDDLE_EXISTS");
    const huddle: Huddle = Object.freeze({
      id, ownerAccountId: session.accountId, epoch: 1, createdAtMs,
      members: new Map([[session.accountId, "owner" as const]]),
    });
    this.huddles.set(id, huddle);
    return huddle;
  }

  public addMember(session: DeviceSession, target: AccountId, id: HuddleId): Huddle {
    this.requireActiveSession(session);
    this.requireAccount(target);
    const current = this.requireOwner(session, id);
    if (current.members.has(target)) return current;
    return this.saveHuddle(current, new Map([...current.members, [target, "member" as const]]));
  }

  public removeMember(session: DeviceSession, target: AccountId, id: HuddleId): Huddle {
    this.requireActiveSession(session);
    const current = this.requireOwner(session, id);
    if (target === current.ownerAccountId) throw new HuddleSdkError("ACTOR_NOT_AUTHORIZED");
    if (!current.members.has(target)) throw new HuddleSdkError("MEMBER_NOT_FOUND");
    const members = new Map(current.members);
    members.delete(target);
    return this.saveHuddle(current, members);
  }

  public listHuddles(owner: AccountId): readonly Huddle[] {
    this.requireAccount(owner);
    return [...this.huddles.values()].filter((candidate) => candidate.members.has(owner));
  }

  public submitTestSignal(session: DeviceSession, signal: TestSignal): void {
    this.requireActiveSession(session);
    validateSignal(signal);
    if (signal.senderDeviceId !== session.deviceId) throw new HuddleSdkError("ACTOR_NOT_AUTHORIZED");
    const huddle = this.requireHuddle(signal.huddleId);
    const recipient = this.requireDevice(signal.recipientDeviceId);
    if (signal.recipientAccountId !== recipient.accountId || !huddle.members.has(session.accountId) || !huddle.members.has(recipient.accountId) || recipient.status !== "active") {
      throw new HuddleSdkError("ACTOR_NOT_AUTHORIZED");
    }
    const activeDevices = [...this.devices.values()].filter((device) => device.status === "active" && huddle.members.has(device.accountId));
    if (activeDevices.length > TRANSPORT_LIMITS.maximumActiveMeshDevices) throw new HuddleSdkError("DIRECT_MESH_CAPACITY_EXCEEDED");
    const pending = this.signals.get(recipient.id) ?? [];
    const sameConnection = pending.filter((candidate) => candidate.connectionId === signal.connectionId);
    if (sameConnection.length >= TRANSPORT_LIMITS.maximumIceCandidatesPerNegotiation) throw new HuddleSdkError("SIGNAL_LIMIT_EXCEEDED");
    if (pending.some((candidate) => candidate.signalId === signal.signalId)) return;
    this.signals.set(recipient.id, [...pending, copySignal(signal)]);
  }

  public takeTestSignals(session: DeviceSession, nowMs: number): readonly TestSignal[] {
    this.requireActiveSession(session);
    validateTimestamp(nowMs);
    const pending = this.signals.get(session.deviceId) ?? [];
    this.signals.delete(session.deviceId);
    return pending.filter((signal) => signal.expiresAtMs > nowMs).map(copySignal);
  }

  public sendMessage(): never {
    // This guard is intentional: the architecture bans content until a reviewed provider exists.
    void CRYPTO_IMPLEMENTATION_STATUS;
    throw new HuddleSdkError("CONTENT_DISABLED");
  }

  private requireAccount(id: AccountId): Account {
    const account = this.accounts.get(id);
    if (account === undefined) throw new HuddleSdkError("ACCOUNT_NOT_FOUND");
    return account;
  }
  private requireDevice(id: DeviceId): Device {
    const device = this.devices.get(id);
    if (device === undefined) throw new HuddleSdkError("DEVICE_NOT_FOUND");
    return device;
  }
  private requireActiveSession(session: DeviceSession): Device {
    const device = this.requireDevice(session.deviceId);
    if (device.accountId !== session.accountId) throw new HuddleSdkError("ACTOR_NOT_AUTHORIZED");
    if (device.status !== "active") throw new HuddleSdkError("DEVICE_REVOKED");
    return device;
  }
  private requireHuddle(id: HuddleId): Huddle {
    const huddle = this.huddles.get(id);
    if (huddle === undefined) throw new HuddleSdkError("HUDDLE_NOT_FOUND");
    return huddle;
  }
  private requireOwner(session: DeviceSession, id: HuddleId): Huddle {
    const huddle = this.requireHuddle(id);
    if (huddle.ownerAccountId !== session.accountId) throw new HuddleSdkError("NOT_HUDDLE_OWNER");
    return huddle;
  }
  private saveHuddle(current: Huddle, members: ReadonlyMap<AccountId, "owner" | "member">): Huddle {
    const updated: Huddle = Object.freeze({ ...current, epoch: current.epoch + 1, members: new Map(members) });
    this.huddles.set(updated.id, updated);
    return updated;
  }
}

function validateId(value: string, code: HuddleSdkErrorCode): string {
  if (!identifier.test(value)) throw new HuddleSdkError(code);
  return value;
}
function validateTimestamp(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new HuddleSdkError("SIGNAL_INVALID"); }
function isUsername(value: string): boolean { return /^[A-Za-z0-9_.-]{1,64}$/.test(value); }
function isFingerprint(value: string): boolean { return /^[a-f0-9]{32,128}$/i.test(value); }
function validateSignal(signal: TestSignal): void {
  if (signal.protocolVersion !== 1 || !identifier.test(signal.signalId) || !identifier.test(signal.connectionId) ||
    signal.body.byteLength > TRANSPORT_LIMITS.maximumFrameBytes || !Number.isSafeInteger(signal.createdAtMs) ||
    !Number.isSafeInteger(signal.expiresAtMs) || signal.expiresAtMs <= signal.createdAtMs || signal.expiresAtMs - signal.createdAtMs > SIGNAL_TTL_MS) {
    throw new HuddleSdkError("SIGNAL_INVALID");
  }
}
function copySignal(signal: TestSignal): TestSignal { return Object.freeze({ ...signal, body: signal.body.slice() }); }
