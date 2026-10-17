import { describe, expect, it } from "vitest";
import { deriveDeviceAuthenticationCode, deriveSessionKey, deriveUserPasswordHash, ecdhPublicFromPrivate, ecdhSharedSecret, passwordSecret, SALT_DEVICE_AUTHENTICATION_CODE, SALT_USER_PASSWORD } from "./ip-keys.js";
import { Secret } from "../security/secret.js";
import { hasVectors, v, vs } from "./spec-vectors.js";

describe.skipIf(!hasVectors)("IP Secure key derivation vs the specification's worked examples (IPS Annex A, §2.3.1.3/4)", () => {
  it("salts are exactly the strings printed in the specification", () => {
    expect(SALT_DEVICE_AUTHENTICATION_CODE).toBe(vs("salt_device_authentication_code"));
    expect(SALT_USER_PASSWORD).toBe(vs("salt_user_password"));
  });
  it("A.2.2: Device Authentication Code from \"trustme\"", async () => {
    const dac = await deriveDeviceAuthenticationCode(passwordSecret(vs("a2_device_auth_password")));
    expect(dac.use((b) => b.toString("hex"))).toBe(v("a2_device_auth_code").toString("hex"));
  });
  it("A.3.1: password hash from \"secret\"", async () => {
    const h = await deriveUserPasswordHash(passwordSecret(vs("a3_password")));
    expect(h.use((b) => b.toString("hex"))).toBe(v("a3_password_hash").toString("hex"));
  });
  it("§2.3.1.4.3: the empty password has the fixed hash printed in the specification", async () => {
    const h = await deriveUserPasswordHash(passwordSecret(""));
    expect(h.use((b) => b.toString("hex"))).toBe(vs("empty_password_hash"));
  });
  it("A.1/A.2: public values follow from the example private keys; both sides compute the printed shared secret and session key", () => {
    const xPriv = new Secret(v("a1_client_private")), yPriv = new Secret(v("a2_server_private"));
    expect(ecdhPublicFromPrivate(xPriv).toString("hex")).toBe(v("a1_client_public_X").toString("hex"));
    expect(ecdhPublicFromPrivate(yPriv).toString("hex")).toBe(v("a2_server_public_Y").toString("hex"));
    expect(ecdhSharedSecret(xPriv, v("a2_server_public_Y")).use((b) => b.toString("hex"))).toBe(v("a2_ecdh_shared_secret").toString("hex"));
    expect(ecdhSharedSecret(yPriv, v("a1_client_public_X")).use((b) => b.toString("hex"))).toBe(v("a2_ecdh_shared_secret").toString("hex"));
    expect(deriveSessionKey(xPriv, v("a2_server_public_Y")).use((b) => b.toString("hex"))).toBe(v("a2_session_key").toString("hex"));
    expect(deriveSessionKey(yPriv, v("a1_client_public_X")).use((b) => b.toString("hex"))).toBe(v("a2_session_key").toString("hex"));
  });
});
