import { useEffect, useRef, useState } from "react";
import { HuddleChat, HuddleClient, HuddleClientError, configurationFromEnvironment, type ChatMessage, type ConnectionSnapshot, type HuddleSummary, type Peer } from "./huddle.js";
import "./style/app.css";

type Mode = "login" | "register";

export default function App() {
  const client = useRef<HuddleClient | undefined>(undefined);
  const chat = useRef<HuddleChat | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState("Enter a username, choose sign in or create account, then continue with your passkey.");
  const [authenticated, setAuthenticated] = useState(false);
  const [huddles, setHuddles] = useState<readonly HuddleSummary[]>([]);
  const [selectedHuddle, setSelectedHuddle] = useState<string | undefined>(undefined);
  const [peers, setPeers] = useState<readonly Peer[]>([]);
  const [connections, setConnections] = useState<Readonly<Record<string, ConnectionSnapshot>>>({});
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [invitationCode, setInvitationCode] = useState("");

  useEffect(() => () => chat.current?.close(), []);

  async function authenticate(): Promise<void> {
    try {
      const config = configurationFromEnvironment(import.meta.env);
      const next = new HuddleClient(config.apiOrigin, config.firebase, config.stunUrls);
      setStatus(mode === "register" ? "Creating passkey…" : "Verifying passkey…");
      await (mode === "register" ? next.register(username) : next.login(username));
      client.current = next; setAuthenticated(true); setStatus("Signed in. Your device key remains in this browser's IndexedDB.");
      await refreshHuddles(next);
    } catch (error) { setStatus(displayError(error)); }
  }
  async function refreshHuddles(active = client.current): Promise<void> { if (active !== undefined) setHuddles(await active.listHuddles()); }
  async function createHuddle(): Promise<void> {
    try { const active = requiredClient(client.current); const huddleId = await active.createHuddle(); await refreshHuddles(active); await selectHuddle(huddleId); setStatus("Huddle created. Create an invite for another passkey-authenticated user."); } catch (error) { setStatus(displayError(error)); }
  }
  async function invite(): Promise<void> {
    try { const code = await requiredClient(client.current).createInvitation(requiredHuddle(selectedHuddle)); setInvitationCode(code); setStatus("Share this one-time invitation code through a secure channel. It expires in 24 hours."); } catch (error) { setStatus(displayError(error)); }
  }
  async function join(): Promise<void> {
    try { const huddleId = await requiredClient(client.current).joinInvitation(invitationCode.trim()); setInvitationCode(""); await refreshHuddles(); await selectHuddle(huddleId); setStatus("Joined huddle. Select Connect after the peer list appears."); } catch (error) { setStatus(displayError(error)); }
  }
  async function selectHuddle(huddleId: string): Promise<void> {
    try {
      chat.current?.close(); setMessages([]); setConnections({}); setSelectedHuddle(huddleId);
      const active = requiredClient(client.current); const nextPeers = await active.listPeers(huddleId); setPeers(nextPeers);
      const nextChat = new HuddleChat(active, huddleId, 1, (message) => setMessages((current) => [...current, message]), (connection) => setConnections((current) => ({ ...current, [connection.peerDeviceId]: connection })));
      for (const peer of nextPeers) await nextChat.prepare(peer);
      chat.current = nextChat; setStatus(nextPeers.length === 0 ? "No other active devices are in this huddle yet." : "Peer routes prepared. One participant should select Connect.");
    } catch (error) { setStatus(displayError(error)); }
  }
  async function connect(peerDeviceId: string): Promise<void> { try { await chat.current?.connect(peerDeviceId); setStatus("Negotiating an encrypted WebRTC data channel…"); } catch (error) { setStatus(displayError(error)); } }
  async function send(peerDeviceId: string): Promise<void> {
    try { const text = draft.trim(); if (text.length === 0) return; await chat.current?.send(peerDeviceId, text); setMessages((current) => [...current, { id: crypto.randomUUID(), receivedAtMs: Date.now(), senderDeviceId: "you", text }]); setDraft(""); } catch (error) { setStatus(displayError(error)); }
  }

  if (!authenticated) return <main><p className="eyebrow">Huddle · encrypted peer messaging prototype</p><h1>Start with a passkey.</h1><p className="summary">This browser creates a non-exportable device key and stores it only in IndexedDB. Firebase receives authorization metadata and expiring WebRTC signaling, never your messages.</p><section className="panel"><label>Username <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username webauthn" /></label><div className="actions"><button type="button" onClick={() => { setMode("login"); setStatus("Enter the username registered in this browser, then use its passkey."); }} disabled={mode === "login"}>Sign in</button><button type="button" onClick={() => { setMode("register"); setStatus("Choose a username, then create a passkey for this browser."); }} disabled={mode === "register"}>Create account</button><button type="button" className="primary" onClick={() => void authenticate()} disabled={username.length < 3}>{mode === "register" ? "Create passkey" : "Use passkey"}</button></div><Status value={status} /></section></main>;

  return <main><p className="eyebrow">Huddle · authenticated device</p><h1>Direct when possible. Relayed when necessary.</h1><p className="summary">Messages are encrypted in this browser before they enter WebRTC. A TURN relay may carry encrypted transport data but cannot read message content.</p><section className="panel"><div className="actions"><button type="button" className="primary" onClick={() => void createHuddle()}>New huddle</button><button type="button" onClick={() => void refreshHuddles()}>Refresh</button>{selectedHuddle !== undefined && <button type="button" onClick={() => void invite()}>Create invite</button>}</div>{invitationCode !== "" && <p className="code">Invite code: <code>{invitationCode}</code></p>}<label>Join with invitation code <input value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} /></label><button type="button" onClick={() => void join()} disabled={invitationCode.length < 16}>Join huddle</button><Status value={status} /></section><section className="grid"><article><h2>Your huddles</h2>{huddles.length === 0 ? <p>No huddles yet.</p> : huddles.map((huddle) => <button type="button" className={selectedHuddle === huddle.huddleId ? "selected" : ""} key={huddle.huddleId} onClick={() => void selectHuddle(huddle.huddleId)}>{huddle.role} · {shortId(huddle.huddleId)}</button>)}</article><article><h2>Peer devices</h2>{peers.length === 0 ? <p>Select a huddle with another member.</p> : peers.map((peer) => <div className="peer" key={peer.deviceId}><span>{shortId(peer.deviceId)}</span><span className="connection">{connectionLabel(connections[peer.deviceId])}</span><button type="button" onClick={() => void connect(peer.deviceId)}>Connect</button></div>)}</article></section>{selectedHuddle !== undefined && <section className="panel chat"><h2>Encrypted messages</h2><div className="messages" aria-live="polite">{messages.length === 0 ? <p>No messages in this browser session.</p> : messages.map((message) => <p key={message.id}><strong>{message.senderDeviceId === "you" ? "You" : shortId(message.senderDeviceId)}</strong> {message.text}</p>)}</div><label>Message <textarea value={draft} maxLength={16_384} onChange={(event) => setDraft(event.target.value)} /></label><div className="actions">{peers.map((peer) => <button type="button" className="primary" key={peer.deviceId} onClick={() => void send(peer.deviceId)} disabled={connections[peer.deviceId]?.state !== "connected" || draft.trim().length === 0}>Send to {shortId(peer.deviceId)}</button>)}</div></section>}</main>;
}

function Status({ value }: { readonly value: string }) { return <p className="status" role="status">{value}</p>; }
function shortId(value: string): string { return `${value.slice(0, 8)}…`; }
function requiredClient(value: HuddleClient | undefined): HuddleClient { if (value === undefined) throw new HuddleClientError("SESSION_REQUIRED"); return value; }
function requiredHuddle(value: string | undefined): string { if (value === undefined) throw new HuddleClientError("REQUEST_FAILED"); return value; }
function displayError(error: unknown): string { return error instanceof HuddleClientError ? `Unable to continue: ${error.code}.` : "Unable to continue. Check the deployment configuration and try again."; }
function connectionLabel(connection: ConnectionSnapshot | undefined): string { if (connection === undefined) return "not connected"; if (connection.state !== "connected") return connection.state; return connection.transport === "turn" ? "connected via TURN" : connection.transport === "direct" ? "connected directly" : "connected"; }
