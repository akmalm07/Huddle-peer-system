import { TRANSPORT_LIMITS } from "./limits.js";

export const BINARY_FRAME_VERSION = 1;
const HEADER_BYTES = 5;

export type FrameErrorCode = "FRAME_TOO_LARGE" | "FRAME_TRUNCATED" | "FRAME_VERSION_UNSUPPORTED";

export class FrameError extends Error {
  public constructor(public readonly code: FrameErrorCode) {
    super(code);
    this.name = "FrameError";
  }
}

/**
 * A bounded transport envelope: one version byte followed by a big-endian
 * payload length and opaque bytes. It is not a signed protocol message and is
 * intentionally unsuitable for identity, signaling, or application data until
 * the reviewed protocol schema and canonical signing format are selected.
 */
export function encodeBoundedFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > TRANSPORT_LIMITS.maximumFrameBytes) {
    throw new FrameError("FRAME_TOO_LARGE");
  }

  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = BINARY_FRAME_VERSION;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, payload.byteLength, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export function decodeBoundedFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < HEADER_BYTES) {
    throw new FrameError("FRAME_TRUNCATED");
  }
  if (frame[0] !== BINARY_FRAME_VERSION) {
    throw new FrameError("FRAME_VERSION_UNSUPPORTED");
  }

  const declaredLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
  if (declaredLength > TRANSPORT_LIMITS.maximumFrameBytes) {
    throw new FrameError("FRAME_TOO_LARGE");
  }
  if (declaredLength !== frame.byteLength - HEADER_BYTES) {
    throw new FrameError("FRAME_TRUNCATED");
  }
  return frame.slice(HEADER_BYTES);
}
