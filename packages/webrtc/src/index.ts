import { TRANSPORT_LIMITS } from "@huddle/protocol";

export type WebRtcSignal =
  | { readonly kind: "offer" | "answer"; readonly sdp: RTCSessionDescriptionInit }
  | { readonly kind: "candidate"; readonly candidate: RTCIceCandidateInit };

/** Implement with the authorized, expiring Firebase RTDB signaling adapter. Never log payloads. */
export interface WebRtcSignaler { publish(signal: WebRtcSignal): Promise<void>; }
export interface WebRtcPeerOptions {
  readonly iceServers: readonly RTCIceServer[];
  readonly signaler: WebRtcSignaler;
  readonly onData: (bytes: Uint8Array) => void;
  readonly onStateChange?: (state: RTCPeerConnectionState) => void;
}

/** Real browser RTCPeerConnection negotiation for bounded encrypted application frames. */
export class WebRtcPeer {
  private readonly connection: RTCPeerConnection;
  private channel: RTCDataChannel | undefined;
  public constructor(private readonly options: WebRtcPeerOptions) {
    this.connection = new RTCPeerConnection({ iceServers: [...options.iceServers] });
    this.connection.onicecandidate = (event) => { if (event.candidate !== null) void options.signaler.publish({ kind: "candidate", candidate: event.candidate.toJSON() }); };
    this.connection.onconnectionstatechange = () => options.onStateChange?.(this.connection.connectionState);
    this.connection.ondatachannel = (event) => this.bindChannel(event.channel);
  }
  public async offer(): Promise<void> {
    this.bindChannel(this.connection.createDataChannel("huddle-v1", { ordered: true }));
    await this.connection.setLocalDescription(await this.connection.createOffer());
    if (this.connection.localDescription === null) throw new WebRtcPeerError("NEGOTIATION_FAILED");
    await this.options.signaler.publish({ kind: "offer", sdp: this.connection.localDescription.toJSON() });
  }
  public async receive(signal: WebRtcSignal): Promise<void> {
    if (signal.kind === "candidate") { await this.connection.addIceCandidate(signal.candidate); return; }
    await this.connection.setRemoteDescription(signal.sdp);
    if (signal.kind === "offer") {
      await this.connection.setLocalDescription(await this.connection.createAnswer());
      if (this.connection.localDescription === null) throw new WebRtcPeerError("NEGOTIATION_FAILED");
      await this.options.signaler.publish({ kind: "answer", sdp: this.connection.localDescription.toJSON() });
    }
  }
  public send(frame: Uint8Array): void {
    if (frame.byteLength > TRANSPORT_LIMITS.maximumFrameBytes || this.channel?.readyState !== "open") throw new WebRtcPeerError("CHANNEL_UNAVAILABLE");
    const copy = frame.slice();
    this.channel.send(copy.buffer as ArrayBuffer);
  }
  public close(): void { this.channel?.close(); this.connection.close(); }
  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > TRANSPORT_LIMITS.maximumFrameBytes) { this.close(); return; }
      this.options.onData(new Uint8Array(event.data));
    };
  }
}
export class WebRtcPeerError extends Error { public constructor(public readonly code: "NEGOTIATION_FAILED" | "CHANNEL_UNAVAILABLE") { super(code); } }
