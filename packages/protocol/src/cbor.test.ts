import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCborError, decodeCanonicalCbor, encodeCanonicalCbor } from "./cbor.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

test("encodes public RFC 8949 core deterministic map-order vector", () => {
  // Core deterministic ordering compares the encoded keys bytewise: "z" before "aa".
  const bytes = encodeCanonicalCbor({ aa: 2, z: 1 });
  assert.equal(hex(bytes), "a2617a0162616102");
  assert.deepEqual(decodeCanonicalCbor(bytes), { z: 1, aa: 2 });
});

test("rejects trailing data and non-preferred integer encodings", () => {
  assert.throws(() => decodeCanonicalCbor(Uint8Array.from([0x01, 0x02])), isInvalid);
  assert.throws(() => decodeCanonicalCbor(Uint8Array.from([0x18, 0x01])), isInvalid);
});

test("rejects indefinite values, duplicate map keys, and unsupported value types", () => {
  assert.throws(() => decodeCanonicalCbor(Uint8Array.from([0x9f, 0x01, 0xff])), isInvalid);
  assert.throws(() => decodeCanonicalCbor(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x01])), isInvalid);
  assert.throws(() => encodeCanonicalCbor({ key: Number.NaN }), isInvalid);
  assert.throws(() => encodeCanonicalCbor({ "not-ascii-λ": 1 }), isInvalid);
});

function isInvalid(error: unknown): boolean {
  return error instanceof CanonicalCborError && error.code === "CBOR_INVALID";
}
