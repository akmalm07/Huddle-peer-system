/**
 * Platform-neutral connection contract. Implementations must run validated,
 * authenticated protocol envelopes above this byte transport.
 */
export interface BoundedByteTransport {
  readonly maximumFrameBytes: number;
  send(frame: Uint8Array): Promise<void>;
  close(reason: "idle" | "protocol-error" | "local-request"): Promise<void>;
}
