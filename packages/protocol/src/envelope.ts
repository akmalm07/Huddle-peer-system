import { z } from "zod";
import { TRANSPORT_LIMITS } from "./limits.js";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Structural validation only. A successfully parsed envelope has not been
 * authenticated or authorized and must never cause a state transition by itself.
 */
export const ProtocolEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  messageType: z.enum(["application", "ack", "webrtc-signal"]),
  messageId: opaqueId,
  senderAccountId: opaqueId,
  senderDeviceId: opaqueId,
  recipientAccountId: opaqueId,
  recipientDeviceId: opaqueId,
  huddleId: opaqueId,
  epoch: z.number().int().nonnegative().max(2_147_483_647),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
  payload: z.instanceof(Uint8Array).refine((value) => value.byteLength <= TRANSPORT_LIMITS.maximumApplicationPayloadBytes),
  /** Future provider output; it is opaque and cannot be trusted until verified. */
  authentication: z.instanceof(Uint8Array).refine((value) => value.byteLength >= 1 && value.byteLength <= 16_384),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs) {
    context.addIssue({ code: "custom", message: "expiry must be after creation" });
  }
});

export type UnauthenticatedProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;

export class ProtocolEnvelopeError extends Error {
  public constructor(public readonly code: "ENVELOPE_INVALID") {
    super(code);
    this.name = "ProtocolEnvelopeError";
  }
}

export function parseUnauthenticatedEnvelope(value: unknown): UnauthenticatedProtocolEnvelope {
  const parsed = ProtocolEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolEnvelopeError("ENVELOPE_INVALID");
  }
  return parsed.data;
}
