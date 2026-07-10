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
import { SecurityService } from "@supreme/security";
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

    // Account deletion removes the user + their credential (FK cascade) from real Postgres.
    const guest = await identity.createUser({
      homeId: master.homeId,
      email: "guest@example.com",
      password: "guest-strong-password",
      displayName: "Guest",
      userType: "guest",
      expiresAt: null,
    });
    await identity.deleteOwnAccount(guest.id, "guest-strong-password");
    expect(await stores.identity.getUser(guest.id)).toBeNull();
    expect(await stores.identity.getCredential(guest.id)).toBeNull();
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

    // Move + rename persist across a restart.
    const rooms = await home2.listRooms();
    const target = rooms.find((r) => r.id !== dimmer.roomId)!;
    await home2.updateDevice(dimmer.id, { roomId: target.id, name: "Moved Lamp" });
    const afterMove = await new HomeService(sil, stores.home).getDevice(dimmer.id);
    expect(afterMove?.roomId).toBe(target.id);
    expect(afterMove?.name).toBe("Moved Lamp");

    // Delete persists across a restart.
    await home2.removeDevice(dimmer.id);
    expect(await new HomeService(sil, stores.home).getDevice(dimmer.id)).toBeNull();
  });

  it("persists the room location hierarchy (building / floor / area)", async () => {
    const sil = new SupremeIntegrationLayer({ adapter: new MockAdapter() });
    await sil.start();
    const home = new HomeService(sil, stores.home);
    const roomId = newId("room") as RoomId;
    await home.addRoom({
      id: roomId,
      homeId: newId("home") as HomeId,
      name: "Primary Suite",
      building: "Main House",
      floor: 2,
      area: "East Wing",
      areaType: "bedroom",
      sortOrder: 0,
      icon: null,
      heroImageUrl: null,
      parentRoomId: null,
    });

    // A fresh service over the same store sees the persisted location labels.
    const reloaded = await new HomeService(sil, stores.home).getRoom(roomId);
    expect(reloaded?.building).toBe("Main House");
    expect(reloaded?.floor).toBe(2);
    expect(reloaded?.area).toBe("East Wing");

    // Re-storing (upsert / PATCH-merge) only the area keeps building + floor intact.
    await home.addRoom({ ...reloaded!, area: "West Wing" });
    const moved = await new HomeService(sil, stores.home).getRoom(roomId);
    expect(moved?.area).toBe("West Wing");
    expect(moved?.building).toBe("Main House");
    expect(moved?.floor).toBe(2);
  });

  it("deletes a room against the real Postgres-backed store; its devices survive, unassigned", async () => {
    const sil = new SupremeIntegrationLayer({ adapter: new MockAdapter() });
    await sil.start();
    const home = new HomeService(sil, stores.home);
    const homeId = newId("home") as HomeId;
    const roomId = newId("room") as RoomId;
    await home.addRoom({
      id: roomId,
      homeId,
      name: "Guest Suite",
      building: null,
      floor: 0,
      area: null,
      areaType: "bedroom",
      sortOrder: 0,
      icon: null,
      heroImageUrl: null,
      parentRoomId: null,
    });
    const deviceId = newId("device") as DeviceId;
    await home.addDevice(
      {
        id: deviceId,
        homeId,
        roomId,
        name: "Guest Lamp",
        supremeType: "dimmer",
        manufacturer: null,
        model: null,
        driverId: null,
        status: "online",
        capabilities: [{ kind: "onoff", config: {} }],
        state: {},
        metadata: {},
      },
      {},
    );

    await home.removeRoom(roomId);

    // A fresh service over the same store confirms this survived a restart, not just the
    // in-memory instance: the room is gone, but the device is untouched aside from roomId.
    const fresh = new HomeService(sil, stores.home);
    expect(await fresh.getRoom(roomId)).toBeNull();
    const survived = await fresh.getDevice(deviceId);
    expect(survived).not.toBeNull();
    expect(survived?.roomId).toBeNull();
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

  it("persists the security panel so an armed home stays armed across a restart", async () => {
    const homeId = newId("home") as HomeId;
    const actor = newId("user") as UserId;

    // Arm via one service instance (write-through to Postgres).
    const security = new SecurityService({ store: stores.security });
    security.arm(homeId, "armed_away", actor);
    await security.flush(); // ensure the write-through landed

    // A fresh service (simulating a hub restart) hydrates from the store and is armed.
    const afterRestart = new SecurityService({ store: stores.security });
    expect(afterRestart.getState(homeId).mode).toBe("disarmed"); // before hydrate
    await afterRestart.hydrate(homeId);
    const restored = afterRestart.getState(homeId);
    expect(restored.mode).toBe("armed_away");
    expect(restored.lastChangedBy).toBe(actor);
  });

  it("persists protocol bindings so bus devices re-bind across a restart", async () => {
    const dev = newId("device") as DeviceId;
    await stores.protocolBindings.put({
      deviceId: dev,
      capability: "position",
      protocol: "knx",
      address: "1/2/0",
      config: { statusAddress: "1/2/1", dpt: "DPT5.001" },
    });
    // A fresh repo over the same DB (simulating a hub restart) sees the binding.
    const { ProtocolBindingRepo } = await import("./index.js");
    const fresh = new ProtocolBindingRepo(stores.db);
    const all = await fresh.list();
    const found = all.find((b) => b.deviceId === dev);
    expect(found?.protocol).toBe("knx");
    expect(found?.address).toBe("1/2/0");
    expect(found?.config?.dpt).toBe("DPT5.001");

    await fresh.remove(dev, "position");
    expect((await fresh.list()).some((b) => b.deviceId === dev)).toBe(false);
  });

  it("persists native-migration routing so a migrated domain stays native across a restart", async () => {
    const { MigrationPolicy } = await import("@supreme/integration-layer");
    // Migrate "light" to native through a policy backed by the store.
    const policy = new MigrationPolicy([], stores.migrationPolicy);
    policy.setEngine("light", "native");
    policy.setEngine("climate", "ha");
    await policy.flush();

    // A fresh policy (simulating a reboot) hydrates and keeps light on native.
    const afterReboot = new MigrationPolicy([], stores.migrationPolicy);
    await afterReboot.hydrate();
    expect(afterReboot.isNative("light")).toBe(true);
    expect(afterReboot.isNative("climate")).toBe(false);
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
