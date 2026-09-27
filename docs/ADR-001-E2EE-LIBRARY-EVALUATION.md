# ADR-001: prototype browser E2EE adapter

## Decision

The browser prototype uses the platform Web Crypto API with P-256 ECDH,
HKDF-SHA-256, and AES-256-GCM. It uses no custom cryptographic primitive and
does not rely on WebRTC transport encryption as the application-content
security boundary.

Each browser generates a non-exportable P-256 private device key. The public
key is registered through the authenticated authorization API and may be read
only as a device-directory value. For each active pair, the client derives a
256-bit AES-GCM session key from ECDH using a canonical CBOR context containing
the protocol version, huddle ID, epoch, and sorted participant account/device
identifiers. The context prevents two device pairs from reusing a derived key
for the same huddle context.

Every encrypted message receives a random 96-bit AES-GCM IV from Web Crypto.
Its associated data is deterministic CBOR containing the protocol version,
message ID, sender and recipient account/device IDs, huddle ID, epoch, and
creation/expiry instants. The ciphertext is framed as bounded binary WebRTC
data. The receiver validates frame, expiry, routing, and epoch before
decrypting, and closes the channel on malformed or unauthenticated input.

## Consequences and limitations

This is static-device ECDH: it has **no forward secrecy** and does not provide
Signal/Double-Ratchet-style post-compromise recovery. Browser storage loss loses
the device private key. The device key is persisted only as a non-exportable
`CryptoKey` in IndexedDB; it is never sent to Firebase, the authorization API,
TURN, logs, URLs, or QR/invitation data.

Passkeys authenticate access to the authorization API. They do not replace the
device encryption key and never derive it. This slice permits the first device
only; it rejects automatic second-device enrollment rather than silently
weakening Device-only mode. Device enrollment approval, revocation,
multi-device approval, safety-number comparison, and recovery flows need a
separate human security review before production use.

## Verification

The crypto package tests successful cross-device encryption and rejects altered
ciphertext and associated data. The protocol package tests bounded encrypted
frame parsing, expiry rejection, and routing-field binding. A browser
two-computer test remains required after deployment because STUN/TURN and NAT
behavior cannot be validated by unit tests.
