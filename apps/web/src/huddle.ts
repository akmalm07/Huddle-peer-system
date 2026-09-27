import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { StaticWebCryptoE2eeProvider, generateStaticDeviceIdentity, type EstablishedE2eeSession, type StaticDeviceIdentity } from "@huddle/crypto";
import { FirebaseRtdbWebRtcSignaler } from "@huddle/firebase-web";
import { chatAssociatedData, decodeEncryptedChatFrame, encodeCanonicalCbor, encodeEncryptedChatFrame, type EncryptedChatMessage } from "@huddle/protocol";
import { WebRtcPeer, type WebRtcTransportKind } from "@huddle/webrtc";
import { initializeApp } from "firebase/app";
import { getAuth, inMemoryPersistence, setPersistence, signInWithCustomToken } from "firebase/auth";
import { getDatabase } from "firebase/database";

const identifier = /^[A-Za-z0-9_-]{1,96}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const messageTtlMs = 10 * 60 * 1_000;

export interface HuddleSummary { readonly huddleId: string; readonly role: "owner" | "member"; }
export interface Peer { readonly accountId: string; readonly deviceId: string; readonly publicIdentityKey: string; }
export interface ChatMessage { readonly id: string; readonly senderDeviceId: string; readonly text: string; readonly receivedAtMs: number; }
export interface ConnectionSnapshot { readonly peerDeviceId: string; readonly state: RTCPeerConnectionState; readonly transport: WebRtcTransportKind; }

interface DeviceIdentityRecord { readonly accountId: string; readonly deviceId: string; readonly privateKey: CryptoKey; readonly publicKey: ArrayBuffer; }
interface Session { readonly accountId: string; readonly deviceId: string; readonly identity: StaticDeviceIdentity; }
interface FirebaseConfiguration { readonly apiKey: string; readonly appId: string; readonly authDomain: string; readonly databaseURL: string; readonly projectId: string; }
interface TurnCredentials { readonly credential: string; readonly urls: readonly string[]; readonly username: string; }

export class HuddleClient {
  private readonly firebase;
  private session: Session | undefined;
  public constructor(private readonly apiOrigin: string, configuration: FirebaseConfiguration, private readonly stunUrls: readonly string[]) {
    this.firebase = initializeApp(configuration);
  }
  public async register(username: string): Promise<Session> {
    const start = await this.publicRequest<{ readonly options: PublicKeyCredentialCreationOptionsJSON; readonly ticket: string }>("/v1/passkeys/register/options", { username });
    const response = await startRegistration({ optionsJSON: start.options });
    const verified = await this.publicRequest<{ readonly customToken: string }>("/v1/passkeys/register/verify", { response, ticket: start.ticket });
    return this.finishAuthentication(verified.customToken);
  }
  public async login(username: string): Promise<Session> {
    const start = await this.publicRequest<{ readonly options: PublicKeyCredentialRequestOptionsJSON; readonly ticket: string }>("/v1/passkeys/login/options", { username });
    const response = await startAuthentication({ optionsJSON: start.options });
    const verified = await this.publicRequest<{ readonly customToken: string }>("/v1/passkeys/login/verify", { response, ticket: start.ticket });
    return this.finishAuthentication(verified.customToken);
  }
  public currentSession(): Session {
    if (this.session === undefined) throw new HuddleClientError("SESSION_REQUIRED");
    return this.session;
  }
  public async createHuddle(): Promise<string> { return (await this.authorizedRequest<{ readonly huddleId: string }>("/v1/huddles", "POST")).huddleId; }
  public async listHuddles(): Promise<readonly HuddleSummary[]> { return (await this.authorizedRequest<{ readonly huddles: readonly HuddleSummary[] }>("/v1/huddles", "GET")).huddles; }
  public async createInvitation(huddleId: string): Promise<string> { return (await this.authorizedRequest<{ readonly invitationCode: string }>(`/v1/huddles/${huddleId}/invitations`, "POST")).invitationCode; }
  public async joinInvitation(invitationCode: string): Promise<string> { return (await this.authorizedRequest<{ readonly huddleId: string }>("/v1/invitations/join", "POST", { invitationCode })).huddleId; }
  public async listPeers(huddleId: string): Promise<readonly Peer[]> {
    const peers = (await this.authorizedRequest<{ readonly peers: readonly Peer[] }>(`/v1/huddles/${huddleId}/peers`, "GET")).peers;
    return peers.filter((peer) => peer.accountId !== this.currentSession().accountId || peer.deviceId !== this.currentSession().deviceId).filter(isPeer);
  }
  public async iceServers(): Promise<readonly RTCIceServer[]> {
    const servers: RTCIceServer[] = this.stunUrls.length === 0 ? [] : [{ urls: [...this.stunUrls] }];
    try {
      const turn = await this.authorizedRequest<TurnCredentials>("/v1/turn-credentials", "GET");
      servers.push({ credential: turn.credential, urls: [...turn.urls], username: turn.username });
    } catch (error) {
      if (!(error instanceof HuddleClientError) || error.code !== "TURN_UNAVAILABLE") throw error;
    }
    return servers;
  }
  public database() { return getDatabase(this.firebase); }
  private async finishAuthentication(customToken: string): Promise<Session> {
    const auth = getAuth(this.firebase);
    await setPersistence(auth, inMemoryPersistence);
    const credential = await signInWithCustomToken(auth, customToken);
    const identity = await loadOrCreateIdentity(credential.user.uid, async (publicIdentityKey) => this.authorizedRequest<{ readonly deviceId: string }>("/v1/devices", "POST", { publicIdentityKey }));
    this.session = { accountId: credential.user.uid, deviceId: identity.deviceId, identity: { privateKey: identity.privateKey, publicKey: new Uint8Array(identity.publicKey) } };
    return this.session;
  }
  private async publicRequest<T>(path: string, body: unknown): Promise<T> { return this.request<T>(path, "POST", body); }
  private async authorizedRequest<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const user = getAuth(this.firebase).currentUser;
    if (user === null) throw new HuddleClientError("SESSION_REQUIRED");
    return this.request<T>(path, method, body, await user.getIdToken());
  }
  private async request<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
    const response = await fetch(new URL(path, this.apiOrigin), { body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, method, mode: "cors", credentials: "omit" });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(payload)) throw new HuddleClientError(readCode(payload));
    return payload as T;
  }
}

export class HuddleChat {
  private readonly connections = new Map<string, PeerConnection>();
  public constructor(private readonly client: HuddleClient, private readonly huddleId: string, private readonly epoch: number, private readonly onMessage: (message: ChatMessage) => void, private readonly onState: (state: ConnectionSnapshot) => void) {}
  public async prepare(peer: Peer): Promise<void> {
    if (this.connections.has(peer.deviceId)) return;
    const local = this.client.currentSession();
    const connectionId = await stableConnectionId(this.huddleId, local.deviceId, peer.deviceId);
    const participants = [[local.accountId, local.deviceId], [peer.accountId, peer.deviceId]].sort(([leftAccount, leftDevice], [rightAccount, rightDevice]) => `${leftAccount}:${leftDevice}`.localeCompare(`${rightAccount}:${rightDevice}`));
    const context = encodeCanonicalCbor({ epoch: this.epoch, huddleId: this.huddleId, participants, protocolVersion: 1 });
    const remoteKey = ownedBytes(base64UrlToBytes(peer.publicIdentityKey));
    const e2ee = await new StaticWebCryptoE2eeProvider({ crypto: globalThis.crypto as never, localIdentity: local.identity }).initializeSession({ authenticatedContext: context, huddleId: this.huddleId, localDeviceId: local.deviceId, remoteDeviceId: peer.deviceId, remoteIdentityPublicKey: remoteKey });
    const route = { connectionId, expiresAtMs: () => Date.now() + 5 * 60 * 1_000, huddleId: this.huddleId, localAccountId: local.accountId, localDeviceId: local.deviceId, recipientAccountId: peer.accountId, recipientDeviceId: peer.deviceId };
    const signaler = new FirebaseRtdbWebRtcSignaler(this.client.database(), route);
    const peerConnection = new PeerConnection(local, peer, this.huddleId, this.epoch, e2ee, signaler, await this.client.iceServers(), this.onMessage, this.onState);
    peerConnection.subscribe(); this.connections.set(peer.deviceId, peerConnection);
  }
  public async connect(peerDeviceId: string): Promise<void> { const connection = this.connections.get(peerDeviceId); if (connection === undefined) throw new HuddleClientError("PEER_NOT_PREPARED"); await connection.offer(); }
  public async send(peerDeviceId: string, text: string): Promise<void> { const connection = this.connections.get(peerDeviceId); if (connection === undefined) throw new HuddleClientError("PEER_NOT_PREPARED"); await connection.send(text); }
  public close(): void { for (const connection of this.connections.values()) connection.close(); this.connections.clear(); }
}

class PeerConnection {
  private readonly peer: WebRtcPeer;
  private unsubscribe: (() => void) | undefined;
  public constructor(private readonly local: Session, private readonly remote: Peer, private readonly huddleId: string, private readonly epoch: number, private readonly e2ee: EstablishedE2eeSession, private readonly signaler: FirebaseRtdbWebRtcSignaler, iceServers: readonly RTCIceServer[], private readonly onMessage: (message: ChatMessage) => void, private readonly onState: (state: ConnectionSnapshot) => void) {
    this.peer = new WebRtcPeer({ iceServers, signaler, onData: (frame) => { void this.receive(frame); }, onStateChange: (state) => { void this.reportState(state); } });
  }
  public subscribe(): void { this.unsubscribe = this.signaler.subscribe((signal) => { void this.peer.receive(signal).catch(() => this.close()); }); }
  public async offer(): Promise<void> { await this.peer.offer(); }
  public async send(text: string): Promise<void> {
    const plaintext = textEncoder.encode(text);
    if (plaintext.byteLength === 0 || plaintext.byteLength > 16 * 1024) throw new HuddleClientError("MESSAGE_INVALID");
    const createdAtMs = Date.now();
    const header = { protocolVersion: 1 as const, messageType: "application" as const, messageId: randomId(), senderAccountId: this.local.accountId, senderDeviceId: this.local.deviceId, recipientAccountId: this.remote.accountId, recipientDeviceId: this.remote.deviceId, huddleId: this.huddleId, epoch: this.epoch, createdAtMs, expiresAtMs: createdAtMs + messageTtlMs };
    const ciphertext = await this.e2ee.encrypt(plaintext, chatAssociatedData(header));
    this.peer.send(encodeEncryptedChatFrame({ ...header, ciphertext: ownedBytes(ciphertext) }));
  }
  public close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.peer.close(); }
  private async receive(frame: Uint8Array): Promise<void> {
    try {
      const message = decodeEncryptedChatFrame(frame, Date.now());
      if (!this.isExpected(message)) throw new HuddleClientError("MESSAGE_UNAUTHORIZED");
      const header = { protocolVersion: message.protocolVersion, messageType: message.messageType, messageId: message.messageId, senderAccountId: message.senderAccountId, senderDeviceId: message.senderDeviceId, recipientAccountId: message.recipientAccountId, recipientDeviceId: message.recipientDeviceId, huddleId: message.huddleId, epoch: message.epoch, createdAtMs: message.createdAtMs, expiresAtMs: message.expiresAtMs };
      const plaintext = await this.e2ee.decrypt(message.ciphertext, chatAssociatedData(header));
      const text = textDecoder.decode(plaintext);
      this.onMessage({ id: message.messageId, receivedAtMs: Date.now(), senderDeviceId: message.senderDeviceId, text });
    } catch { this.close(); }
  }
  private isExpected(message: EncryptedChatMessage): boolean { return message.huddleId === this.huddleId && message.epoch === this.epoch && message.senderAccountId === this.remote.accountId && message.senderDeviceId === this.remote.deviceId && message.recipientAccountId === this.local.accountId && message.recipientDeviceId === this.local.deviceId; }
  private async reportState(state: RTCPeerConnectionState): Promise<void> { this.onState({ peerDeviceId: this.remote.deviceId, state, transport: state === "connected" ? await this.peer.transportKind() : "unknown" }); }
}

export function configurationFromEnvironment(environment: ImportMetaEnv): { readonly apiOrigin: string; readonly firebase: FirebaseConfiguration; readonly stunUrls: readonly string[] } {
  const firebase = { apiKey: environment.VITE_FIREBASE_API_KEY, appId: environment.VITE_FIREBASE_APP_ID, authDomain: environment.VITE_FIREBASE_AUTH_DOMAIN, databaseURL: environment.VITE_FIREBASE_DATABASE_URL, projectId: environment.VITE_FIREBASE_PROJECT_ID };
  if (Object.values(firebase).some((value) => typeof value !== "string" || value.length === 0) || typeof environment.VITE_AUTH_API_ORIGIN !== "string") throw new HuddleClientError("CONFIGURATION_REQUIRED");
  const stunUrls = environment.VITE_STUN_URLS === undefined || environment.VITE_STUN_URLS === "" ? [] : parseStunUrls(environment.VITE_STUN_URLS);
  return { apiOrigin: environment.VITE_AUTH_API_ORIGIN, firebase, stunUrls };
}

async function loadOrCreateIdentity(accountId: string, register: (publicIdentityKey: string) => Promise<{ readonly deviceId: string }>): Promise<DeviceIdentityRecord> {
  const database = await openIdentityDatabase(); const stored = await readIdentity(database, accountId);
  if (stored !== undefined) return stored;
  const identity = await generateStaticDeviceIdentity(globalThis.crypto as never); const device = await register(bytesToBase64Url(identity.publicKey));
  const record: DeviceIdentityRecord = { accountId, deviceId: device.deviceId, privateKey: identity.privateKey as unknown as CryptoKey, publicKey: Uint8Array.from(identity.publicKey).buffer };
  await saveIdentity(database, record); return record;
}
function openIdentityDatabase(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open("huddle-device-identity-v1", 1); request.onerror = () => reject(new HuddleClientError("STORAGE_UNAVAILABLE")); request.onupgradeneeded = () => request.result.createObjectStore("identities", { keyPath: "accountId" }); request.onsuccess = () => resolve(request.result); }); }
function readIdentity(database: IDBDatabase, accountId: string): Promise<DeviceIdentityRecord | undefined> { return new Promise((resolve, reject) => { const request = database.transaction("identities", "readonly").objectStore("identities").get(accountId); request.onerror = () => reject(new HuddleClientError("STORAGE_UNAVAILABLE")); request.onsuccess = () => resolve(isIdentityRecord(request.result) ? request.result : undefined); }); }
function saveIdentity(database: IDBDatabase, record: DeviceIdentityRecord): Promise<void> { return new Promise((resolve, reject) => { const request = database.transaction("identities", "readwrite").objectStore("identities").put(record); request.onerror = () => reject(new HuddleClientError("STORAGE_UNAVAILABLE")); request.onsuccess = () => resolve(); }); }
function isIdentityRecord(value: unknown): value is DeviceIdentityRecord { return isRecord(value) && typeof value.accountId === "string" && typeof value.deviceId === "string" && value.privateKey instanceof CryptoKey && value.publicKey instanceof ArrayBuffer; }
function isPeer(value: Peer): boolean { return identifier.test(value.accountId) && identifier.test(value.deviceId) && /^[A-Za-z0-9_-]{80,160}$/.test(value.publicIdentityKey); }
function parseStunUrls(value: string): readonly string[] { const parsed: unknown = JSON.parse(value); if (!Array.isArray(parsed) || parsed.length > 4 || parsed.some((item) => typeof item !== "string" || !/^stun:[^\s]+$/i.test(item))) throw new HuddleClientError("CONFIGURATION_REQUIRED"); return parsed; }
async function stableConnectionId(huddleId: string, left: string, right: string): Promise<string> { const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(`${huddleId}:${[left, right].sort().join(":")}`)); return bytesToBase64Url(new Uint8Array(digest)); }
function randomId(): string { const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24)); return bytesToBase64Url(bytes); }
function bytesToBase64Url(value: Uint8Array): string { let raw = ""; for (const byte of value) raw += String.fromCharCode(byte); return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
function base64UrlToBytes(value: string): Uint8Array { const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4); const raw = atob(padded); const bytes = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index); return bytes; }
function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> { const result = new Uint8Array(new ArrayBuffer(value.byteLength)); result.set(value); return result; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function readCode(value: unknown): HuddleClientErrorCode { return isRecord(value) && typeof value.code === "string" && isPublicCode(value.code) ? value.code : "REQUEST_FAILED"; }
const publicCodes = new Set<HuddleClientErrorCode>(["CONFIGURATION_REQUIRED", "DEVICE_ENROLLMENT_REQUIRED", "DIRECT_MESH_CAPACITY_EXCEEDED", "MESSAGE_INVALID", "MESSAGE_UNAUTHORIZED", "PEER_NOT_PREPARED", "REQUEST_FAILED", "SESSION_REQUIRED", "STORAGE_UNAVAILABLE", "TURN_UNAVAILABLE"]);
type HuddleClientErrorCode = "CONFIGURATION_REQUIRED" | "DEVICE_ENROLLMENT_REQUIRED" | "DIRECT_MESH_CAPACITY_EXCEEDED" | "MESSAGE_INVALID" | "MESSAGE_UNAUTHORIZED" | "PEER_NOT_PREPARED" | "REQUEST_FAILED" | "SESSION_REQUIRED" | "STORAGE_UNAVAILABLE" | "TURN_UNAVAILABLE";
function isPublicCode(value: string): value is HuddleClientErrorCode { return publicCodes.has(value as HuddleClientErrorCode); }
export class HuddleClientError extends Error { public constructor(public readonly code: HuddleClientErrorCode) { super(code); this.name = "HuddleClientError"; } }
