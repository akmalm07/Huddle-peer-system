import assert from "node:assert/strict";
import test from "node:test";
import { HuddleSdkError, InMemoryHuddleSdk, accountId, deviceId, huddleId } from "./index.js";

const alice = accountId("alice");
const bob = accountId("bob");
const aliceLaptop = deviceId("alice_laptop");
const bobPhone = deviceId("bob_phone");

function fixture(): InMemoryHuddleSdk {
  const sdk = new InMemoryHuddleSdk();
  sdk.createAccount({ id: alice, username: "alice", createdAtMs: 1 });
  sdk.createAccount({ id: bob, username: "bob", createdAtMs: 1 });
  sdk.registerDevice(alice, { id: aliceLaptop, publicIdentityKey: Uint8Array.of(1), fingerprint: "a".repeat(64), createdAtMs: 2 });
  sdk.registerDevice(bob, { id: bobPhone, publicIdentityKey: Uint8Array.of(2), fingerprint: "b".repeat(64), createdAtMs: 2 });
  return sdk;
}

test("models independently authorized devices and rejects a revoked device", () => {
  const sdk = fixture();
  const phone = deviceId("alice_phone");
  sdk.registerDevice(alice, { id: phone, publicIdentityKey: Uint8Array.of(3), fingerprint: "c".repeat(64), createdAtMs: 3 });
  assert.equal(sdk.listDevices(alice).length, 2);
  sdk.revokeDevice({ accountId: alice, deviceId: aliceLaptop }, phone, 4);
  assert.throws(() => sdk.createHuddle({ accountId: alice, deviceId: phone }, huddleId("blocked"), 5), hasCode("DEVICE_REVOKED"));
  assert.equal(sdk.createHuddle({ accountId: alice, deviceId: aliceLaptop }, huddleId("open"), 5).epoch, 1);
});

test("authorizes bounded ephemeral signaling and drops expired events", () => {
  const sdk = fixture();
  const room = huddleId("room");
  sdk.createHuddle({ accountId: alice, deviceId: aliceLaptop }, room, 3);
  sdk.addMember({ accountId: alice, deviceId: aliceLaptop }, bob, room);
  sdk.submitTestSignal({ accountId: alice, deviceId: aliceLaptop }, {
    protocolVersion: 1, signalId: "offer_1", huddleId: room, connectionId: "conn_1", senderDeviceId: aliceLaptop,
    recipientAccountId: bob, recipientDeviceId: bobPhone, kind: "offer", body: Uint8Array.of(9), createdAtMs: 10, expiresAtMs: 20,
  });
  assert.equal(sdk.takeTestSignals({ accountId: bob, deviceId: bobPhone }, 15).length, 1);
  assert.equal(sdk.takeTestSignals({ accountId: bob, deviceId: bobPhone }, 21).length, 0);
});

test("rejects cross-huddle signaling and the legacy unframed send entry point", () => {
  const sdk = fixture();
  const room = huddleId("room");
  sdk.createHuddle({ accountId: alice, deviceId: aliceLaptop }, room, 3);
  assert.throws(() => sdk.submitTestSignal({ accountId: alice, deviceId: aliceLaptop }, {
    protocolVersion: 1, signalId: "offer_1", huddleId: room, connectionId: "conn_1", senderDeviceId: aliceLaptop,
    recipientAccountId: bob, recipientDeviceId: bobPhone, kind: "offer", body: Uint8Array.of(9), createdAtMs: 10, expiresAtMs: 20,
  }), hasCode("ACTOR_NOT_AUTHORIZED"));
  assert.throws(() => sdk.sendMessage(), hasCode("CONTENT_DISABLED"));
});

test("rejects a ninth active device from the direct mesh", () => {
  const sdk = fixture();
  const room = huddleId("room");
  sdk.createHuddle({ accountId: alice, deviceId: aliceLaptop }, room, 3);
  sdk.addMember({ accountId: alice, deviceId: aliceLaptop }, bob, room);
  for (let index = 0; index < 7; index += 1) {
    const member = accountId(`member_${index}`);
    const memberDevice = deviceId(`member_device_${index}`);
    sdk.createAccount({ id: member, username: `member${index}`, createdAtMs: 3 });
    sdk.registerDevice(member, { id: memberDevice, publicIdentityKey: Uint8Array.of(index), fingerprint: `${index}`.repeat(64), createdAtMs: 3 });
    sdk.addMember({ accountId: alice, deviceId: aliceLaptop }, member, room);
  }
  assert.throws(() => sdk.submitTestSignal({ accountId: alice, deviceId: aliceLaptop }, {
    protocolVersion: 1, signalId: "offer_2", huddleId: room, connectionId: "conn_2", senderDeviceId: aliceLaptop,
    recipientAccountId: bob, recipientDeviceId: bobPhone, kind: "offer", body: Uint8Array.of(1), createdAtMs: 10, expiresAtMs: 20,
  }), hasCode("DIRECT_MESH_CAPACITY_EXCEEDED"));
});

function hasCode(code: HuddleSdkError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof HuddleSdkError && error.code === code;
}
