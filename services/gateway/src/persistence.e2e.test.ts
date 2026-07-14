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

  it("queues devices for approval, then approves one into a room; rejects stay out (§ Device Approval)", async () => {
    const s = buildStores(db);
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), db, pendingDeviceStore: s.pendingDevices });
    const inst = ctx.installer;
    const home = await ctx.home.getHome();
    const homeId = home!.id as string;

    // Two devices announce themselves (as discovery would stage them). Upsert dedupes by backendId.
    // No protocol here → approval just commissions (auto-bind is exercised by the protocol-binding
    // e2e; this test focuses on the approval queue itself).
    const stage = (backendId: string, name: string) =>
      s.pendingDevices.upsert({
        homeId, backendId, suggestedName: name, protocol: null, source: "backend",
        capabilities: ["onoff"], network: { ip: "192.168.1.50", mac: "aabbccddeeff" },
        seenAt: new Date().toISOString(), newId: `dev-${backendId}`,
      });
    await stage("mqtt.lamp", "Hallway Lamp");
    await stage("mqtt.lamp", "Hallway Lamp"); // same backendId → still one entry
    await stage("mqtt.fan", "Study Fan");

    const pending = await inst.listPendingDevices();
    expect(pending).toHaveLength(2);
    const lamp = pending.find((p) => p.backendId === "mqtt.lamp")!;
    expect(lamp.network?.ip).toBe("192.168.1.50");

    const roomId = (await ctx.home.listRooms())[0]!.id;
    const before = (await ctx.home.listDevices()).length;

    // Approve the lamp → commissioned into the room (carrying its captured IP/MAC), leaves the queue.
    const device = await inst.approvePendingDevice(lamp.id, { roomId, name: "Approved Lamp" });
    expect(device.roomId).toBe(roomId);
    expect((device.metadata as { network?: { ip?: string } }).network?.ip).toBe("192.168.1.50");
    expect((await ctx.home.listDevices()).length).toBe(before + 1);
    expect((await inst.listPendingDevices()).some((p) => p.id === lamp.id)).toBe(false);

    // Reject the fan → it's gone from the queue. A re-stage of the same backendId DOES
    // resurface it (§ BUG-005 fix): rejecting only means "not right now", and since
    // commissioning.discover() already guarantees a still-owned backendId never reaches
    // upsert() in the first place, reviving a re-sighted device to "pending" can never
    // wrongly resurface something that's actually in use.
    const fan = (await inst.listPendingDevices())[0]!;
    await inst.rejectPendingDevice(fan.id);
    expect(await inst.listPendingDevices()).toHaveLength(0);
    await stage("mqtt.fan", "Study Fan");
    expect((await inst.listPendingDevices()).some((p) => p.backendId === "mqtt.fan")).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    await ctx.shutdown();
  });

  it("persists backups + schedule, dry-runs, and restores rollback-safe (§ Backup)", async () => {
    const s = buildStores(db);
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent" });
    const ctx = await AppContext.create(config, { ...deps(), db, backupStore: s.backups });
    const inst = ctx.installer;

    // Create a backup → it lands in history and drives the health indicator.
    const { document } = await inst.createBackup("manual");
    const status1 = await inst.backupStatus();
    expect(status1.backupCount).toBeGreaterThanOrEqual(1);
    expect(status1.lastBackupAt).toBeTruthy();
    expect(status1.lastBackupSource).toBe("manual");

    // Dry-run inspects without touching data: valid signature + a real per-table preview.
    const inspection = inst.inspectRestore(document);
    expect(inspection.signatureValid).toBe(true);
    expect(inspection.rowCount).toBeGreaterThan(0);
    expect(inspection.tables.some((t) => t.name === "users")).toBe(true);

    // Schedule is persisted + reflected in status (next-due computed from the last backup).
    const sched = await inst.setBackupSchedule({ enabled: true, everyHours: 6, retain: 5 });
    expect(sched).toEqual({ enabled: true, everyHours: 6, retain: 5 });
    const status2 = await inst.backupStatus();
    expect(status2.schedule.enabled).toBe(true);
    expect(status2.nextDueAt).toBeTruthy();

    // A rollback-safe restore of the snapshot succeeds and is recorded.
    const restore = await inst.restore(document);
    expect(restore.rolledBack).toBe(false);
    expect(restore.rows).toBeGreaterThan(0);
    expect((await inst.backupStatus()).lastRestoreAt).toBeTruthy();

    // A corrupt/invalid backup is rejected before any destructive write (signature check).
    const tampered = JSON.parse(document) as { signature: string };
    tampered.signature = "00";
    await expect(inst.restore(JSON.stringify(tampered))).rejects.toThrow(/signature/i);

    await new Promise((r) => setTimeout(r, 50));
    await ctx.shutdown();
  });
});
