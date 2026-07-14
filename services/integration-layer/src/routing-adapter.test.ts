import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock-adapter.js";
import { SupremeNativeAdapter } from "./native-adapter.js";
import { RoutingBackendAdapter } from "./routing-adapter.js";
import { EntityRegistryMirror } from "./registry.js";
import { OwnershipRegistry } from "./ownership.js";
import { SupremeIntegrationLayer } from "./sil.js";

/**
 * Phase-4 migration proof: with HA (mock) + native engine behind the router, a
 * domain is migrated to native at runtime and control/state move to the native
 * engine — with NOTHING above the SIL changing (same command/getState calls).
 */
function setup() {
  const ha = new MockAdapter();
  const native = new SupremeNativeAdapter();
  const registry = new EntityRegistryMirror();
  const ownership = new OwnershipRegistry();
  const router = new RoutingBackendAdapter({ ha, native, registry, ownership });
  const sil = new SupremeIntegrationLayer({ adapter: router, registry, ownership });
  return { ha, native, registry, router, sil };
}

describe("RoutingBackendAdapter — native migration", () => {
  it("routes to HA by default, then to native after migrating the domain", async () => {
    const { ha, native, sil } = setup();
    await sil.start();

    const light = newId("device") as DeviceId;
    sil.mapEntity(light, "brightness", { backendId: "light.kitchen", backendDomain: "light" });
    // Ownership is explicit (§ Device Ownership) — commissioning normally sets this;
    // this test maps the registry directly, so it must assign ownership itself too.
    await sil.ownership.set(light, "ha");

    // Default: command goes to HA; native has nothing.
    await sil.command(light, { capability: "brightness", action: "set", level: 40 });
    expect(await ha.getState(light, "brightness")).toEqual({ kind: "brightness", on: true, level: 40 });
    expect(await native.getState(light, "brightness")).toBeNull();
    expect(sil.migrationStatus()).toEqual([{ domain: "light", engine: "ha" }]);

    // Migrate the "light" domain to native: state is carried over from HA.
    const moved = await sil.migrateDomain("light", "native");
    expect(moved).toBe(1);
    expect(await native.getState(light, "brightness")).toEqual({ kind: "brightness", on: true, level: 40 });
    expect(sil.migrationStatus()).toEqual([{ domain: "light", engine: "native" }]);

    // Same SIL call now routes to native; HA is untouched.
    await sil.command(light, { capability: "brightness", action: "set", level: 75 });
    expect(await native.getState(light, "brightness")).toEqual({ kind: "brightness", on: true, level: 75 });
    expect(await ha.getState(light, "brightness")).toEqual({ kind: "brightness", on: true, level: 40 });

    // The SIL facade reads the migrated value (routed to native).
    expect(await sil.getState(light, "brightness")).toEqual({ kind: "brightness", on: true, level: 75 });
  });

  it("only migrates the targeted domain; others stay on HA", async () => {
    const { ha, native, sil } = setup();
    await sil.start();
    const light = newId("device") as DeviceId;
    const lock = newId("device") as DeviceId;
    sil.mapEntity(light, "brightness", { backendId: "light.x", backendDomain: "light" });
    sil.mapEntity(lock, "lock", { backendId: "lock.front", backendDomain: "lock" });
    await sil.ownership.set(light, "ha");
    await sil.ownership.set(lock, "ha");

    await sil.migrateDomain("light", "native");

    await sil.command(lock, { capability: "lock", action: "lock" });
    expect(await ha.getState(lock, "lock")).toEqual({ kind: "lock", locked: true, jammed: false });
    expect(native.manages(lock)).toBe(false);

    const status = Object.fromEntries(sil.migrationStatus().map((s) => [s.domain, s.engine]));
    expect(status).toEqual({ light: "native", lock: "ha" });
  });

  it("forwards native state events up through the SIL subscription", async () => {
    const { native, registry, sil } = setup();
    await sil.start();
    const light = newId("device") as DeviceId;
    sil.mapEntity(light, "onoff", { backendId: "light.y", backendDomain: "light" });
    await sil.migrateDomain("light", "native");

    const events: unknown[] = [];
    sil.subscribe((e) => events.push(e));
    await sil.command(light, { capability: "onoff", action: "on" });
    expect(events).toHaveLength(1);
    expect(native.manages(light)).toBe(true);
    expect(registry.domains()).toContain("light");
  });
});
