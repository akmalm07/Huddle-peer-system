import { decode, encode, rfc8949EncodeOptions } from "cborg";
import type { ZodType } from "zod";

/** The deliberately small CBOR data model accepted by Huddle protocol schemas. */
export type CanonicalCborScalar =
  | null
  | boolean
  | number
  | string
  | Uint8Array;

export interface CanonicalCborMap {
  readonly [key: string]: CanonicalCborValue;
}

export interface CanonicalCborArray extends ReadonlyArray<CanonicalCborValue> {}

export type CanonicalCborValue = CanonicalCborScalar | CanonicalCborArray | CanonicalCborMap;

export const MAX_CANONICAL_CBOR_BYTES = 65_536;
const MAX_CBOR_DEPTH = 16;
const MAX_CBOR_MAP_ENTRIES = 32;
const MAX_CBOR_ARRAY_ENTRIES = 64;
const ASCII_MAP_KEY = /^[\x20-\x7e]+$/;

export class CanonicalCborError extends Error {
  public constructor(public readonly code: "CBOR_INVALID" | "CBOR_NON_CANONICAL" | "CBOR_SCHEMA_INVALID" | "CBOR_TOO_LARGE") {
    super(code);
    this.name = "CanonicalCborError";
  }
}

/**
 * Encodes the limited Huddle CBOR profile using RFC 8949 core deterministic map
 * ordering. This function is an encoding boundary, not a signing operation.
 */
export function encodeCanonicalCbor(value: CanonicalCborValue): Uint8Array {
  assertCanonicalValue(value, 0);
  let encoded: Uint8Array;
  try {
    encoded = encode(value, rfc8949EncodeOptions);
  } catch {
    throw new CanonicalCborError("CBOR_INVALID");
  }
  if (encoded.byteLength > MAX_CANONICAL_CBOR_BYTES) {
    throw new CanonicalCborError("CBOR_TOO_LARGE");
  }
  return encoded;
}

/**
 * Rejects alternate CBOR representations by decoding strictly, validating the
 * restricted data model, and requiring byte-for-byte deterministic re-encoding.
 */
export function decodeCanonicalCbor(bytes: Uint8Array): CanonicalCborValue {
  if (bytes.byteLength === 0) {
    throw new CanonicalCborError("CBOR_INVALID");
  }
  if (bytes.byteLength > MAX_CANONICAL_CBOR_BYTES) {
    throw new CanonicalCborError("CBOR_TOO_LARGE");
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes, {
      allowBigInt: false,
      allowIndefinite: false,
      allowInfinity: false,
      allowNaN: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
      useMaps: false,
    });
  } catch {
    throw new CanonicalCborError("CBOR_INVALID");
  }

  assertCanonicalValue(decoded, 0);
  const canonical = encodeCanonicalCbor(decoded);
  if (!equalBytes(bytes, canonical)) {
    throw new CanonicalCborError("CBOR_NON_CANONICAL");
  }
  return decoded;
}

/** Use at protocol boundaries after canonical decoding; never parse untrusted CBOR directly. */
export function decodeCanonicalCborWithSchema<T>(bytes: Uint8Array, schema: ZodType<T>): T {
  const value = decodeCanonicalCbor(bytes);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CanonicalCborError("CBOR_SCHEMA_INVALID");
  }
  return parsed.data;
}

function assertCanonicalValue(value: unknown, depth: number): asserts value is CanonicalCborValue {
  if (depth > MAX_CBOR_DEPTH) {
    throw new CanonicalCborError("CBOR_INVALID");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalCborError("CBOR_INVALID");
    }
    return;
  }
  if (value instanceof Uint8Array) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CBOR_ARRAY_ENTRIES) {
      throw new CanonicalCborError("CBOR_INVALID");
    }
    for (const item of value) {
      assertCanonicalValue(item, depth + 1);
    }
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > MAX_CBOR_MAP_ENTRIES) {
      throw new CanonicalCborError("CBOR_INVALID");
    }
    for (const [key, item] of entries) {
      if (!ASCII_MAP_KEY.test(key)) {
        throw new CanonicalCborError("CBOR_INVALID");
      }
      assertCanonicalValue(item, depth + 1);
    }
    return;
  }
  throw new CanonicalCborError("CBOR_INVALID");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
