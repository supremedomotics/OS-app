import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { IdentityService } from "@supreme/identity";
import { createPersistence, PgliteDb, migrate, buildStores } from "@supreme/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, signBackup, verifyBackup } from "./index.js";

let dbs: PgliteDb[] = [];
afterEach(async () => {
  for (const db of dbs) await db.close();
  dbs = [];
});

async function freshDb() {
  const db = await PgliteDb.create();
  await migrate(db);
  dbs.push(db);
  return db;
}

describe("backup/restore", () => {
  it("captures a signed backup and restores it into a fresh database", async () => {
    // Source hub: commission + a user.
    const src = await freshDb();
    const srcStores = buildStores(src);
    const identity = new IdentityService({ tokenSecret: "x".repeat(40), store: srcStores.identity });
    const { home, master } = await identity.commission({
      homeName: "Estate",
      email: "owner@example.com",
      password: "a-strong-demo-password",
      displayName: "Owner",
    });

    const { publicKey, privateKey } = generateSigningKeyPair();
    const signed = signBackup(await createBackup(src), privateKey);
    expect(verifyBackup(signed, publicKey)).toBe(true);
    expect(signed.bundle.tables.homes).toHaveLength(1);

    // Restore into a brand-new hub DB and confirm the user/home came across.
    const dst = await freshDb();
    const result = await restoreBackup(dst, signed, { publicKeyPem: publicKey });
    expect(result.rows).toBeGreaterThan(0);

    const dstStores = buildStores(dst);
    const restored = new IdentityService({ tokenSecret: "x".repeat(40), store: dstStores.identity });
    const fetched = await restored.getUser(master.id);
    expect(fetched.email).toBe("owner@example.com");
    const restoredHome = await dstStores.home.getHome();
    expect(restoredHome?.id).toBe(home.id);
    // Credentials restored → login still works on the new hub.
    const login = await restored.login("owner@example.com", "a-strong-demo-password");
    expect(login.status).toBe("ok");
  });

  it("refuses to restore a backup with a bad signature", async () => {
    const src = await freshDb();
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    const signed = signBackup(await createBackup(src), a.privateKey);
    const dst = await freshDb();
    await expect(restoreBackup(dst, signed, { publicKeyPem: b.publicKey })).rejects.toThrow(/signature/);
  });
});
