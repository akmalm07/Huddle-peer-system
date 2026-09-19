# ADR-001: E2EE provider evaluation

**Status: prototype approved by repository owner on 2026-09-19; production review required.**

The prior fail-closed gate has been replaced for this prototype by a focused,
owner-authorized Web Crypto implementation. It is not a production-security
claim.

The shipped prototype uses non-exportable P-256 ECDH private keys, an exported
raw P-256 public directory key, HKDF-SHA-256, and AES-256-GCM with a new random
96-bit IV per encryption and a 128-bit tag. The supplied canonical envelope
header is authenticated as associated data. Decryption fails closed on an
invalid tag. Tests cover round-trip and tamper rejection.

This is static device ECDH: it **does not provide forward secrecy**, does not
solve key transparency/first contact, and must not be marketed as Signal-like.
The device directory, membership/epoch, revocation, and safety-number checks
remain mandatory before session establishment. A production review must replace
or upgrade this adapter with a reviewed forward-secure protocol.

This is a safety gate, not a claim that the current code provides E2EE.
