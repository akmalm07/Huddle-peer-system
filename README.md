# Huddle

Huddle is a portfolio-oriented TypeScript foundation for reusable, local-first
peer-to-peer messaging. It is a messaging system/API for applications to build
on—not a finished consumer messenger or a production-security claim.

## Architecture

```text
Browser/PWA ── Firebase RTDB ── authorized SDP/ICE discovery
     │                                      │
     └──────── WebRTC data channel ─────────┘
                 direct or TURN fallback

Cloud Run authorization API ── Firestore metadata, device directory,
membership, revocation, queue authorization, and TURN credential issuance
```

The browser owns its device private key and encrypts content before it enters a
WebRTC frame. Firebase holds only control-plane metadata and expiring signaling;
it must never receive plaintext or private keys. TURN is a network fallback,
not a Firebase service and not proof that delivery is direct P2P.

The prototype crypto adapter uses static P-256 ECDH, HKDF-SHA-256, and
AES-256-GCM. It has no forward secrecy and must not be described as
production-ready. See [the crypto ADR](docs/ADR-001-E2EE-LIBRARY-EVALUATION.md).

## Repository map

- `apps/web` — installable React/PWA reference surface.
- `apps/demo-headless` — deterministic local control-plane demonstration.
- `apps/auth` — deployable HTTP authorization boundary.
- `apps/signaling` — containerized signaling boundary.
- `packages/sdk` and `packages/runtime-api` — device/huddle policy and
  server-side authorization, queue, and ACK behavior.
- `packages/webrtc` and `packages/firebase-web` — browser peer connection and
  Firebase RTDB signaling integration.
- `packages/crypto`, `protocol`, `config`, `platform-storage`, and
  `observability` — shared security-sensitive primitives and contracts.

## Run locally

Requirements: Node.js 22.12+ and npm 11+.

```powershell
npm install
npm run build
npm test
npm run demo:headless
```

The headless demo creates authorized devices/huddles and sends a bounded
non-content coordination event. The three-peer runtime integration test runs as
part of `npm test`.

## Configure peer networking

Copy `.env.example` to `.env`. Set public STUN/TURN endpoints with:

```powershell
$env:HUDDLE_ICE_SERVERS='[{"urls":["stun:stun.example.test:3478"]},{"urls":["turns:turn.example.test:5349"]}]'
```

Do not store static TURN passwords in this repository or browser environment.
The authorization API must issue short-lived TURN credentials after device
authorization.

## Docker

After starting Docker Desktop:

```powershell
docker compose up --build signaling
```

This exposes the signaling/API boundary on port 4002. It is not a message relay.

## Firebase deployment boundary

To run actual browser-to-browser Firebase signaling, provide a demo Firebase
project, configure the committed `firebase.json`/Rules, and implement the
Cloud Run token-verifier and Firebase Admin persistence adapters. No Firebase
project credentials are committed here. See [the WebRTC guide](docs/WEBRTC_PROTOTYPE.md).

## Verification

```powershell
npm run build
npm run typecheck
npm run lint
npm test
```
