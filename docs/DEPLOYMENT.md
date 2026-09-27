# Deploying Huddle with GitHub Actions and Cloud Run

This repository follows the same CI/CD shape as the referenced
`nodistractions.online` workflow: every pull request and push runs verification;
a successful push to `main` then deploys Firebase Rules, builds a commit-tagged
container image, deploys the auth API to Cloud Run, builds `apps/web`, and
publishes that PWA to Firebase Hosting. The implementation is in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

The deploy path is deliberately limited to the control plane:

```text
GitHub Actions (OIDC) -> Artifact Registry -> Cloud Run auth API
                              |                    |
                              +-- Firebase Rules <--+-- Firebase Admin via runtime identity
                              |
                              +-- Firebase Hosting <- apps/web/dist
                                      |       |
Browser/PWA --------------------------+       +-- /v1/** rewrite to Cloud Run
       | 
       +-- Firebase RTDB signaling                 +-- short-lived TURN credentials
Browser/PWA <---------------- WebRTC ----------------> peer or external coturn host
```

coturn is not suitable for Cloud Run because TURN needs stable UDP/TCP listener
and relay ports. Run it on a VM or managed TURN provider with a public IP.

## CI and CD behavior

The `verify` job runs on every pull request, push, and manual workflow run. It
uses the repository’s locked Node/npm versions and runs lint, build, typecheck,
unit tests, high-severity dependency audit, and a basic secret-pattern scan.

On a successful push to `main`:

1. `deploy-firebase-rules` authenticates using GitHub-to-Google Workload
   Identity Federation and deploys Firestore and RTDB Rules.
2. `deploy-auth` builds `apps/auth/Dockerfile`, pushes an Artifact Registry
   image tagged with the immutable commit SHA, then creates a new Cloud Run
   revision from that exact image, and checks `/healthz`.
3. `deploy-web` builds `apps/web` using the public Firebase Web configuration
   and deploys it to Firebase Hosting.
4. Cloud Run injects the passkey ticket secret from Secret Manager. GitHub
   Actions receives neither secret value nor a long-lived Google service-account
   key.

The deployment jobs use the GitHub `production` environment. Configure required
reviewers there before enabling CD if you want a human approval gate.

## One-time Google Cloud setup

Use one Google/Firebase project for a demo environment. Enable Cloud Run,
Artifact Registry, Secret Manager, Firebase Authentication, Cloud Firestore,
Realtime Database, and the Firebase Management APIs. Create:

- an Artifact Registry Docker repository;
- a Cloud Run runtime service account;
- a GitHub deployer service account;
- a Workload Identity Pool/provider restricted to this GitHub repository and
  its `main` branch;
- two Secret Manager secrets: the passkey ticket secret and the coturn shared
  secret.

Give the GitHub deployer only the permissions needed to push to the selected
Artifact Registry repository, deploy the selected Cloud Run service, use its
runtime service account, and deploy Firebase Rules. Give the Cloud Run runtime
identity Firebase Admin permissions appropriate to Authentication, Firestore,
and RTDB plus `roles/secretmanager.secretAccessor` on only the two named
secrets.

Cloud Run should use its runtime service identity and Application Default
Credentials. Do **not** put `FIREBASE_SERVICE_ACCOUNT_JSON` or
`GOOGLE_APPLICATION_CREDENTIALS` into Cloud Run. Firebase Admin supports
Application Default Credentials in Cloud Run, and Cloud Run supports runtime
Secret Manager injection. [Firebase Admin setup](https://firebase.google.com/docs/admin/setup), [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets)

## GitHub configuration

Create the following **GitHub Actions repository variables**. They are names,
identifiers, URLs, or public configuration—not secret values.

| Variable | Example / purpose |
| --- | --- |
| `GCP_PROJECT_ID` | `huddle-demo-123` |
| `GCP_REGION` | `us-east4` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/.../workloadIdentityPools/.../providers/...` resource |
| `GCP_DEPLOYER_SERVICE_ACCOUNT` | GitHub deployer service-account email |
| `ARTIFACT_REGISTRY_REPOSITORY` | Docker repository name |
| `CLOUD_RUN_SERVICE` | `huddle-auth` |
| `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT` | Runtime service-account email |
| `FIREBASE_DATABASE_URL` | RTDB URL for the same Firebase project |
| `FIREBASE_HOSTING_SITE` | Firebase Hosting site ID, for example `test-96102` |
| `HUDDLE_ALLOWED_ORIGIN` | Exact HTTPS PWA origin, such as `https://chat.example.com` |
| `HUDDLE_WEBAUTHN_RP_ID` | The PWA DNS name, such as `chat.example.com` |
| `HUDDLE_TURN_URLS` | JSON list of public TURN URLs |
| `AUTH_TICKET_SECRET_NAME` / `AUTH_TICKET_SECRET_VERSION` | Secret Manager secret name and pinned version |
| `VITE_FIREBASE_API_KEY` | Public API key from the Firebase Web app |
| `VITE_FIREBASE_APP_ID` | Firebase Web app ID |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `VITE_FIREBASE_DATABASE_URL` | Firebase RTDB URL |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_AUTH_API_ORIGIN` | Firebase Hosting origin, for example `https://test-96102.web.app` |
| `VITE_STUN_URLS` | JSON STUN URL list, for example `["stun:stun.l.google.com:19302"]` |

The `AUTH_TICKET_SECRET_VERSION` variable intentionally pins the secret version
used by a Cloud Run revision. To rotate it, create a new Secret Manager version,
update the non-secret GitHub variable, and redeploy from `main`.

## Web and TURN deployment

Build the PWA using [`.env.example`](../apps/web/.env.example). The `VITE_*`
values are public Firebase web configuration and the Firebase Hosting origin.
The checked-in Firebase configuration publishes `apps/web/dist` to the
`test-96102` Hosting site and rewrites `/v1/**` to the `huddle-auth` Cloud Run
service in `us-east4`. That same-origin rewrite avoids a browser CORS boundary
between the PWA and the passkey API.

Deploy coturn outside Cloud Run. Configure it with the exact same TURN shared
secret stored in Secret Manager, your TURN DNS name, and its public external
IP. Open TCP/UDP 3478 plus the configured UDP relay-port range. The API returns
short-lived REST-style TURN credentials; it never returns the shared secret.

The first CD deployment uses `HUDDLE_TURN_URLS=[]` and does not inject a TURN
secret, so direct WebRTC plus STUN can be tested without pretending that TURN
exists. Add the TURN secret injection only when coturn is deployed and its
public URLs are known.

## First production-like test

After CD has deployed the API, Rules, and PWA, open
`https://test-96102.web.app` from two separate computers. Create separate
passkey accounts, create a huddle on the first device, send the invite code
through a secure out-of-band channel, join on the second device, refresh and
reselect the huddle on the first device, then select **Connect** from either
device. The UI changes to `connected directly` or `connected via TURN`; a Send
button becomes enabled only when the encrypted data channel is connected.

CI cannot honestly wait for two human WebRTC users: the data channel is
purposely end-to-end and its state is not reported to the server. Use the
two-browser acceptance step above for that proof, then test a forced TURN-only
network path once coturn is deployed.

## Prototype limits

- No automatic second-device enrollment; it is rejected rather than weakening
  Device-only mode.
- Chat history is not persisted.
- Static P-256 ECDH has no forward secrecy.
- A live two-browser test against your Firebase and TURN infrastructure is a
  deployment acceptance test, not something CI can prove without those isolated
  test resources.
