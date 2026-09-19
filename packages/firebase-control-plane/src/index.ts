import type { Account, Device, DeviceSession, Huddle, TestSignal } from "@huddle/sdk";

/** A deliberately small port implemented by Firebase client or Admin SDK adapters. */
export interface FirebaseWritePort {
  setFirestore(path: string, value: FirebaseValue): Promise<void>;
  setRealtime(path: string, value: FirebaseValue): Promise<void>;
}

export type FirebaseValue = null | boolean | number | string | readonly FirebaseValue[] | { readonly [key: string]: FirebaseValue };

export interface PresenceUpdate {
  readonly state: "online" | "away";
  readonly expiresAtMs: number;
}

/**
 * Maps validated domain records into the Firebase data contract. It accepts no
 * private keys or message content, makes no logs, and leaves sensitive mutation
 * authorization to the TypeScript API before this adapter is called.
 */
export class FirebaseControlPlaneAdapter {
  public constructor(private readonly port: FirebaseWritePort) {}

  public async saveAccount(account: Account): Promise<void> {
    await this.port.setFirestore(`accounts/${account.id}`, {
      createdAtMs: account.createdAtMs, displayUsername: account.username, status: account.status,
    });
  }

  public async saveDevice(device: Device): Promise<void> {
    await this.port.setFirestore(`devices/${device.id}`, {
      accountId: device.accountId, createdAtMs: device.createdAtMs, fingerprint: device.fingerprint,
      publicIdentityKey: bytesToBase64(device.publicIdentityKey), revokedAtMs: device.revokedAtMs ?? null, status: device.status,
    });
  }

  public async saveHuddle(huddle: Huddle): Promise<void> {
    await this.port.setFirestore(`huddles/${huddle.id}`, {
      createdAtMs: huddle.createdAtMs, epoch: huddle.epoch, ownerAccountId: huddle.ownerAccountId,
    });
    await Promise.all([...huddle.members.entries()].map(async ([accountId, role]) => {
      await this.port.setFirestore(`huddles/${huddle.id}/members/${accountId}`, { role, status: "active" });
    }));
  }

  public async updatePresence(session: DeviceSession, presence: PresenceUpdate): Promise<void> {
    if (!isPresenceValid(presence)) throw new FirebaseControlPlaneError("FIREBASE_VALUE_INVALID");
    await this.port.setRealtime(`presence/${session.accountId}/${session.deviceId}`, {
      expiresAtMs: presence.expiresAtMs, state: presence.state,
    });
  }

  public async publishTestSignal(session: DeviceSession, signal: TestSignal): Promise<void> {
    if (signal.senderDeviceId !== session.deviceId || signal.expiresAtMs <= signal.createdAtMs || signal.body.byteLength > 65_536) {
      throw new FirebaseControlPlaneError("FIREBASE_VALUE_INVALID");
    }
    await this.port.setRealtime(`signaling/${signal.huddleId}/${signal.recipientDeviceId}/${signal.signalId}`, {
      body: bytesToBase64(signal.body), connectionId: signal.connectionId, createdAtMs: signal.createdAtMs,
      expiresAtMs: signal.expiresAtMs, kind: signal.kind, recipientAccountId: signal.recipientAccountId,
      senderAccountId: session.accountId, senderDeviceId: signal.senderDeviceId,
    });
  }
}

export class FirebaseControlPlaneError extends Error {
  public constructor(public readonly code: "FIREBASE_VALUE_INVALID") { super(code); this.name = "FirebaseControlPlaneError"; }
}

function isPresenceValid(presence: PresenceUpdate): boolean {
  return (presence.state === "online" || presence.state === "away") && Number.isSafeInteger(presence.expiresAtMs) && presence.expiresAtMs > 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
