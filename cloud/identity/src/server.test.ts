import { generateKeyPairSync } from "node:crypto";
import { AuthnService } from "@supreme/cloud-authn";
import { DeviceRegistry } from "@supreme/device-registry";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityService } from "./index.js";
import { buildIdentityServer } from "./server.js";

/**
 * End-to-end C1 proof for the identity plane: register → login (issues tokens + registers the
 * device) → manage devices → refresh-rotate → remote logout. Exercises the real HTTP surface.
 */
describe("Identity plane HTTP server", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const authn = new AuthnService({ publicKey, privateKey });
    app = buildIdentityServer({
      identity: new IdentityService(),
      authn,
      devices: new DeviceRegistry({ revokeSession: (sid) => authn.revokeSession(sid) }),
      logLevel: "silent",
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function registerAndLogin(value = "owner@supreme.io") {
    await app.inject({ method: "POST", url: "/v1/accounts", payload: { kind: "email", value, password: "s3cret-pass" } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { kind: "email", value, password: "s3cret-pass", device: { name: "Mujeeb's iPhone", platform: "ios" } },
    });
    return JSON.parse(res.payload) as { accessToken: string; refreshToken: string; sessionId: string; device: { id: string; name: string } };
  }

  it("registers an account and logs in, issuing tokens + a registered device", async () => {
    const out = await registerAndLogin();
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).toBeTruthy();
    expect(out.device.name).toBe("Mujeeb's iPhone");
  });

  it("publishes a JWKS", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/jwks" });
    expect(JSON.parse(res.payload).keys[0]).toMatchObject({ kty: "OKP", alg: "EdDSA" });
  });

  it("rejects login with a wrong password (401)", async () => {
    await app.inject({ method: "POST", url: "/v1/accounts", payload: { kind: "email", value: "a@b.com", password: "right" } });
    const res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { kind: "email", value: "a@b.com", password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("lists devices only with a valid access token", async () => {
    const s = await registerAndLogin();
    const unauth = await app.inject({ method: "GET", url: "/v1/devices" });
    expect(unauth.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/v1/devices", headers: { authorization: `Bearer ${s.accessToken}` } });
    expect((JSON.parse(ok.payload) as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it("rotates the refresh token and rejects reuse of the old one", async () => {
    const s = await registerAndLogin();
    const r1 = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    // Reusing the original refresh token is detected → 401.
    const reuse = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(reuse.statusCode).toBe(401);
  });

  it("remote-logout of a device revokes its session (its access token stops working)", async () => {
    // Two logins = two devices/sessions on one account.
    const a = await registerAndLogin("multi@supreme.io");
    const bRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { kind: "email", value: "multi@supreme.io", password: "s3cret-pass", device: { name: "Office Tablet", platform: "android" } },
    });
    const b = JSON.parse(bRes.payload) as { accessToken: string; device: { id: string } };

    // Device A remote-logs-out device B.
    const out = await app.inject({
      method: "POST",
      url: `/v1/devices/${b.device.id}/logout`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(out.statusCode).toBe(200);

    // B's access token no longer authorizes.
    const denied = await app.inject({ method: "GET", url: "/v1/devices", headers: { authorization: `Bearer ${b.accessToken}` } });
    expect(denied.statusCode).toBe(401);
  });

  it("renames and deletes a device", async () => {
    const s = await registerAndLogin();
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/devices/${s.device.id}`,
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { name: "Mujeeb iPhone 16 Pro" },
    });
    expect(JSON.parse(renamed.payload).name).toBe("Mujeeb iPhone 16 Pro");
    const del = await app.inject({ method: "DELETE", url: `/v1/devices/${s.device.id}`, headers: { authorization: `Bearer ${s.accessToken}` } });
    expect(del.statusCode).toBe(204);
  });
});
