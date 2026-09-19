import assert from "node:assert/strict";
import test from "node:test";
import { FirebaseControlPlaneAdapter, type FirebaseValue, type FirebaseWritePort } from "./index.js";
import { accountId, deviceId, huddleId, type TestSignal } from "@huddle/sdk";

test("maps public metadata and bounded signaling without logging or content paths", async () => {
  const writes: Array<{ readonly path: string; readonly value: FirebaseValue }> = [];
  const port: FirebaseWritePort = {
    setFirestore: async (path, value) => { writes.push({ path, value }); },
    setRealtime: async (path, value) => { writes.push({ path, value }); },
  };
  const adapter = new FirebaseControlPlaneAdapter(port);
  const account = accountId("alice");
  const device = deviceId("alice_device");
  const recipient = deviceId("bob_device");
  await adapter.saveDevice({ id: device, accountId: account, publicIdentityKey: Uint8Array.of(1), fingerprint: "a".repeat(64), status: "active", createdAtMs: 1 });
  const signal: TestSignal = {
    protocolVersion: 1, signalId: "signal_1", huddleId: huddleId("room"), connectionId: "connection_1",
    senderDeviceId: device, recipientAccountId: accountId("bob"), recipientDeviceId: recipient, kind: "offer",
    body: Uint8Array.of(1, 2), createdAtMs: 10, expiresAtMs: 20,
  };
  await adapter.publishTestSignal({ accountId: account, deviceId: device }, signal);
  assert.equal(writes[0]?.path, "devices/alice_device");
  assert.equal(writes[1]?.path, "signaling/room/bob_device/signal_1");
  assert.equal(JSON.stringify(writes[1]?.value).includes("AQI="), true);
});
