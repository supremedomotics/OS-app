import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BackupVaultError, BackupVaultService } from "./index.js";
import { buildBackupServer } from "./server.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("BackupVaultService", () => {
  it("stores, lists (newest first), and fetches an encrypted blob", async () => {
    let t = 1000;
    const vault = new BackupVaultService({ now: () => t });
    const c1 = Buffer.from("ciphertext-1");
    t = 1000;
    const r1 = await vault.store({ homeId: "h1", ciphertext: c1, schemaVersion: "9" });
    t = 2000;
    const r2 = await vault.store({ homeId: "h1", ciphertext: Buffer.from("ciphertext-2") });
    expect(r1.sha256).toBe(sha(c1));
    expect(vault.list("h1").map((r) => r.id)).toEqual([r2.id, r1.id]); // newest first
    const fetched = await vault.fetch("h1", r1.id);
    expect(fetched.ciphertext.toString()).toBe("ciphertext-1");
  });

  it("rejects a corrupted upload (digest mismatch) and an empty backup", async () => {
    const vault = new BackupVaultService();
    await expect(vault.store({ homeId: "h1", ciphertext: Buffer.from("x"), expectedSha256: "deadbeef" })).rejects.toThrow(/digest mismatch/);
    await expect(vault.store({ homeId: "h1", ciphertext: Buffer.alloc(0) })).rejects.toThrow(/empty/);
  });

  it("enforces per-home retention, pruning the oldest", async () => {
    let t = 0;
    const vault = new BackupVaultService({ retention: 2, now: () => (t += 1000) });
    const a = await vault.store({ homeId: "h1", ciphertext: Buffer.from("a") });
    const b = await vault.store({ homeId: "h1", ciphertext: Buffer.from("b") });
    const c = await vault.store({ homeId: "h1", ciphertext: Buffer.from("c") });
    expect(vault.list("h1").map((r) => r.id)).toEqual([c.id, b.id]); // oldest (a) pruned
    await expect(vault.fetch("h1", a.id)).rejects.toThrow(BackupVaultError);
  });

  it("isolates homes", async () => {
    const vault = new BackupVaultService();
    const a = await vault.store({ homeId: "h1", ciphertext: Buffer.from("a") });
    await vault.store({ homeId: "h2", ciphertext: Buffer.from("b") });
    expect(vault.list("h2").some((r) => r.id === a.id)).toBe(false);
    await expect(vault.fetch("h2", a.id)).rejects.toThrow(/not found/);
  });
});

describe("Backup vault HTTP API", () => {
  let app: FastifyInstance;
  const auth = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
  beforeAll(async () => {
    app = buildBackupServer({ apiKeys: new Map([["hub-a", "home-a"], ["hub-b", "home-b"]]), logLevel: "silent" });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("rejects missing/invalid API keys", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/backups" })).statusCode).toBe(401);
  });

  it("round-trips an upload → list → download", async () => {
    const cipher = Buffer.from("encrypted-bytes").toString("base64");
    const up = await app.inject({ method: "POST", url: "/v1/backups", headers: auth("hub-a"), payload: { ciphertext: cipher, schemaVersion: "9" } });
    expect(up.statusCode).toBe(201);
    const id = up.json().backup.id;
    const list = await app.inject({ method: "GET", url: "/v1/backups", headers: auth("hub-a") });
    expect(list.json().backups).toHaveLength(1);
    const dl = await app.inject({ method: "GET", url: `/v1/backups/${id}`, headers: auth("hub-a") });
    expect(dl.json().ciphertext).toBe(cipher);
  });

  it("forbids reading another home's backup", async () => {
    const up = await app.inject({ method: "POST", url: "/v1/backups", headers: auth("hub-a"), payload: { ciphertext: Buffer.from("x").toString("base64") } });
    const id = up.json().backup.id;
    const cross = await app.inject({ method: "GET", url: `/v1/backups/${id}`, headers: { authorization: "Bearer hub-b" } });
    expect(cross.statusCode).toBe(404);
  });

  it("deletes a backup", async () => {
    const up = await app.inject({ method: "POST", url: "/v1/backups", headers: auth("hub-b"), payload: { ciphertext: Buffer.from("y").toString("base64") } });
    const id = up.json().backup.id;
    const bearer = { authorization: "Bearer hub-b" }; // no content-type — DELETE/GET carry no body
    expect((await app.inject({ method: "DELETE", url: `/v1/backups/${id}`, headers: bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/backups/${id}`, headers: bearer })).statusCode).toBe(404);
  });
});
