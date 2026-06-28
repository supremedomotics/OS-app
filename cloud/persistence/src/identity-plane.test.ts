import { generateKeyPairSync } from "node:crypto";
import { AuthnService } from "@supreme/cloud-authn";
import { DeviceRegistry } from "@supreme/device-registry";
import { IdentityService } from "@supreme/cloud-identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCloudPersistence,
  PgAuthnStore,
  PgDeviceStore,
  PgIdentityStore,
  type CloudPersistence,
} from "./index.js";

/**
 * Proves the identity plane runs on REAL embedded Postgres (PGlite) and survives a "restart":
 * accounts, refresh-token rotation/reuse-detection, and devices all persist when a fresh service
 * is built over the same DB — so a cloud redeploy doesn't log everyone out or forget their
 * devices. This is the pilot-blocking durability gap, closed.
 */
describe("Identity plane persistence (PGlite)", () => {
  let p: CloudPersistence;
  beforeAll(async () => {
    p = await createCloudPersistence({});
  });
  afterAll(async () => {
    await p.db.close();
  });

  it("applies the identity-plane migration", async () => {
    const { rows } = await p.db.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(rows.map((r) => r.name)).toContain("0002_identity_plane.sql");
  });

  it("persists an account + password across a restart", async () => {
    const a = new IdentityService({ store: p.identity });
    const { account } = await a.register({ kind: "email", value: "Owner@Supreme.io", password: "s3cret-pass" });

    // Fresh service over the same DB (process restart) — login still works, case-insensitively.
    const b = new IdentityService({ store: new PgIdentityStore(p.db) });
    expect(await b.verifyPassword("email", "owner@supreme.io", "s3cret-pass")).toBe(account.id);
    await expect(b.verifyPassword("email", "owner@supreme.io", "wrong")).rejects.toThrow(/invalid/);
  });

  it("persists federated linking + passkeys across a restart", async () => {
    const a = new IdentityService({ store: p.identity });
    const fed = await a.upsertFederated({ provider: "apple", subject: "apple-1", email: "z@icloud.com" });
    await a.registerPasskey(fed.account.id, { credentialId: "cred-1", publicKey: "pk", name: "Face ID" });

    const b = new IdentityService({ store: new PgIdentityStore(p.db) });
    const again = await b.upsertFederated({ provider: "apple", subject: "apple-1" });
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(fed.account.id);
    expect(await b.listPasskeys(fed.account.id)).toHaveLength(1);
  });

  it("persists refresh-token rotation + reuse-detection across a restart", async () => {
    const keys = generateKeyPairSync("ed25519");
    const authnA = new AuthnService({ ...keys, store: p.authn });
    const a = await authnA.startSession({ accountId: "acct-1", deviceId: "dev-1", amr: ["pwd"] });

    // A fresh AuthN instance over the same DB rotates the refresh token…
    const authnB = new AuthnService({ ...keys, store: new PgAuthnStore(p.db) });
    const b = await authnB.refresh({ refreshToken: a.refreshToken });
    expect(b.refreshToken).not.toBe(a.refreshToken);

    // …and reuse of the original token is still detected (durable rotation chain).
    await expect(authnB.refresh({ refreshToken: a.refreshToken })).rejects.toMatchObject({ code: "reuse_detected" });
    // The legitimately-rotated token is now dead too (family revoked + persisted).
    await expect(
      new AuthnService({ ...keys, store: new PgAuthnStore(p.db) }).refresh({ refreshToken: b.refreshToken }),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("persists remote logout: a revoked session stays revoked after a restart", async () => {
    const keys = generateKeyPairSync("ed25519");
    const authn = new AuthnService({ ...keys, store: p.authn });
    const s = await authn.startSession({ accountId: "acct-2", deviceId: "dev-2", amr: ["pwd"] });
    await authn.revokeSession(s.sessionId);

    const fresh = new AuthnService({ ...keys, store: new PgAuthnStore(p.db) });
    await expect(fresh.verifyAccess(s.accessToken)).rejects.toMatchObject({ code: "revoked" });
  });

  it("persists devices + remote logout wiring across a restart", async () => {
    const keys = generateKeyPairSync("ed25519");
    const authn = new AuthnService({ ...keys, store: p.authn });
    const devices = new DeviceRegistry({ store: p.devices, revokeSession: (sid) => authn.revokeSession(sid) });
    const session = await authn.startSession({ accountId: "acct-3", deviceId: "x", amr: ["pwd"] });
    const device = await devices.register({ accountId: "acct-3", name: "Mujeeb's iPhone", platform: "ios", sessionId: session.sessionId });

    // Fresh registry over the same DB still lists the device.
    const reg2 = new DeviceRegistry({ store: new PgDeviceStore(p.db) });
    expect((await reg2.list("acct-3")).some((d) => d.id === device.id)).toBe(true);

    // Remote logout revokes the session, durably.
    await devices.remoteLogout("acct-3", device.id);
    const fresh = new AuthnService({ ...keys, store: new PgAuthnStore(p.db) });
    await expect(fresh.verifyAccess(session.accessToken)).rejects.toMatchObject({ code: "revoked" });
  });
});
