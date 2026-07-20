import { newId } from "@supreme/domain-model";
import type { CapabilityState, DeviceId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { MockAdapter } from "./mock-adapter.js";
import { SupremeIntegrationLayer } from "./sil.js";
import { SupremeNativeAdapter } from "./native-adapter.js";
import { RoutingBackendAdapter } from "./routing-adapter.js";
import { EntityRegistryMirror } from "./registry.js";
import { commandToHaService } from "./ha/capability-mapper.js";
import type { DiscoveredDevice } from "./adapter.js";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";

/** Minimal fake driver tracking whether unbind() was called — for the § Driver
 * Lifecycle Completion tests below. */
class FakeCleanupDriver implements INativeProtocolDriver {
  readonly protocol = "fake-cleanup";
  readonly unbindCalls: DeviceId[] = [];
  private readonly devices = new Set<DeviceId>();
  async connect() {}
  async disconnect() {}
  isConnected() { return true; }
  async bind(b: ProtocolBinding) { this.devices.add(b.deviceId); }
  manages(deviceId: DeviceId) { return this.devices.has(deviceId); }
  async command(): Promise<void> {}
  getState(): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  onState(): () => void { return () => {}; }
  async unbind(deviceId: DeviceId) {
    this.unbindCalls.push(deviceId);
    this.devices.delete(deviceId);
  }
}

describe("SIL command + state path", () => {
  it("routes a brightness command through the adapter and emits a normalized state", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();

    const deviceId = newId("device") as DeviceId;
    sil.mapEntity(deviceId, "brightness", { backendId: "light.kitchen", backendDomain: "light" });

    const events: unknown[] = [];
    sil.subscribe((e) => events.push(e));

    await sil.command(deviceId, { capability: "brightness", action: "set", level: 60 });

    expect(events).toHaveLength(1);
    const state = await sil.getState(deviceId, "brightness");
    expect(state).toEqual({ kind: "brightness", on: true, level: 60 });
  });

  it("rejects read-only sensor commands", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();
    const deviceId = newId("device") as DeviceId;
    await expect(
      // @ts-expect-error sensor is intentionally not a commandable capability
      sil.command(deviceId, { capability: "sensor" }),
    ).rejects.toThrow(/read-only/);
  });

  it("surfaces backend_unavailable when a non-HA adapter is down", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter }); // never started
    const deviceId = newId("device") as DeviceId;
    await expect(
      sil.command(deviceId, { capability: "onoff", action: "on" }),
    ).rejects.toThrow(/not connected/);
  });
});

describe("SupremeIntegrationLayer.unmapDevice — § Driver Lifecycle Completion", () => {
  it("releases the owning native driver's per-device resources before clearing SIL bookkeeping", async () => {
    const driver = new FakeCleanupDriver();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const router = new RoutingBackendAdapter({ ha: new MockAdapter(), native, registry: new EntityRegistryMirror() });
    const sil = new SupremeIntegrationLayer({ adapter: router });
    await sil.start();

    const deviceId = newId("device") as DeviceId;
    await sil.bindNative({ deviceId, capability: "onoff", address: "fake/1" }, "fake-cleanup");
    expect(native.manages(deviceId)).toBe(true);

    await sil.unmapDevice(deviceId);

    expect(driver.unbindCalls).toEqual([deviceId]);
    expect(native.manages(deviceId)).toBe(false);
  });

  it("is a safe no-op for a device that was never bound to any native driver", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();
    const deviceId = newId("device") as DeviceId;
    await expect(sil.unmapDevice(deviceId)).resolves.toBeUndefined();
  });
});

describe("HA capability mapper", () => {
  it("maps brightness set to light.turn_on with brightness_pct", () => {
    const call = commandToHaService("light.kitchen", {
      capability: "brightness",
      action: "set",
      level: 60,
    });
    expect(call).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: "light.kitchen", brightness_pct: 60 },
    });
  });

  it("maps lock unlock to lock.unlock", () => {
    const call = commandToHaService("lock.front", { capability: "lock", action: "unlock" });
    expect(call.service).toBe("unlock");
  });
});

it("placeholder for unused import lint", () => {
  expect(typeof vi).toBe("object");
});
