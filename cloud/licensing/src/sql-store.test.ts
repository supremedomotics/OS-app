import { PGlite } from "@electric-sql/pglite";
import { generateSigningKeyPair } from "@supreme/crypto";
import { newId, type HomeId } from "@supreme/domain-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DealerLicensingService } from "./index.js";
import { SqlLicenseRecordStore, type LicensingSqlExecutor } from "./sql-store.js";

/**
 * The dealer ledger on the Postgres-backed store (PGlite in tests): issued/activated/transferred
 * records survive a "restart" (a fresh service over the same DB), features round-trip, and org
 * scoping is enforced at the SQL layer.
 */
describe("SqlLicenseRecordStore (PGlite)", () => {
  let pg: PGlite;
  let store: SqlLicenseRecordStore;
  let privateKey: string;

  beforeAll(async () => {
    pg = new PGlite();
    const exec: LicensingSqlExecutor = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await pg.query(sql, params);
        return { rows: (res as { rows: T[] }).rows };
      },
      exec: async (sql: string) => {
        await pg.exec(sql);
      },
    };
    store = new SqlLicenseRecordStore(exec);
    await store.init();
    privateKey = generateSigningKeyPair().privateKey;
  });
  afterAll(async () => {
    await pg.close();
  });

  it("persists issue → activate → transfer across a fresh service instance", async () => {
    const svc = new DealerLicensingService(store, privateKey);
    const oldHome = newId("home") as HomeId;
    const { license } = await svc.issue({
      dealerOrgId: "org_acme",
      homeId: oldHome,
      sku: "estate",
      seats: 8,
      features: ["energy", "cameras"],
    });
    await svc.markActivated(license.id);

    // Fresh service over the same DB (simulates a licensing API restart).
    const restarted = new DealerLicensingService(store, privateKey);
    expect(await restarted.seatsInUse("org_acme")).toBe(8);

    const newHome = newId("home") as HomeId;
    const { record } = await restarted.transfer(license.id, newHome);
    expect(record.supersedes).toBe(license.id);
    expect(record.features).toEqual(["energy", "cameras"]); // features round-trip through SQL
    // Old license transferred → its seats freed; new one not yet activated.
    expect(await restarted.seatsInUse("org_acme")).toBe(0);

    const history = await restarted.history("org_acme");
    expect(history).toHaveLength(2);
    // A different org sees nothing (SQL-level scoping).
    expect(await restarted.history("org_other")).toHaveLength(0);
  });
});
