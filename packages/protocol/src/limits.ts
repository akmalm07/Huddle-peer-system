/**
 * Transport allocation limits, not cryptographic parameters. Values are
 * deliberately conservative for the initial two-browser vertical slice.
 */
export const TRANSPORT_LIMITS = Object.freeze({
  maximumFrameBytes: 64 * 1024,
  maximumApplicationPayloadBytes: 16 * 1024,
  maximumActiveMeshDevices: 8,
  maximumPendingNegotiationsPerDevice: 4,
  maximumIceCandidatesPerNegotiation: 64,
  maximumOutboxEntriesPerRecipient: 100,
  maximumRetryAttempts: 8,
} as const);

export type TransportLimitName = keyof typeof TRANSPORT_LIMITS;
