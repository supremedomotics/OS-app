import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";

/**
 * Proves the persisted hub survives a restart: commissioning happens exactly once,
 * and home topology + the Master User remain after the context is rebuilt over the
 * same database. Uses embedded Postgres (PGlite) so it runs anywhere.
 */
describe("Gateway persistence + restart", () => {
  let db: PgliteDb;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  function deps() {
    const s = buildStores(db);
    return {
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
    };
  }

  it("commissions on first boot and reuses the home on reboot", async () => {
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });

    const ctx1 = await AppContext.create(config, deps());
    const home1 = await ctx1.home.getHome();
    expect(home1).not.toBeNull();
    const rooms1 = await ctx1.home.listRooms();
    expect(rooms1.length).toBeGreaterThan(0);
    const login1 = await ctx1.identity.login("owner@supreme.local", "supreme-owner-demo-pass");
    expect(login1.status).toBe("ok");
    await ctx1.shutdown();

    // Reboot over the same DB: same home id, no duplicate commissioning.
    const ctx2 = await AppContext.create(config, deps());
    const home2 = await ctx2.home.getHome();
    expect(home2?.id).toBe(home1?.id);
    const users = await ctx2.identity.listUsers();
    expect(users.filter((u) => u.userType === "master")).toHaveLength(1);
    // Devices rebound into the SIL registry are controllable after reboot.
    const devices = await ctx2.home.listDevices();
    const dimmer = devices.find((d) => d.supremeType === "dimmer")!;
    await ctx2.sil.command(dimmer.id, { capability: "brightness", action: "set", level: 40 });
    // Let the async state-delta persistence settle before tearing down the DB.
    await new Promise((r) => setTimeout(r, 50));
    await ctx2.shutdown();
  });
});
