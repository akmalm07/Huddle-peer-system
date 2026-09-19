**# Huddle architecture — Firebase control plane**

**\*\*Status:\*\*** architecture direction for the prototype. It is not a production-security claim and does not authorize cryptography, device authorization, revocation, or epoch implementation without the human review required by \`AGENTS.md\`.

**## Product and safety gates**

Huddle is a local-first TypeScript chat application. The first implementation target is the browser client and installable PWA. Desktop and mobile remain typed platform interfaces until their secure storage and lifecycle contracts are separately reviewed.

This milestone permits a direct WebRTC full mesh of at most **\*\*eight active devices per huddle\*\***. A ninth device must receive \`DIRECT\_MESH\_CAPACITY\_EXCEEDED\`. Forwarding topology, peer store, encrypted backup, desktop, and mobile remain default-off and unimplemented. Offline delivery may use a Firebase-backed encrypted pending-message queue as described below.

The prototype uses the owner-approved static Web Crypto adapter documented in \`docs/ADR-001-E2EE-LIBRARY-EVALUATION.md\`: P-256 ECDH, HKDF-SHA-256, and AES-256-GCM. It has no forward secrecy and is not a production-security claim. Message content may use this adapter only after device-directory authorization, revocation, membership, epoch, and associated-data checks pass; plaintext and fake-encryption fallbacks remain prohibited.

**## Trust boundaries**

\`\`\`mermaid

flowchart LR

  W[Browser / PWA] --> A[TypeScript Auth and Authorization API]

  W --> F[Firebase control plane]

  A --> F

  F --> FS[Cloud Firestore: durable non-message metadata]

  F --> RT[Realtime Database: expiring coordination and signaling]

  W <-->|authorized SDP / ICE| RT

  W <-->|preferred WebRTC data channel| P[Authorized peer device]

  W --> T[STUN / TURN: TURN is not Firebase]

\`\`\`

\| Boundary | May hold or observe | Must never hold or log |

\| --- | --- | --- |

\| Browser/PWA | Its own private device material, authorized plaintext while composing/rendering locally, bounded local state | Other devices' private keys; local database wrapping keys, access tokens, or refresh tokens in \`localStorage\` |

\| TypeScript API | WebAuthn/passkey challenge state, public metadata, server environment credentials | Message plaintext, device private keys, recovery codes, raw SDP/ICE |

\| Firebase Auth | Account identity and short-lived Firebase session identity after the auth decision | Huddle private/content keys and recovery codes |

\| Firestore | Durable public/authorization metadata and redacted security events | Messages, attachments, plaintext, ciphertext envelopes, content keys, device private keys, browser database keys |

\| RTDB | Expiring presence, enrollment coordination, authorized SDP/ICE, connection hints, ephemeral ACK metadata | Message bodies, attachments, keys, raw SDP/ICE logs, permanent coordination history |

\| TURN | Network metadata and WebRTC ciphertext | Application plaintext or content-decryption keys |

Firebase Security Rules are defense in depth. Client-SDK calls are evaluated by Rules, but privileged Admin SDK calls bypass Rules. The TypeScript API must still verify Firebase identity, device status, huddle role, manifest version, signed authorization, bounds, rate limits, and audit obligations at every sensitive transition.

**## Browser, PWA, and IndexedDB**

\`apps/web\` becomes the real React chat surface: account/login, device list, enrollment approval, safety-number/QR comparison, device revocation, huddle list/create/invitation/member management, chat, connection state, delivery state, and security-event state. The connection indicator distinguishes direct, TURN/privacy relay, unavailable, and capacity-rejected paths without exposing addresses, SDP, or ICE.

The PWA requests persistent storage and explains private browsing, quota failure, browser/site-data clearing, eviction, service-worker upgrade, and storage loss. It must enter an explicit recoverable state rather than silently recreating a device or suggesting historical recovery.

IndexedDB is available only behind a typed encrypted-repository abstraction. Its separate stores are messages, outbox, delivery/deduplication, manifest cache, public device-directory cache, attachment metadata, security-event view state, and protocol/session state. Every record is runtime-validated and bounded. Sensitive records should use the shared storage/crypto adapter; no private key, wrapping key, access token, refresh token, or plaintext chat message is written to \`localStorage\`.

Message rows may be enabled once the prototype crypto adapter is implemented. At minimum, test encryption/decryption, reload, offline/reconnect, and basic storage failure; the broader browser lifecycle matrix is recommended rather than a release blocker.

**## Authentication, device directory, and safety verification**

The TypeScript auth service remains the authoritative WebAuthn/passkey and step-up boundary until a capability spike proves a chosen Firebase Auth configuration satisfies the required passkey, origin, RP ID, challenge, logout, revocation, and emulator-test requirements. Do not assume Firebase Auth alone supplies this design.

The planned path is reviewed WebAuthn with the TypeScript service, then a short-lived Firebase custom token for the immutable account ID after authorization, then Firebase SDK in-memory persistence only. Tokens are never logged or deliberately persisted. Firebase Rules use the UID for coarse access control; sensitive mutations pass through the API/Cloud Run authorization boundary.

The authenticated account/device registry is the prototype public-key directory. Clients pin remote identity, surface safety number and QR comparison, and fail closed on an unapproved change. This detects changes after an out-of-band comparison but does not protect first contact or a malicious registry consistently substituting keys. Key transparency is a future milestone. Device key generation, enrollment approval, revocation, and QR contents may be implemented as part of the prototype; private keys never cross a browser, Firebase, API, or QR boundary.

**## Firebase data contracts**

**### Cloud Firestore: durable non-message metadata**

\| Collection | Permitted data |

\| --- | --- |

\| \`accounts/{accountId}\` | Immutable ID, normalized/display username policy data, account status, created time; no authentication secret |

\| \`devices/{deviceId}\` | Account ID, public identity/key material, creation/revocation time, public status/version |

\| \`huddles/{huddleId}\` | Owner, active manifest reference/version/epoch, bounded public policy metadata |

\| \`huddles/{huddleId}/manifests/{version}\` | Exact canonical signed manifest bytes/reference, signer public identity reference, version/epoch/expiry |

\| \`huddles/{huddleId}/members/{accountId}\` | Derived role/status for queries; API verifies against the manifest |

\| \`invitations/{invitationId}\` | Target account/device references, expiry/use status, signed canonical invitation/reference |

\| \`securityEvents/{eventId}\` | Pseudonymous account/device references, bounded category/time/public metadata |

\| \`configuration/{version}\` | Non-secret protocol, feature, and configuration-version records |

Firestore never stores message or attachment bodies, encrypted message envelopes, content keys, private keys, browser database keys, recovery codes, or raw SDP/ICE logs.

**### Realtime Database: expiring coordination**

\- \`presence/{accountId}/{deviceId}\` is a liveness hint only.

\- \`signaling/{huddleId}/{recipientDeviceId}/{signalId}\` holds authorized, bounded offer/answer/candidate payloads and connection state with short TTL.

\- \`enrollment/{challengeId}\` holds account-, new-device-key-digest-, expiry-, and single-use-bound approval coordination.

\- \`acks/{recipientDeviceId}/{messageId}\` may hold test-event ACKs only until a reviewed provider authorizes authenticated content envelopes.

Coordination paths such as presence and signaling remain expiring and bounded. RTDB is neither TURN nor a plaintext message relay. For offline delivery, the project may store only end-to-end encrypted, recipient-device-targeted message envelopes in a Firebase pending-message queue. Pending ciphertext is not subject to a five-minute TTL: it remains available while the recipient is offline and is deleted from the server after the intended recipient device successfully decrypts/accepts the message and sends an authenticated ACK. ACK/deletion operations should be idempotent, and clients deduplicate by authenticated message ID. Apply reasonable payload, per-account/device, and queue-size limits so an offline account cannot create unbounded server storage.

Rules default-deny. Firestore Rules constrain account/huddle access and field shapes; RTDB Rules constrain owner, recipient, membership, expiry, sizes, and offer/candidate counts. Both deny cross-account, cross-huddle, revoked/stale-device, arbitrary-path, malformed, and expired access. Rules do not validate signatures or serialize security transitions: the API repeats all sensitive authorization and records only redacted security events.

**## Signaling, WebRTC, and future delivery**

RTDB carries authorized short-lived SDP offers, answers, ICE candidates, and connection hints. It is not proof that a device key is valid. Before content is accepted, peers verify device/account authorization, revocation, huddle membership, manifest version/epoch, and approved future E2EE handshake binding. SDP/ICE never enters logs, telemetry, errors, snapshots, or reports.

Direct WebRTC data channels are preferred. STUN is discovery; TURN is NAT/firewall fallback and forced privacy relay. TURN credentials are short-lived and quota-controlled. The WebRTC adapter carries bounded application frames; content frames must be encrypted by the documented prototype adapter before sending and are never logged.

After approval, the intended flow is account login; independent-device enrollment through existing-device approval; owner-created canonical signed manifest; expiring invitation and owner approval; epoch advance; Firebase peer discovery; WebRTC; provider-authenticated envelope; ACK/retry/dedupe; local outbox; and revocation/removal blocking future signaling/messages. Removal advances epoch but never claims erasure of data already received.

Signed/authenticated structures should use one consistent versioned encoding (deterministic CBOR is preferred but not mandatory for the first prototype). Ciphertext should bind important routing/context fields as associated data. Huddle does not need to reconstruct Signal, X3DH, or Double Ratchet; a simpler static device-key design is acceptable. Nonce generation must still follow the selected standard algorithm/library rather than an ad-hoc construction.

**## Limits, observability, and test gates**

Initial limits are eight active mesh devices, 64 KiB transport frame, 16 KiB application payload, four pending negotiations per device, 64 ICE candidates per negotiation, 100 outbox entries per recipient, and eight retries. Firebase coordination paths receive matching document/value, TTL where appropriate, per-account/device, count, and rate limits before deployment. Pending encrypted messages are ACK-retained rather than five-minute-TTL-retained: they remain until authenticated recipient ACK and are then deleted. Queue-size and payload limits still apply.

Telemetry allowlists only event name, pseudonymous ID, duration, stable status/error code, and bounded counts. It excludes usernames, raw IPs, tokens, key bytes, plaintext, ciphertext, SDP, ICE, and request bodies. Retention and cleanup are monitored.

Firebase Local Emulator Suite is strongly preferred for local integration and CI. Use a demo project ID so tests cannot reach production. Run Firestore, RTDB, Authentication where used, and Rules with the same project ID. Gates include Rules denial tests; emulator account/device/invitation/manifest/revocation/presence/signaling tests; IndexedDB/PWA lifecycle failures; two-browser Firebase-signaled WebRTC with reconnect/restart/reorder/capacity and available TURN-only paths; CBOR/schema/state-machine fuzzing; and redaction scans. Core E2EE round-trip, tamper, wrong-key, and persistence tests are part of the normal prototype test suite.

**## Firebase setup**

Firebase is the control plane for the application. There is no Postgres or Redis dependency.

1. Configure the Firebase project and Firebase Emulator Suite for local development and testing.

2. Use Cloud Firestore for durable application metadata such as accounts, devices, huddles, membership, invitations, and device public-key information.

3. Use Firebase Realtime Database for presence, WebRTC signaling, and other short-lived coordination data.

4. Use Firebase for encrypted offline message storage. When a recipient device is unavailable through WebRTC, the encrypted device-targeted message may be stored in Firebase until that device retrieves it and sends a valid acknowledgment. After acknowledgment, delete the server copy.

5. Firebase must never receive message plaintext, device private keys, content-decryption keys, recovery secrets, or other private cryptographic material.

6. Provide Firebase Security Rules for Firestore and Realtime Database and test the important authorization rules with the Firebase Emulator Suite.

7. Keep Firebase configuration and adapters separated from application logic so local tests can use lightweight fake adapters where useful.

8. Production Firebase credentials and administrative secrets must not be committed to the repository.

**## Residual risks**

Firebase observes control-plane metadata. Direct peers can see each other’s IP address unless TURN is forced. This does not protect against compromised endpoints, extensions, XSS, traffic analysis, denial of service, first-contact malicious directories, or history already received by removed members. Passing tests is necessary but never proof of cryptographic security or production readiness.
