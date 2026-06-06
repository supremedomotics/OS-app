import { PGlite } from "@electric-sql/pglite";
import type { HomeId } from "@supreme/domain-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FleetService } from "./index.js";
import { SqlFleetStore, type FleetSqlExecutor } from "./sql-store.js";

/**
 * The cloud fleet registry on the Postgres-backed store (PGlite in tests): a
 * registered hub + its heartbeats survive a "restart" (a fresh service over the same
 * DB), and org scoping is enforced at the SQL layer.
 */
describe("SqlFleetStore (PGlite)", () => {
  let pg: PGlite;
  let exec: FleetSqlExecutor;
  let store: SqlFleetStore;

  beforeAll(async () => {
    pg = new PGlite();
    exec = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await pg.query(sql, params);
        return { rows: (res as { rows: T[] }).rows };
      },
      exec: async (sql: string) => {
        await pg.exec(sql);
      },
    };
    store = new SqlFleetStore(exec);
    await store.init();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("persists a registered hub + heartbeat across a fresh service instance", async () => {
    let clock = 1_000_000;
    const fleet = new FleetService({ store, now: () => clock });
    const hub = await fleet.register({
      orgId: "org-acme",
      homeId: "home-1" as HomeId,
      name: "Penthouse",
      version: "0.3.0",
    });

    clock += 10_000;
    await fleet.heartbeat(hub.id, "0.3.1");

    // Fresh service over the same DB (simulates a fleet API restart).
    const restarted = new FleetService({ store, now: () => clock });
    const hubs = await restarted.listForOrg("org-acme");
    expect(hubs).toHaveLength(1);
    expect(hubs[0]?.version).toBe("0.3.1");
    expect(hubs[0]?.status).toBe("online");

    // A different org sees nothing (SQL-level scoping).
    expect(await restarted.listForOrg("org-other")).toHaveLength(0);
  });

  it("derives offline once a hub is stale past the threshold", async () => {
    let clock = 2_000_000;
    const fleet = new FleetService({ store, now: () => clock, offlineAfterMs: 90_000 });
    const hub = await fleet.register({
      orgId: "org-stale",
      homeId: "home-2" as HomeId,
      name: "Villa",
      version: "0.3.0",
    });
    clock += 120_000; // beyond the offline window
    const hubs = await fleet.listForOrg("org-stale");
    expect(hubs.find((h) => h.id === hub.id)?.status).toBe("offline");
  });
});
