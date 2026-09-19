import { TRANSPORT_LIMITS, type UnauthenticatedProtocolEnvelope } from "@huddle/protocol";
import type { DeviceSession, HuddleSdk, TestSignal } from "@huddle/sdk";

export interface VerifiedDeviceToken { readonly accountId: string; readonly deviceId: string; readonly expiresAtMs: number; }
export interface DeviceTokenVerifier { verify(token: string): Promise<VerifiedDeviceToken>; }
export interface RuntimeClock { nowMs(): number; }
export class RuntimeApi {
  private readonly pending = new Map<string, UnauthenticatedProtocolEnvelope>();
  public constructor(private readonly sdk: HuddleSdk, private readonly verifier: DeviceTokenVerifier, private readonly clock: RuntimeClock) {}
  public async authorizeAndPublishSignal(token: string, signal: TestSignal): Promise<void> {
    this.sdk.submitTestSignal(await this.session(token), signal);
  }
  /** Stores only provider-produced opaque ciphertext until the intended device ACKs. */
  public async enqueueCiphertext(token: string, envelope: UnauthenticatedProtocolEnvelope): Promise<void> {
    const session = await this.session(token);
    if (envelope.senderAccountId !== session.accountId || envelope.senderDeviceId !== session.deviceId || envelope.messageType !== "application" || envelope.expiresAtMs <= this.clock.nowMs()) throw new RuntimeApiError("UNAUTHORIZED");
    if (envelope.payload.byteLength > TRANSPORT_LIMITS.maximumApplicationPayloadBytes) throw new RuntimeApiError("PAYLOAD_TOO_LARGE");
    const recipientDevices = this.sdk.listDevices(envelope.recipientAccountId as never);
    if (!recipientDevices.some((device) => device.id === envelope.recipientDeviceId && device.status === "active")) throw new RuntimeApiError("UNAUTHORIZED");
    const huddle = this.sdk.listHuddles(session.accountId).find((candidate) => candidate.id === envelope.huddleId);
    if (huddle === undefined || !huddle.members.has(envelope.recipientAccountId as never) || huddle.epoch !== envelope.epoch) throw new RuntimeApiError("UNAUTHORIZED");
    const recipientKey = key(envelope.recipientDeviceId, envelope.messageId);
    const perDevice = [...this.pending.keys()].filter((candidate) => candidate.startsWith(`${envelope.recipientDeviceId}:`)).length;
    if (!this.pending.has(recipientKey) && perDevice >= TRANSPORT_LIMITS.maximumOutboxEntriesPerRecipient) throw new RuntimeApiError("QUEUE_LIMIT_EXCEEDED");
    this.pending.set(recipientKey, copyEnvelope(envelope));
  }
  public async takePending(token: string): Promise<readonly UnauthenticatedProtocolEnvelope[]> {
    const session = await this.session(token);
    const now = this.clock.nowMs();
    return [...this.pending.values()].filter((item) => item.recipientDeviceId === session.deviceId && item.expiresAtMs > now).map(copyEnvelope);
  }
  /** Idempotent: an already-ACKed or unknown message succeeds without leaking state. */
  public async acknowledge(token: string, messageId: string): Promise<void> {
    const session = await this.session(token);
    this.pending.delete(key(session.deviceId, messageId));
  }
  private async session(token: string): Promise<DeviceSession> {
    const verified = await this.verifier.verify(token);
    if (verified.expiresAtMs <= this.clock.nowMs()) throw new RuntimeApiError("TOKEN_EXPIRED");
    return { accountId: verified.accountId as never, deviceId: verified.deviceId as never };
  }
}
export class RuntimeApiError extends Error { public constructor(public readonly code: "UNAUTHORIZED" | "TOKEN_EXPIRED" | "PAYLOAD_TOO_LARGE" | "QUEUE_LIMIT_EXCEEDED") { super(code); } }
function key(deviceId: string, messageId: string): string { return `${deviceId}:${messageId}`; }
function copyEnvelope(value: UnauthenticatedProtocolEnvelope): UnauthenticatedProtocolEnvelope { return { ...value, authentication: value.authentication.slice(), payload: value.payload.slice() }; }
