import assert from "node:assert/strict";
import test from "node:test";
import { TRANSPORT_LIMITS } from "./limits.js";
import { ProtocolEnvelopeError, parseUnauthenticatedEnvelope } from "./envelope.js";

const envelope = {
  authentication: Uint8Array.of(1),
  createdAtMs: 100,
  epoch: 1,
  expiresAtMs: 200,
  huddleId: "huddle_1",
  messageId: "message_1",
  messageType: "application" as const,
  payload: Uint8Array.of(1, 2),
  protocolVersion: 1 as const,
  recipientAccountId: "account_b",
  recipientDeviceId: "device_b",
  senderAccountId: "account_a",
  senderDeviceId: "device_a",
};

test("accepts a bounded structural envelope but does not authenticate it", () => {
  assert.equal(parseUnauthenticatedEnvelope(envelope).messageId, "message_1");
});

test("rejects stale, malformed, oversized, and unknown envelope fields", () => {
  assert.throws(() => parseUnauthenticatedEnvelope({ ...envelope, expiresAtMs: 100 }), isEnvelopeError);
  assert.throws(() => parseUnauthenticatedEnvelope({ ...envelope, payload: new Uint8Array(TRANSPORT_LIMITS.maximumApplicationPayloadBytes + 1) }), isEnvelopeError);
  assert.throws(() => parseUnauthenticatedEnvelope({ ...envelope, protocolVersion: 2 }), isEnvelopeError);
  assert.throws(() => parseUnauthenticatedEnvelope({ ...envelope, unexpected: true }), isEnvelopeError);
});

function isEnvelopeError(error: unknown): boolean {
  return error instanceof ProtocolEnvelopeError && error.code === "ENVELOPE_INVALID";
}
