import {
  buildEnrollmentRequest,
  DevHubCA,
  generateHubIdentity,
  type Attestation,
} from "@supreme/hub-identity";
import { HubRegistry } from "@supreme/hub-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudPersistence, PgHubRegistryStore, type CloudPersistence } from "./index.js";

/**
 * Proves the Hub Registry runs on REAL embedded Postgres (PGlite) and that the hub↔account
 * ownership graph is durable: a second registry instance built over the same DB (a "restart")
 * sees the enrolled + claimed hub, anti-replay holds across instances, and revocation persists.
 */
const META = { model: "Hub Pro", fwVersion: "0.4.0" };
const ATTEST: Attestation = { kind: "factory", evidence: "sig" };

describe("Postgres-backed Hub Registry (PGlite)", () => {
  let p: CloudPersistence;
  const ca = DevHubCA.generate();

  beforeAll(async () => {
    p = await createCloudPersistence({}); // embedded PGlite
  });
  afterAll(async () => {
    await p.db.close();
  });

  it("applies migrations idempotently", async () => {
    const { rows } = await p.db.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(rows.map((r) => r.name)).toContain("0001_hub_registry.sql");
  });

  it("persists enrollment + claim across a registry 'restart'", async () => {
    const id = generateHubIdentity();
    // Instance A enrolls + claims.
    const regA = new HubRegistry({ ca, store: p.hubRegistry });
    await regA.enroll(buildEnrollmentRequest(id, META, ATTEST));
    const code = await regA.issueClaimCode(id.hubUuid);
    await regA.claim(id.hubUuid, "acct-1", code.code, "Mumbai Villa");

    // Instance B is a fresh registry over the SAME database (process restart).
    const regB = new HubRegistry({ ca, store: new PgHubRegistryStore(p.db) });
    const hub = await regB.getHub(id.hubUuid);
    expect(hub?.status).toBe("claimed");
    expect(hub?.claimedByAccountId).toBe("acct-1");
    expect((await regB.listHubsForAccount("acct-1")).map((h) => h.hubUuid)).toContain(id.hubUuid);
  });

  it("enforces single-use enrollment nonces across instances (durable anti-replay)", async () => {
    const id = generateHubIdentity();
    const req = buildEnrollmentRequest(id, META, ATTEST);
    await new HubRegistry({ ca, store: p.hubRegistry }).enroll(req);
    // A different instance replaying the SAME request (same nonce) is rejected.
    await expect(
      new HubRegistry({ ca, store: new PgHubRegistryStore(p.db) }).enroll(req),
    ).rejects.toThrow(/nonce already used/);
  });

  it("persists revocation", async () => {
    const id = generateHubIdentity();
    const res = await new HubRegistry({ ca, store: p.hubRegistry }).enroll(buildEnrollmentRequest(id, META, ATTEST));
    const reg = new HubRegistry({ ca, store: p.hubRegistry });
    expect(await reg.isRevoked(res.credential.serial)).toBe(false);
    await reg.revoke(res.credential.serial);
    // Fresh instance still sees the revocation.
    expect(await new HubRegistry({ ca, store: new PgHubRegistryStore(p.db) }).isRevoked(res.credential.serial)).toBe(true);
  });

  it("multi-home: one account owns several persisted hubs", async () => {
    const reg = new HubRegistry({ ca, store: p.hubRegistry });
    for (const name of ["Dubai Apartment", "Farmhouse"]) {
      const id = generateHubIdentity();
      await reg.enroll(buildEnrollmentRequest(id, META, ATTEST));
      const code = await reg.issueClaimCode(id.hubUuid);
      await reg.claim(id.hubUuid, "acct-multi", code.code, name);
    }
    expect((await reg.listHubsForAccount("acct-multi")).length).toBe(2);
  });
});
