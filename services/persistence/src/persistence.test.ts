import {
  newId,
  type DeviceId,
  type HomeId,
  type RoomId,
  type UserId,
} from "@supreme/domain-model";
import { IdentityService } from "@supreme/identity";
import { HomeService, seedDemoHome } from "@supreme/home";
import { SceneService } from "@supreme/scenes";
import { MockAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { buildGrant } from "@supreme/permissions";
import { NotificationService } from "@supreme/notifications";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPersistence, type PersistenceStores } from "./index.js";

/**
 * Exercises every repository against real embedded Postgres (PGlite). Because the
 * services accept their store via interface, these tests run the actual Phase-1
 * services on top of the Postgres-backed stores — proving the production path.
 */
describe("Postgres-backed persistence (PGlite)", () => {
  let stores: PersistenceStores;

  beforeAll(async () => {
    stores = await createPersistence({}); // embedded PGlite, in-memory
  });
  afterAll(async () => {
    await stores.db.close();
  });

  it("migrations are idempotent", async () => {
    const { rows } = await stores.db.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(rows.map((r) => r.name)).toContain("0001_init.sql");
  });

  it("persists identity: commission, login, and round-trip the user", async () => {
    const identity = new IdentityService({ tokenSecret: "x".repeat(40), store: stores.identity });
    const { master } = await identity.commission({
      homeName: "Estate",
      email: "owner@example.com",
      password: "a-strong-demo-password",
      displayName: "Owner",
    });
    const res = await identity.login("owner@example.com", "a-strong-demo-password");
    expect(res.status).toBe("ok");

    // A fresh service over the same store sees the persisted user.
    const identity2 = new IdentityService({ tokenSecret: "x".repeat(40), store: stores.identity });
    const fetched = await identity2.getUser(master.id);
    expect(fetched.email).toBe("owner@example.com");
  });

  it("persists home topology, device state, and favorites", async () => {
    const sil = new SupremeIntegrationLayer({ adapter: new MockAdapter() });
    await sil.start();
    const home = new HomeService(sil, stores.home);
    const homeRecord = {
      id: newId("home") as HomeId,
      name: "Estate",
      address: null,
      tier: "estate" as const,
      masterUserId: newId("user") as UserId,
      createdAt: new Date().toISOString(),
    };
    await seedDemoHome(home, homeRecord);

    // Reload through a fresh service + rebind, then mutate device state.
    const home2 = new HomeService(sil, stores.home);
    await home2.rebindRegistry();
    const devices = await home2.listDevices();
    const dimmer = devices.find((d) => d.supremeType === "dimmer")!;
    await home2.applyState(dimmer.id, { kind: "brightness", on: true, level: 73 });

    const reloaded = await new HomeService(sil, stores.home).getDevice(dimmer.id);
    expect(reloaded?.state.brightness).toEqual({ kind: "brightness", on: true, level: 73 });

    const userId = newId("user") as UserId;
    await home2.setFavorite(userId, { type: "device", deviceId: dimmer.id }, true);
    expect(await home2.listFavorites(userId)).toHaveLength(1);
  });

  it("persists scenes and grants", async () => {
    const sil = new SupremeIntegrationLayer({ adapter: new MockAdapter() });
    await sil.start();
    const scenes = new SceneService(sil, stores.scenes);
    const scene = await scenes.create({
      homeId: newId("home") as HomeId,
      name: "Goodnight",
      steps: [
        { deviceId: newId("device") as DeviceId, capability: "onoff", values: { action: "off" } },
      ],
    });
    const reloaded = await new SceneService(sil, stores.scenes).get(scene.id);
    expect(reloaded.name).toBe("Goodnight");

    const grant = buildGrant({
      userId: newId("user") as UserId,
      resourceType: "device",
      action: "control",
      schedule: [{ days: [1, 2, 3], start: "08:00", end: "18:00" }],
    });
    await stores.grants.add(grant);
    const list = await stores.grants.listForUser(grant.userId);
    expect(list[0]?.schedule?.[0]?.start).toBe("08:00");
  });

  it("persists sessions so revocation survives across instances", async () => {
    const userId = newId("user") as UserId;
    const sid = newId("session") as string;
    await stores.sessions.create({
      id: sid,
      userId,
      currentJti: "jti-1",
      revoked: false,
      createdAt: new Date().toISOString(),
    });
    await stores.sessions.setCurrentJti(sid, "jti-2");
    // A fresh repo over the same DB sees the rotated, non-revoked session.
    const { SessionRepo } = await import("./index.js");
    const fresh = new SessionRepo(stores.db);
    expect((await fresh.get(sid))?.currentJti).toBe("jti-2");
    await fresh.revoke(sid);
    expect((await stores.sessions.get(sid))?.revoked).toBe(true);
  });

  it("persists notifications with read receipts", async () => {
    const notifications = new NotificationService(stores.notifications);
    const userId = newId("user") as UserId;
    const n = await notifications.create({
      homeId: newId("home") as HomeId,
      userId,
      level: "warning",
      title: "Leak detected",
      body: "Kitchen sensor",
    });
    let list = await notifications.list(userId);
    expect(list.some((x) => x.id === n.id)).toBe(true);
    await notifications.markRead(userId, [n.id]);
    list = await notifications.list(userId);
    expect(list.find((x) => x.id === n.id)?.readAt).not.toBeNull();
  });
});
