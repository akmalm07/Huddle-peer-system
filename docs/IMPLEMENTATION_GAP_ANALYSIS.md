# Implementation gap analysis

This repository was inspected against `ARCHITECTURE.md` before implementation.
The result below distinguishes an implemented prototype boundary from a
production claim.

| Area | Starting point | Current implementation | Remaining gate |
| --- | --- | --- | --- |
| Protocol limits/encoding | bounded frames, CBOR, structural envelope | retained with tests | authenticated provider envelope |
| Accounts/devices/huddles | absent | reusable SDK reference implementation with independent devices, revocation, roles, and epochs | WebAuthn/API persistence adapter |
| WebRTC coordination | health endpoint only | bounded signaling state plus browser `RTCPeerConnection` negotiation adapter | Firebase runtime wiring and emulator run |
| Firebase | absent | emulator configuration, default-deny Rules, and a typed Firebase mapping adapter | deployment configuration and Admin/API identity adapter |
| Offline messages | absent | runtime-owned bounded ciphertext queue with idempotent ACK deletion | Firebase-backed persistence and browser wiring |
| Browser/PWA | static foundation page | reference status surface and PWA shell | authenticated demo flow after auth gate |
| Crypto | fail-closed seam | static Web Crypto prototype adapter with tamper test | browser key persistence and production review |

## Removed obsolete architecture

The Postgres/Redis Compose stack and its environment variables were removed.
Firebase is the sole control plane; no database or cache server is required for
local development. Generated artifacts are ignored and are not source code.

## Verification note

`npm run build`, `npm test`, `npm run typecheck`, and `npm run lint` pass. The
Firebase CLI was not installed in the execution environment, so emulator Rules
tests are configured but were not executed. Run `firebase emulators:start
--project huddle-demo` with the demo project before enabling an integration
deployment.

## Trust boundary addressed

The SDK changes keep device authorization, revocation, membership, huddle epoch,
direct-mesh capacity, and signaling TTL/size checks inside one reusable control
plane boundary. Untrusted signals are validated before queueing. No SDP/ICE,
keys, or message content is logged. The remaining threat is a server or
directory substituting an unaudited key; safety verification and the future
reviewed E2EE handshake address that only after the ADR is approved.
