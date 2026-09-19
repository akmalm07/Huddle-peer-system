import { parseIceServers } from "@huddle/config";
import { InMemoryHuddleSdk, accountId, deviceId, huddleId } from "@huddle/sdk";

const alice = accountId("demo_alice");
const bob = accountId("demo_bob");
const aliceDevice = deviceId("demo_alice_laptop");
const bobDevice = deviceId("demo_bob_phone");
const room = huddleId("demo_huddle");
const sdk = new InMemoryHuddleSdk();

sdk.createAccount({ id: alice, username: "demo-alice", createdAtMs: 1 });
sdk.createAccount({ id: bob, username: "demo-bob", createdAtMs: 1 });
sdk.registerDevice(alice, { id: aliceDevice, publicIdentityKey: Uint8Array.of(1), fingerprint: "a".repeat(64), createdAtMs: 2 });
sdk.registerDevice(bob, { id: bobDevice, publicIdentityKey: Uint8Array.of(2), fingerprint: "b".repeat(64), createdAtMs: 2 });
sdk.createHuddle({ accountId: alice, deviceId: aliceDevice }, room, 3);
sdk.addMember({ accountId: alice, deviceId: aliceDevice }, bob, room);
sdk.submitTestSignal({ accountId: alice, deviceId: aliceDevice }, {
  protocolVersion: 1,
  signalId: "demo_offer",
  huddleId: room,
  connectionId: "demo_connection",
  senderDeviceId: aliceDevice,
  recipientAccountId: bob,
  recipientDeviceId: bobDevice,
  kind: "connection-hint",
  body: Uint8Array.of(1),
  createdAtMs: 10,
  expiresAtMs: 20,
});

const received = sdk.takeTestSignals({ accountId: bob, deviceId: bobDevice }, 11);
const iceServers = parseIceServers(process.env.HUDDLE_ICE_SERVERS ?? "[]");
console.log(JSON.stringify({
  demo: "headless-control-plane",
  huddleCreated: true,
  memberCount: sdk.listHuddles(bob)[0]?.members.size ?? 0,
  receivedTestSignals: received.length,
  configuredIceServers: iceServers.length,
  messageContent: "disabled-pending-e2ee-review",
}));
