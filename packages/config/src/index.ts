import { z } from "zod";

export interface FeatureFlags {
  readonly experimentalDeviceFallback: false;
  readonly peerStore: false;
  readonly ciphertextForwarder: false;
}

/** Features without their reviewed implementations are hard-disabled. */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.freeze({
  experimentalDeviceFallback: false,
  peerStore: false,
  ciphertextForwarder: false,
});

const portSchema = z.coerce.number().int().min(1).max(65_535);
const originSchema = z.url().refine((value) => new URL(value).protocol === "http:" || new URL(value).protocol === "https:", {
  message: "must be an HTTP(S) origin",
});
const falseOnlySchema = z.literal("false");

export interface ServiceConfig {
  readonly port: number;
  readonly bindHost: "127.0.0.1" | "0.0.0.0";
  readonly allowedOrigin: string;
  /** Public STUN/TURN URLs only. Short-lived TURN credentials are fetched at runtime. */
  readonly iceServers: readonly IceServerConfig[];
  readonly featureFlags: FeatureFlags;
}

export interface IceServerConfig {
  readonly urls: readonly string[];
}

/** Parses only non-secret service configuration. Secret-bearing connection strings stay opaque. */
export function loadServiceConfig(
  environment: Readonly<Record<string, string | undefined>>,
  service: "auth" | "signaling",
): ServiceConfig {
  const result = z.object({
    HUDDLE_ALLOWED_ORIGIN: originSchema,
    HUDDLE_AUTH_PORT: portSchema.default(4001),
    HUDDLE_BIND_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    HUDDLE_SIGNALING_PORT: portSchema.default(4002),
    HUDDLE_ICE_SERVERS: z.string().default("[]"),
    EXPERIMENTAL_DEVICE_FALLBACK: falseOnlySchema.default("false"),
  }).safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError("CONFIG_INVALID");
  }
  const iceServers = parseIceServers(result.data.HUDDLE_ICE_SERVERS);
  return Object.freeze({
    port: service === "auth" ? result.data.HUDDLE_AUTH_PORT : result.data.HUDDLE_SIGNALING_PORT,
    bindHost: result.data.HUDDLE_BIND_HOST,
    allowedOrigin: new URL(result.data.HUDDLE_ALLOWED_ORIGIN).origin,
    iceServers,
    featureFlags: DEFAULT_FEATURE_FLAGS,
  });
}

/** Parses publicly routable ICE endpoints without accepting reusable TURN credentials. */
export function parseIceServers(value: string): readonly IceServerConfig[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new ConfigurationError("CONFIG_INVALID");
  }
  const parsed = z.array(z.object({
    urls: z.array(z.string().refine((url) => /^(stun|turn|turns):[^\s]+$/i.test(url))).min(1).max(4),
  }).strict()).max(8).safeParse(candidate);
  if (!parsed.success) throw new ConfigurationError("CONFIG_INVALID");
  return Object.freeze(parsed.data.map((server) => Object.freeze({ urls: Object.freeze([...server.urls]) })));
}

export class ConfigurationError extends Error {
  public constructor(public readonly code: "CONFIG_INVALID") {
    super(code);
    this.name = "ConfigurationError";
  }
}
