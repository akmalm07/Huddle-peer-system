import type { Database } from "firebase/database";
import { onChildAdded, push, ref, remove, set } from "firebase/database";
import type { WebRtcSignal, WebRtcSignaler } from "@huddle/webrtc";

const MAX_SIGNAL_BYTES = 64 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,96}$/;

export interface FirebaseSignalRoute {
  readonly huddleId: string;
  readonly localDeviceId: string;
  readonly recipientDeviceId: string;
  readonly connectionId: string;
  readonly expiresAtMs: () => number;
}

/** Firebase RTDB adapter for one authorized WebRTC peer direction. It never logs SDP or ICE. */
export class FirebaseRtdbWebRtcSignaler implements WebRtcSignaler {
  public constructor(private readonly database: Database, private readonly route: FirebaseSignalRoute) {
    for (const value of [route.huddleId, route.localDeviceId, route.recipientDeviceId, route.connectionId]) {
      if (!idPattern.test(value)) throw new FirebaseWebSignalingError("SIGNAL_ROUTE_INVALID");
    }
  }
  public async publish(signal: WebRtcSignal): Promise<void> {
    const payload = { connectionId: this.route.connectionId, expiresAtMs: this.route.expiresAtMs(), senderDeviceId: this.route.localDeviceId, signal };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > MAX_SIGNAL_BYTES || payload.expiresAtMs <= Date.now()) throw new FirebaseWebSignalingError("SIGNAL_INVALID");
    const target = push(ref(this.database, `signaling/${this.route.huddleId}/${this.route.recipientDeviceId}`));
    await set(target, payload);
  }
  /** Subscribe before `offer()` so candidates and answers cannot be missed. */
  subscribe(onSignal: (signal: WebRtcSignal) => void): () => void {
    const source = ref(this.database, `signaling/${this.route.huddleId}/${this.route.localDeviceId}`);
    return onChildAdded(source, (snapshot) => {
      const raw: unknown = snapshot.val();
      const parsed = parseIncoming(raw, this.route.connectionId);
      void remove(snapshot.ref);
      if (parsed !== undefined) onSignal(parsed);
    });
  }
}

export class FirebaseWebSignalingError extends Error {
  public constructor(public readonly code: "SIGNAL_ROUTE_INVALID" | "SIGNAL_INVALID") { super(code); }
}

function parseIncoming(value: unknown, connectionId: string): WebRtcSignal | undefined {
  if (!isRecord(value) || value.connectionId !== connectionId || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs)) return undefined;
  const expiresAtMs = value.expiresAtMs;
  if (expiresAtMs <= Date.now() || !isRecord(value.signal)) return undefined;
  const signal = value.signal;
  if ((signal.kind === "offer" || signal.kind === "answer") && isRecord(signal.sdp) && typeof signal.sdp.type === "string" && typeof signal.sdp.sdp === "string") {
    return { kind: signal.kind, sdp: { type: signal.sdp.type as RTCSdpType, sdp: signal.sdp.sdp } };
  }
  if (signal.kind === "candidate" && isRecord(signal.candidate) && typeof signal.candidate.candidate === "string") {
    return { kind: "candidate", candidate: { candidate: signal.candidate.candidate, sdpMid: typeof signal.candidate.sdpMid === "string" ? signal.candidate.sdpMid : null, sdpMLineIndex: typeof signal.candidate.sdpMLineIndex === "number" ? signal.candidate.sdpMLineIndex : null } };
  }
  return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
