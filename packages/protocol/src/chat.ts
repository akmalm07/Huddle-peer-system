import { z } from "zod";
import { decodeCanonicalCborWithSchema, encodeCanonicalCbor } from "./cbor.js";
import { decodeBoundedFrame, encodeBoundedFrame } from "./frame.js";
import { TRANSPORT_LIMITS } from "./limits.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Public routing header for an encrypted application message. The payload is
 * AES-GCM ciphertext; every other field is authenticated associated data.
 */
const ChatHeaderSchema = z.object({
  protocolVersion: z.literal(1),
  messageType: z.literal("application"),
  messageId: id,
  senderAccountId: id,
  senderDeviceId: id,
  recipientAccountId: id,
  recipientDeviceId: id,
  huddleId: id,
  epoch: z.number().int().nonnegative().max(2_147_483_647),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs) context.addIssue({ code: "custom", message: "expiry must be after creation" });
});

export const EncryptedChatMessageSchema = ChatHeaderSchema.extend({
  ciphertext: z.instanceof(Uint8Array).refine((value) => value.byteLength >= 29 && value.byteLength <= TRANSPORT_LIMITS.maximumApplicationPayloadBytes + 28),
});

export type EncryptedChatMessage = z.infer<typeof EncryptedChatMessageSchema>;

export class ChatProtocolError extends Error {
  public constructor(public readonly code: "CHAT_MESSAGE_INVALID" | "CHAT_MESSAGE_EXPIRED" | "CHAT_FRAME_INVALID") {
    super(code);
    this.name = "ChatProtocolError";
  }
}

/** Canonical bytes bound into AES-GCM; never replace with JSON serialization. */
export function chatAssociatedData(message: Omit<EncryptedChatMessage, "ciphertext">): Uint8Array {
  const parsed = ChatHeaderSchema.safeParse(message);
  if (!parsed.success) throw new ChatProtocolError("CHAT_MESSAGE_INVALID");
  return encodeCanonicalCbor(parsed.data);
}

/** Encodes the full encrypted envelope as a bounded binary WebRTC frame. */
export function encodeEncryptedChatFrame(message: EncryptedChatMessage): Uint8Array {
  const parsed = EncryptedChatMessageSchema.safeParse(message);
  if (!parsed.success) throw new ChatProtocolError("CHAT_MESSAGE_INVALID");
  try {
    return encodeBoundedFrame(encodeCanonicalCbor(parsed.data));
  } catch {
    throw new ChatProtocolError("CHAT_FRAME_INVALID");
  }
}

/** Decodes and validates an encrypted message before a caller attempts decrypt. */
export function decodeEncryptedChatFrame(frame: Uint8Array, nowMs: number): EncryptedChatMessage {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ChatProtocolError("CHAT_MESSAGE_INVALID");
  try {
    const parsed = decodeCanonicalCborWithSchema(decodeBoundedFrame(frame), EncryptedChatMessageSchema);
    if (parsed.expiresAtMs <= nowMs) throw new ChatProtocolError("CHAT_MESSAGE_EXPIRED");
    return parsed;
  } catch (error) {
    if (error instanceof ChatProtocolError) throw error;
    throw new ChatProtocolError("CHAT_FRAME_INVALID");
  }
}
