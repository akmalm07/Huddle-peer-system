export const CRYPTO_IMPLEMENTATION_STATUS = "prototype-static-webcrypto" as const;

/**
 * A deliberately non-functional seam for a future reviewed, forward-secure
 * device-session implementation. No default or test implementation performs
 * encryption, signing, key generation, or session establishment.
 */
export interface E2eeProvider {
  initializeSession(request: SessionInitializationRequest): Promise<EstablishedE2eeSession>;
}

export interface SessionInitializationRequest {
  readonly huddleId: string;
  readonly localDeviceId: string;
  readonly remoteDeviceId: string;
  /** Opaque public directory record, validated by the future registry boundary. */
  readonly remoteIdentityPublicKey: Uint8Array;
  /** A future provider must bind its authenticated transcript to this exact data. */
  readonly authenticatedContext: Uint8Array;
}

export interface EstablishedE2eeSession {
  readonly state: "established";
  encrypt(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
}

export class E2eeAuthenticationError extends Error {
  public constructor() {
    super("E2EE_AUTHENTICATION_FAILED");
    this.name = "E2eeAuthenticationError";
  }
}

const AES_GCM_IV_BYTES = 12;
const ECDH_CONTEXT = new TextEncoder().encode("huddle-static-device-e2ee-v1");

/** Browser-resident static ECDH identity. Its private key must never leave the device. */
export interface StaticDeviceIdentity {
  readonly privateKey: webcrypto.CryptoKey;
  readonly publicKey: Uint8Array;
}

export interface StaticE2eeProviderOptions {
  readonly crypto: webcrypto.Crypto;
  readonly localIdentity: StaticDeviceIdentity;
}

/**
 * Prototype-only E2EE adapter. It uses Web Crypto P-256 ECDH and HKDF-SHA-256
 * to derive an AES-256-GCM key for each remote device/context. Every payload
 * has a random 96-bit IV and caller-supplied associated data. This has no
 * forward secrecy and requires a pinned, authorized device directory.
 */
export class StaticWebCryptoE2eeProvider implements E2eeProvider {
  public constructor(private readonly options: StaticE2eeProviderOptions) {}

  public async initializeSession(request: SessionInitializationRequest): Promise<EstablishedE2eeSession> {
    const remote = await this.options.crypto.subtle.importKey("raw", request.remoteIdentityPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const sharedSecret = await this.options.crypto.subtle.deriveBits({ name: "ECDH", public: remote }, this.options.localIdentity.privateKey, 256);
    const context = await this.options.crypto.subtle.digest("SHA-256", concat(ECDH_CONTEXT, request.authenticatedContext));
    const keyMaterial = await this.options.crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    const key = await this.options.crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: context, info: ECDH_CONTEXT },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return {
      state: "established",
      encrypt: async (plaintext, associatedData) => {
        const iv = this.options.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
        const ciphertext = await this.options.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData, tagLength: 128 }, key, plaintext);
        return concat(iv, new Uint8Array(ciphertext));
      },
      decrypt: async (sealed, associatedData) => {
        if (sealed.byteLength <= AES_GCM_IV_BYTES + 16) throw new E2eeAuthenticationError();
        const iv = sealed.slice(0, AES_GCM_IV_BYTES);
        try {
          const plaintext = await this.options.crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData, tagLength: 128 }, key, sealed.slice(AES_GCM_IV_BYTES));
          return new Uint8Array(plaintext);
        } catch {
          throw new E2eeAuthenticationError();
        }
      },
    };
  }
}

/** Generates a non-exportable browser/device private key and exportable public directory key. */
export async function generateStaticDeviceIdentity(cryptoApi: webcrypto.Crypto): Promise<StaticDeviceIdentity> {
  const pair = await cryptoApi.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  if (!("publicKey" in pair) || !("privateKey" in pair)) throw new Error("E2EE_KEY_GENERATION_FAILED");
  const publicKey = new Uint8Array(await cryptoApi.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await cryptoApi.subtle.importKey("pkcs8", await cryptoApi.subtle.exportKey("pkcs8", pair.privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return Object.freeze({ privateKey, publicKey });
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
import type { webcrypto } from "node:crypto";
