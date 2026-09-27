import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { z } from "zod";
import { loadServiceConfig } from "@huddle/config";
import { createSafeEventSink } from "@huddle/observability";

const config = loadServiceConfig(process.env, "auth");
const secrets = loadSecrets(process.env);
const events = createSafeEventSink({ write: (line) => { process.stdout.write(line); } });
const firebase = getApps().length === 0 ? initializeApp(firebaseOptions(secrets)) : getApps()[0]!;
const firestore = getFirestore(firebase);
const realtime = getDatabase(firebase);
const firebaseAuth = getAuth(firebase);
const usernameSchema = z.string().trim().regex(/^[A-Za-z0-9_.-]{3,64}$/);
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{80,160}$/);
const bodyLimitBytes = 128 * 1024;
const invitationTtlMs = 24 * 60 * 60 * 1_000;
const turnTtlSeconds = 10 * 60;

interface Secrets {
  readonly webauthnRpId: string;
  readonly ticketSecret: Buffer;
  readonly turnSharedSecret: Buffer | undefined;
  readonly turnUrls: readonly string[];
  readonly firebaseDatabaseUrl: string | undefined;
  readonly firebaseProjectId: string | undefined;
  readonly firebaseServiceAccountJson: string | undefined;
}
interface Ticket { readonly accountId: string; readonly challenge: string; readonly expiresAtMs: number; readonly kind: "authentication" | "registration"; readonly username: string; }
interface CredentialRecord { readonly accountId: string; readonly counter: number; readonly credentialId: string; readonly publicKey: string; readonly transports: readonly string[]; }

const server = createServer((request, response) => { void handle(request, response); });
server.listen(config.port, config.bindHost, () => events.emit({ name: "service_started" }));

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "OPTIONS") return respond(response, 204, undefined);
    if (!sameOrigin(request)) return respond(response, 403, { code: "ORIGIN_FORBIDDEN" });
    const pathname = new URL(request.url ?? "/", config.allowedOrigin).pathname;
    if (request.method === "GET" && pathname === "/healthz") return respond(response, 200, { status: "ok", service: "auth", authentication: "passkey" });
    if (request.method === "POST" && pathname === "/v1/passkeys/register/options") return registrationOptions(await jsonBody(request), response);
    if (request.method === "POST" && pathname === "/v1/passkeys/register/verify") return registrationVerify(await jsonBody(request), response);
    if (request.method === "POST" && pathname === "/v1/passkeys/login/options") return authenticationOptions(await jsonBody(request), response);
    if (request.method === "POST" && pathname === "/v1/passkeys/login/verify") return authenticationVerify(await jsonBody(request), response);
    const identity = await requireIdentity(request);
    if (request.method === "POST" && pathname === "/v1/devices") return registerDevice(identity, await jsonBody(request), response);
    if (request.method === "POST" && pathname === "/v1/huddles") return createHuddle(identity, response);
    if (request.method === "GET" && pathname === "/v1/huddles") return listHuddles(identity, response);
    const inviteMatch = /^\/v1\/huddles\/([A-Za-z0-9_-]{1,96})\/invitations$/.exec(pathname);
    if (request.method === "POST" && inviteMatch !== null) return createInvitation(identity, inviteMatch[1]!, response);
    const peerMatch = /^\/v1\/huddles\/([A-Za-z0-9_-]{1,96})\/peers$/.exec(pathname);
    if (request.method === "GET" && peerMatch !== null) return listPeers(identity, peerMatch[1]!, response);
    if (request.method === "POST" && pathname === "/v1/invitations/join") return joinInvitation(identity, await jsonBody(request), response);
    if (request.method === "GET" && pathname === "/v1/turn-credentials") return turnCredentials(identity, response);
    return respond(response, 404, { code: "NOT_FOUND" });
  } catch (error) {
    const code = publicCode(error);
    events.emit({ name: "request_rejected", statusCode: code === "INTERNAL" ? 500 : 400, errorCode: code });
    return respond(response, code === "INTERNAL" ? 500 : 400, { code });
  }
}

async function registrationOptions(value: unknown, response: ServerResponse): Promise<void> {
  const username = usernameSchema.parse(z.object({ username: usernameSchema }).strict().parse(value).username);
  if ((await firestore.doc(`usernames/${username}`).get()).exists) throw new PublicError("USERNAME_UNAVAILABLE");
  const accountId = randomId();
  const options = await generateRegistrationOptions({ rpName: "Huddle", rpID: secrets.webauthnRpId, userName: username, userDisplayName: username, userID: Uint8Array.from(new TextEncoder().encode(accountId)), attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" } });
  return respond(response, 200, { options, ticket: signTicket({ accountId, challenge: options.challenge, expiresAtMs: Date.now() + 5 * 60 * 1_000, kind: "registration", username }) });
}

async function registrationVerify(value: unknown, response: ServerResponse): Promise<void> {
  const parsed = z.object({ response: z.unknown(), ticket: z.string().min(32).max(2_048) }).strict().parse(value);
  const ticket = verifyTicket(parsed.ticket, "registration");
  const verification = await verifyRegistrationResponse({ response: parsed.response as RegistrationResponseJSON, expectedChallenge: ticket.challenge, expectedOrigin: config.allowedOrigin, expectedRPID: secrets.webauthnRpId, requireUserVerification: true });
  if (!verification.verified || verification.registrationInfo === undefined) throw new PublicError("PASSKEY_VERIFICATION_FAILED");
  const credential = verification.registrationInfo.credential;
  await firestore.runTransaction(async (transaction) => {
    const username = firestore.doc(`usernames/${ticket.username}`);
    const credentialRef = firestore.doc(`authCredentials/${credential.id}`);
    if ((await transaction.get(username)).exists || (await transaction.get(credentialRef)).exists) throw new PublicError("USERNAME_UNAVAILABLE");
    transaction.create(username, { accountId: ticket.accountId, createdAtMs: Date.now() });
    transaction.create(firestore.doc(`accounts/${ticket.accountId}`), { createdAtMs: Date.now(), displayUsername: ticket.username, status: "active" });
    transaction.create(credentialRef, { accountId: ticket.accountId, counter: credential.counter, credentialId: credential.id, publicKey: bytesToBase64Url(credential.publicKey), transports: credential.transports ?? [] });
  });
  return respond(response, 200, { customToken: await firebaseAuth.createCustomToken(ticket.accountId) });
}

async function authenticationOptions(value: unknown, response: ServerResponse): Promise<void> {
  const username = usernameSchema.parse(z.object({ username: usernameSchema }).strict().parse(value).username);
  const accountId = (await firestore.doc(`usernames/${username}`).get()).data()?.accountId;
  if (typeof accountId !== "string") throw new PublicError("LOGIN_FAILED");
  const credentials = await credentialsForAccount(accountId);
  const options = await generateAuthenticationOptions({ rpID: secrets.webauthnRpId, allowCredentials: credentials.map((credential) => ({ id: credential.credentialId, transports: [...credential.transports] })), userVerification: "required" });
  return respond(response, 200, { options, ticket: signTicket({ accountId, challenge: options.challenge, expiresAtMs: Date.now() + 5 * 60 * 1_000, kind: "authentication", username }) });
}

async function authenticationVerify(value: unknown, response: ServerResponse): Promise<void> {
  const parsed = z.object({ response: z.object({ id: z.string().min(1).max(1_024) }).passthrough(), ticket: z.string().min(32).max(2_048) }).strict().parse(value);
  const ticket = verifyTicket(parsed.ticket, "authentication");
  const record = await credential(parsed.response.id, ticket.accountId);
  const verification = await verifyAuthenticationResponse({ response: parsed.response as unknown as AuthenticationResponseJSON, expectedChallenge: ticket.challenge, expectedOrigin: config.allowedOrigin, expectedRPID: secrets.webauthnRpId, credential: { id: record.credentialId, publicKey: base64UrlToBytes(record.publicKey), counter: record.counter, transports: [...record.transports] }, requireUserVerification: true });
  if (!verification.verified || (record.counter !== 0 && verification.authenticationInfo.newCounter <= record.counter)) throw new PublicError("LOGIN_FAILED");
  await firestore.doc(`authCredentials/${record.credentialId}`).update({ counter: verification.authenticationInfo.newCounter, lastUsedAtMs: Date.now() });
  return respond(response, 200, { customToken: await firebaseAuth.createCustomToken(ticket.accountId) });
}

async function registerDevice(accountId: string, value: unknown, response: ServerResponse): Promise<void> {
  const publicIdentityKey = publicKeySchema.parse(z.object({ publicIdentityKey: publicKeySchema }).strict().parse(value).publicIdentityKey);
  if (!(await firestore.collection("devices").where("accountId", "==", accountId).where("status", "==", "active").limit(1).get()).empty) throw new PublicError("DEVICE_ENROLLMENT_REQUIRED");
  const deviceId = randomId();
  await firestore.doc(`devices/${deviceId}`).create({ accountId, createdAtMs: Date.now(), fingerprint: fingerprint(publicIdentityKey), publicIdentityKey, status: "active" });
  await realtime.ref(`activeDevices/${deviceId}`).set(accountId);
  return respond(response, 201, { accountId, deviceId, publicIdentityKey });
}

async function createHuddle(accountId: string, response: ServerResponse): Promise<void> {
  await requireActiveDevice(accountId);
  const huddleId = randomId(); const now = Date.now(); const batch = firestore.batch();
  batch.create(firestore.doc(`huddles/${huddleId}`), { createdAtMs: now, epoch: 1, ownerAccountId: accountId });
  batch.create(firestore.doc(`huddles/${huddleId}/members/${accountId}`), { accountId, role: "owner", status: "active" });
  await batch.commit(); await realtime.ref(`huddleMembers/${huddleId}/${accountId}`).set(true);
  return respond(response, 201, { huddleId });
}
async function listHuddles(accountId: string, response: ServerResponse): Promise<void> {
  const memberships = await firestore.collectionGroup("members").where("accountId", "==", accountId).where("status", "==", "active").get();
  const huddles = memberships.docs.flatMap((member) => { const huddle = member.ref.parent.parent; return huddle === null ? [] : [{ huddleId: huddle.id, role: member.data().role }]; });
  return respond(response, 200, { huddles });
}
async function createInvitation(accountId: string, huddleId: string, response: ServerResponse): Promise<void> {
  await requireOwner(accountId, huddleId); const invitationCode = randomId(); const expiresAtMs = Date.now() + invitationTtlMs;
  await firestore.doc(`invitations/${digest(invitationCode)}`).create({ createdAtMs: Date.now(), expiresAtMs, huddleId, issuerAccountId: accountId, status: "active" });
  return respond(response, 201, { expiresAtMs, invitationCode });
}
async function joinInvitation(accountId: string, value: unknown, response: ServerResponse): Promise<void> {
  await requireActiveDevice(accountId);
  const invitationCode = z.string().regex(/^[A-Za-z0-9_-]{16,96}$/).parse(z.object({ invitationCode: z.string() }).strict().parse(value).invitationCode);
  const inviteRef = firestore.doc(`invitations/${digest(invitationCode)}`); let huddleId = "";
  await firestore.runTransaction(async (transaction) => {
    const invite = await transaction.get(inviteRef); const data = invite.data();
    if (!invite.exists || data?.status !== "active" || typeof data.huddleId !== "string" || typeof data.expiresAtMs !== "number" || data.expiresAtMs <= Date.now()) throw new PublicError("INVITATION_INVALID");
    huddleId = data.huddleId; const member = firestore.doc(`huddles/${huddleId}/members/${accountId}`);
    if (!(await transaction.get(member)).exists) {
      const activeMembers = await transaction.get(firestore.collection(`huddles/${huddleId}/members`).where("status", "==", "active"));
      if (activeMembers.size >= 8) throw new PublicError("DIRECT_MESH_CAPACITY_EXCEEDED");
      transaction.create(member, { accountId, role: "member", status: "active" });
    }
    transaction.update(inviteRef, { acceptedByAccountId: accountId, acceptedAtMs: Date.now(), status: "used" });
  });
  await realtime.ref(`huddleMembers/${huddleId}/${accountId}`).set(true); return respond(response, 200, { huddleId });
}
async function listPeers(accountId: string, huddleId: string, response: ServerResponse): Promise<void> {
  await requireMembership(accountId, huddleId);
  const members = await firestore.collection(`huddles/${huddleId}/members`).where("status", "==", "active").get();
  const accounts = members.docs.map((member) => member.data().accountId).filter((value): value is string => typeof value === "string");
  const devices = await Promise.all(accounts.map(async (memberAccountId) => firestore.collection("devices").where("accountId", "==", memberAccountId).where("status", "==", "active").get()));
  return respond(response, 200, { peers: devices.flatMap((snapshot) => snapshot.docs.map((device) => ({ accountId: device.data().accountId, deviceId: device.id, publicIdentityKey: device.data().publicIdentityKey }))) });
}
async function turnCredentials(accountId: string, response: ServerResponse): Promise<void> {
  if (secrets.turnSharedSecret === undefined || secrets.turnUrls.length === 0) throw new PublicError("TURN_UNAVAILABLE");
  const username = `${Math.floor(Date.now() / 1_000) + turnTtlSeconds}:${accountId}:${randomId().slice(0, 12)}`;
  const credential = createHmac("sha1", secrets.turnSharedSecret).update(username).digest("base64");
  return respond(response, 200, { credential, ttlSeconds: turnTtlSeconds, urls: secrets.turnUrls, username });
}

async function requireIdentity(request: IncomingMessage): Promise<string> { const value = request.headers.authorization; if (value === undefined || !value.startsWith("Bearer ")) throw new PublicError("UNAUTHENTICATED"); try { return (await firebaseAuth.verifyIdToken(value.slice(7))).uid; } catch { throw new PublicError("UNAUTHENTICATED"); } }
async function requireActiveDevice(accountId: string): Promise<void> { if ((await firestore.collection("devices").where("accountId", "==", accountId).where("status", "==", "active").limit(1).get()).empty) throw new PublicError("DEVICE_REQUIRED"); }
async function requireMembership(accountId: string, huddleId: string): Promise<void> { const member = await firestore.doc(`huddles/${huddleId}/members/${accountId}`).get(); if (!member.exists || member.data()?.status !== "active") throw new PublicError("UNAUTHORIZED"); }
async function requireOwner(accountId: string, huddleId: string): Promise<void> { await requireMembership(accountId, huddleId); if ((await firestore.doc(`huddles/${huddleId}`).get()).data()?.ownerAccountId !== accountId) throw new PublicError("UNAUTHORIZED"); }
async function credential(credentialId: string, accountId: string): Promise<CredentialRecord> { const data = (await firestore.doc(`authCredentials/${credentialId}`).get()).data(); if (data?.accountId !== accountId || typeof data.counter !== "number" || typeof data.publicKey !== "string" || !Array.isArray(data.transports)) throw new PublicError("LOGIN_FAILED"); return { accountId, counter: data.counter, credentialId, publicKey: data.publicKey, transports: data.transports.filter((item): item is string => typeof item === "string") }; }
async function credentialsForAccount(accountId: string): Promise<readonly CredentialRecord[]> { return Promise.all((await firestore.collection("authCredentials").where("accountId", "==", accountId).get()).docs.map((document) => credential(document.id, accountId))); }
function sameOrigin(request: IncomingMessage): boolean { return request.headers.origin === undefined || request.headers.origin === config.allowedOrigin; }
async function jsonBody(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength; if (size > bodyLimitBytes) throw new PublicError("REQUEST_INVALID"); chunks.push(bytes); } try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new PublicError("REQUEST_INVALID"); } }
function respond(response: ServerResponse, status: number, body: unknown): void { response.setHeader("access-control-allow-origin", config.allowedOrigin); response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); response.setHeader("access-control-allow-headers", "authorization, content-type"); response.setHeader("cache-control", "no-store"); if (status === 204) { response.writeHead(status); response.end(); return; } response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
function signTicket(ticket: Ticket): string { const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url"); return `${payload}.${createHmac("sha256", secrets.ticketSecret).update(payload).digest("base64url")}`; }
function verifyTicket(value: string, kind: Ticket["kind"]): Ticket { const [payload, signature, ...rest] = value.split("."); if (payload === undefined || signature === undefined || rest.length !== 0) throw new PublicError("PASSKEY_VERIFICATION_FAILED"); const expected = createHmac("sha256", secrets.ticketSecret).update(payload).digest("base64url"); if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new PublicError("PASSKEY_VERIFICATION_FAILED"); let ticket: unknown; try { ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new PublicError("PASSKEY_VERIFICATION_FAILED"); } const parsed = z.object({ accountId: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/), challenge: z.string().min(16).max(1_024), expiresAtMs: z.number().int(), kind: z.enum(["authentication", "registration"]), username: usernameSchema }).strict().safeParse(ticket); if (!parsed.success || parsed.data.kind !== kind || parsed.data.expiresAtMs <= Date.now()) throw new PublicError("PASSKEY_VERIFICATION_FAILED"); return parsed.data; }
function loadSecrets(environment: Readonly<Record<string, string | undefined>>): Secrets { const parsed = z.object({ FIREBASE_DATABASE_URL: z.url().optional(), FIREBASE_PROJECT_ID: z.string().regex(/^[a-z0-9-]{6,63}$/).optional(), FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(), HUDDLE_AUTH_TICKET_SECRET: z.string().min(32), HUDDLE_TURN_SHARED_SECRET: z.string().optional(), HUDDLE_TURN_URLS: z.string().default("[]"), HUDDLE_WEBAUTHN_RP_ID: z.string().regex(/^[a-z0-9.-]{1,253}$/) }).safeParse(environment); if (!parsed.success) throw new Error("AUTH_SECRET_CONFIG_INVALID"); const turnSecret = parsed.data.HUDDLE_TURN_SHARED_SECRET === "" ? undefined : parsed.data.HUDDLE_TURN_SHARED_SECRET; if (turnSecret !== undefined && turnSecret.length < 32) throw new Error("AUTH_SECRET_CONFIG_INVALID"); let turnUrls: unknown; try { turnUrls = JSON.parse(parsed.data.HUDDLE_TURN_URLS); } catch { throw new Error("AUTH_SECRET_CONFIG_INVALID"); } const urls = z.array(z.string().regex(/^turns?:[^\s]+$/)).min(1).max(4).safeParse(turnUrls); if (!urls.success && turnSecret !== undefined) throw new Error("AUTH_SECRET_CONFIG_INVALID"); return { firebaseDatabaseUrl: parsed.data.FIREBASE_DATABASE_URL, firebaseProjectId: parsed.data.FIREBASE_PROJECT_ID, firebaseServiceAccountJson: parsed.data.FIREBASE_SERVICE_ACCOUNT_JSON, ticketSecret: Buffer.from(parsed.data.HUDDLE_AUTH_TICKET_SECRET, "base64url"), turnSharedSecret: turnSecret === undefined ? undefined : Buffer.from(turnSecret, "base64url"), turnUrls: urls.success ? urls.data : [], webauthnRpId: parsed.data.HUDDLE_WEBAUTHN_RP_ID }; }
function firebaseOptions(value: Secrets) { const serviceAccount = value.firebaseServiceAccountJson === undefined ? undefined : JSON.parse(value.firebaseServiceAccountJson) as unknown as ServiceAccount; return { ...(serviceAccount === undefined ? {} : { credential: cert(serviceAccount) }), ...(value.firebaseDatabaseUrl === undefined ? {} : { databaseURL: value.firebaseDatabaseUrl }), ...(value.firebaseProjectId === undefined ? {} : { projectId: value.firebaseProjectId }) }; }
function randomId(): string { return randomBytes(24).toString("base64url"); }
function digest(value: string): string { return createHmac("sha256", secrets.ticketSecret).update(`invite:${value}`).digest("base64url"); }
function fingerprint(value: string): string { return createHmac("sha256", "huddle-public-fingerprint").update(value).digest("hex"); }
function bytesToBase64Url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(Buffer.from(value, "base64url")); }
class PublicError extends Error { public constructor(public readonly code: string) { super(code); } }
function publicCode(error: unknown): string { if (error instanceof PublicError) return error.code; if (error instanceof z.ZodError) return "REQUEST_INVALID"; return "INTERNAL"; }
