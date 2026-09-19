import assert from "node:assert/strict";
import test from "node:test";
import {
  E2eeAuthenticationError,
  generateStaticDeviceIdentity,
  StaticWebCryptoE2eeProvider,
} from "./index.js";
import { webcrypto } from "node:crypto";
import type { webcrypto as NodeWebCrypto } from "node:crypto";

test("encrypts between device identities and rejects a tampered ciphertext or associated data", async () => {
  const cryptoApi = webcrypto as NodeWebCrypto.Crypto;
  const alice = await generateStaticDeviceIdentity(cryptoApi);
  const bob = await generateStaticDeviceIdentity(cryptoApi);
  const context = new TextEncoder().encode("canonical-context");
  const aliceSession = await new StaticWebCryptoE2eeProvider({ crypto: cryptoApi, localIdentity: alice }).initializeSession({
    huddleId: "huddle", localDeviceId: "alice", remoteDeviceId: "bob", remoteIdentityPublicKey: bob.publicKey, authenticatedContext: context,
  });
  const bobSession = await new StaticWebCryptoE2eeProvider({ crypto: cryptoApi, localIdentity: bob }).initializeSession({
    huddleId: "huddle", localDeviceId: "bob", remoteDeviceId: "alice", remoteIdentityPublicKey: alice.publicKey, authenticatedContext: context,
  });
  const sealed = await aliceSession.encrypt(new TextEncoder().encode("test message"), context);
  assert.equal(new TextDecoder().decode(await bobSession.decrypt(sealed, context)), "test message");
  sealed[sealed.length - 1]! ^= 1;
  await assert.rejects(bobSession.decrypt(sealed, context), E2eeAuthenticationError);
});
