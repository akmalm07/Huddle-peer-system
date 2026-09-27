import assert from "node:assert/strict";
import test from "node:test";
import { ChatProtocolError, chatAssociatedData, decodeEncryptedChatFrame, encodeEncryptedChatFrame } from "./chat.js";

const message = Object.freeze({
  protocolVersion: 1 as const, messageType: "application" as const, messageId: "message_a",
  senderAccountId: "alice", senderDeviceId: "alice_browser", recipientAccountId: "bob", recipientDeviceId: "bob_browser",
  huddleId: "huddle_a", epoch: 1, createdAtMs: 100, expiresAtMs: 200, ciphertext: Uint8Array.of(1, ...new Array(28).fill(2)),
});

test("round trips a bounded encrypted chat frame and binds routing metadata", () => {
  const decoded = decodeEncryptedChatFrame(encodeEncryptedChatFrame(message), 150);
  assert.deepEqual(decoded, message);
  const { ciphertext: _ciphertext, ...header } = message;
  assert.notDeepEqual(chatAssociatedData({ ...header, recipientDeviceId: "mallory" }), chatAssociatedData(header));
});

test("rejects expired chat frames before decryption", () => {
  assert.throws(() => decodeEncryptedChatFrame(encodeEncryptedChatFrame(message), 200), (error: unknown) => error instanceof ChatProtocolError && error.code === "CHAT_MESSAGE_EXPIRED");
});
