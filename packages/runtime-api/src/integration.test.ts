import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryHuddleSdk, accountId, deviceId, huddleId, type TestSignal } from "@huddle/sdk";
import { RuntimeApi, RuntimeApiError, type DeviceTokenVerifier } from "./index.js";

const now = 1_000;
const alice = accountId("alice"); const bob = accountId("bob"); const charlie = accountId("charlie");
const aliceDevice = deviceId("alice_device"); const bobDevice = deviceId("bob_device"); const charlieDevice = deviceId("charlie_device");
const ab = huddleId("huddle_ab"); const bc = huddleId("huddle_bc"); const ca = huddleId("huddle_ca");

test("three peers remain isolated across three huddles while authorized delivery and ACK work", async () => {
  const sdk = new InMemoryHuddleSdk();
  for (const [account, device, marker] of [[alice, aliceDevice, 1], [bob, bobDevice, 2], [charlie, charlieDevice, 3]] as const) {
    sdk.createAccount({ id: account, username: account, createdAtMs: now });
    sdk.registerDevice(account, { id: device, publicIdentityKey: Uint8Array.of(marker), fingerprint: `${marker}`.repeat(64), createdAtMs: now });
  }
  sdk.createHuddle({ accountId: alice, deviceId: aliceDevice }, ab, now); sdk.addMember({ accountId: alice, deviceId: aliceDevice }, bob, ab);
  sdk.createHuddle({ accountId: bob, deviceId: bobDevice }, bc, now); sdk.addMember({ accountId: bob, deviceId: bobDevice }, charlie, bc);
  sdk.createHuddle({ accountId: charlie, deviceId: charlieDevice }, ca, now); sdk.addMember({ accountId: charlie, deviceId: charlieDevice }, alice, ca);
  const verifier: DeviceTokenVerifier = { verify: async (token) => ({
    alice: { accountId: alice, deviceId: aliceDevice }, bob: { accountId: bob, deviceId: bobDevice }, charlie: { accountId: charlie, deviceId: charlieDevice },
  }[token] === undefined ? Promise.reject(new Error("invalid")) : { ...({ alice: { accountId: alice, deviceId: aliceDevice }, bob: { accountId: bob, deviceId: bobDevice }, charlie: { accountId: charlie, deviceId: charlieDevice } }[token]!), expiresAtMs: now + 10_000 }) };
  const runtime = new RuntimeApi(sdk, verifier, { nowMs: () => now });
  const signal: TestSignal = { protocolVersion: 1, signalId: "signal_ab", huddleId: ab, connectionId: "connection_ab", senderDeviceId: aliceDevice, recipientAccountId: bob, recipientDeviceId: bobDevice, kind: "offer", body: Uint8Array.of(1), createdAtMs: now, expiresAtMs: now + 100 };
  await runtime.authorizeAndPublishSignal("alice", signal);
  assert.equal(sdk.takeTestSignals({ accountId: bob, deviceId: bobDevice }, now).length, 1);
  const envelope = { protocolVersion: 1 as const, messageType: "application" as const, messageId: "message_ab", senderAccountId: alice, senderDeviceId: aliceDevice, recipientAccountId: bob, recipientDeviceId: bobDevice, huddleId: ab, epoch: 2, createdAtMs: now, expiresAtMs: now + 100, payload: Uint8Array.of(7, 8), authentication: Uint8Array.of(9) };
  await runtime.enqueueCiphertext("alice", envelope);
  assert.equal((await runtime.takePending("bob")).length, 1);
  await runtime.acknowledge("bob", "message_ab");
  assert.equal((await runtime.takePending("bob")).length, 0);
  await assert.rejects(runtime.enqueueCiphertext("alice", { ...envelope, messageId: "cross_huddle", recipientAccountId: charlie, recipientDeviceId: charlieDevice }), hasCode("UNAUTHORIZED"));
});
function hasCode(code: RuntimeApiError["code"]): (error: unknown) => boolean { return (error) => error instanceof RuntimeApiError && error.code === code; }
