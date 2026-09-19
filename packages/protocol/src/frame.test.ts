import assert from "node:assert/strict";
import test from "node:test";
import { BINARY_FRAME_VERSION, FrameError, decodeBoundedFrame, encodeBoundedFrame } from "./frame.js";
import { TRANSPORT_LIMITS } from "./limits.js";

test("a bounded frame round-trips without changing its bytes", () => {
  const payload = Uint8Array.of(1, 2, 3, 255);
  assert.deepEqual(decodeBoundedFrame(encodeBoundedFrame(payload)), payload);
});

test("a truncated or length-mismatched frame is rejected before payload use", () => {
  assert.throws(() => decodeBoundedFrame(Uint8Array.of(BINARY_FRAME_VERSION)), isFrameError("FRAME_TRUNCATED"));

  const frame = encodeBoundedFrame(Uint8Array.of(1));
  frame[4] = 2;
  assert.throws(() => decodeBoundedFrame(frame), isFrameError("FRAME_TRUNCATED"));
});

test("an unsupported version and oversized declared payload are rejected", () => {
  const unsupported = encodeBoundedFrame(Uint8Array.of(1));
  unsupported[0] = BINARY_FRAME_VERSION + 1;
  assert.throws(() => decodeBoundedFrame(unsupported), isFrameError("FRAME_VERSION_UNSUPPORTED"));

  const oversized = new Uint8Array(5);
  oversized[0] = BINARY_FRAME_VERSION;
  new DataView(oversized.buffer).setUint32(1, TRANSPORT_LIMITS.maximumFrameBytes + 1, false);
  assert.throws(() => decodeBoundedFrame(oversized), isFrameError("FRAME_TOO_LARGE"));
});

function isFrameError(expectedCode: FrameError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof FrameError && error.code === expectedCode;
}
