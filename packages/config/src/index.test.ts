import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, loadServiceConfig } from "./index.js";

const validEnvironment = {
  EXPERIMENTAL_DEVICE_FALLBACK: "false",
  HUDDLE_ALLOWED_ORIGIN: "https://huddle.example.test/path-is-not-an-origin",
  HUDDLE_AUTH_PORT: "4001",
  HUDDLE_SIGNALING_PORT: "4002",
};

test("normalizes a valid public origin and keeps experimental fallback off", () => {
  const config = loadServiceConfig(validEnvironment, "auth");
  assert.equal(config.allowedOrigin, "https://huddle.example.test");
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 4001);
  assert.equal(config.featureFlags.experimentalDeviceFallback, false);
});

test("rejects invalid ports, non-HTTP origins, and attempts to enable the fallback queue", () => {
  assert.throws(() => loadServiceConfig({ ...validEnvironment, HUDDLE_AUTH_PORT: "0" }, "auth"), isConfigurationError);
  assert.throws(() => loadServiceConfig({ ...validEnvironment, HUDDLE_ALLOWED_ORIGIN: "file:///tmp" }, "auth"), isConfigurationError);
  assert.throws(() => loadServiceConfig({ ...validEnvironment, EXPERIMENTAL_DEVICE_FALLBACK: "true" }, "auth"), isConfigurationError);
});

test("accepts bounded public ICE endpoints but rejects static relay credentials", () => {
  const config = loadServiceConfig({
    ...validEnvironment,
    HUDDLE_ICE_SERVERS: '[{"urls":["stun:stun.example.test:3478"]},{"urls":["turns:turn.example.test:5349"]}]',
  }, "signaling");
  assert.equal(config.iceServers.length, 2);
  assert.throws(() => loadServiceConfig({
    ...validEnvironment,
    HUDDLE_ICE_SERVERS: '[{"urls":["turn:turn.example.test"],"username":"static"}]',
  }, "signaling"), isConfigurationError);
});

test("permits an explicit container bind address only", () => {
  assert.equal(loadServiceConfig({ ...validEnvironment, HUDDLE_BIND_HOST: "0.0.0.0" }, "signaling").bindHost, "0.0.0.0");
  assert.throws(() => loadServiceConfig({ ...validEnvironment, HUDDLE_BIND_HOST: "example.test" }, "signaling"), isConfigurationError);
});

function isConfigurationError(error: unknown): boolean {
  return error instanceof ConfigurationError && error.code === "CONFIG_INVALID";
}
