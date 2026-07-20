import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  MigrationPolicy,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Driver Lifecycle Completion — end-to-end proof that deleting a Supreme device
 * through the real HTTP API actually reaches the owning driver's `unbind()`, not
 * just the SIL-level ownership/registry bookkeeping. A fake driver with a real timer
 * (mirroring what AVR/HEOS/Yamaha/MQTT/etc. hold per device) proves the resource is
 * genuinely released, not just that a callback fired.
 */
class FakeTimerDriver implements INativeProtocolDriver {
  readonly protocol = "fake-timer";
  readonly activeTimers = new Map<DeviceId, ReturnType<typeof setInterval>>();
  readonly unbindCalls: DeviceId[] = [];
  private readonly listeners = new Set<StateListener>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    for (const timer of this.activeTimers.values()) clearInterval(timer);
    this.activeTimers.clear();
  }
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> {
    // Simulate a per-device poller — exactly the kind of resource this whole effort
    // exists to guarantee gets released on unbind(), not just on whole-driver disconnect().
    const timer = setInterval(() => {}, 60_000);
    (timer as { unref?: () => void }).unref?.();
    this.activeTimers.set(b.deviceId, timer);
  }
  manages(deviceId: DeviceId): boolean { return this.activeTimers.has(deviceId); }
  async command(): Promise<void> {}
  getState(): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [{ backendId: "fake-timer:1", suggestedName: "Fake Sensor", capabilities: ["onoff"], raw: {} }];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  async unbind(deviceId: DeviceId): Promise<void> {
    this.unbindCalls.push(deviceId);
    const timer = this.activeTimers.get(deviceId);
    if (timer) clearInterval(timer);
    this.activeTimers.delete(deviceId);
  }
}

describe("Driver Lifecycle Completion — deleting a device releases its driver-level resources", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeTimerDriver;

  beforeAll(async () => {
    driver = new FakeTimerDriver();
    const registry = new EntityRegistryMirror();
    const router = new RoutingBackendAdapter({
      ha: new MockAdapter(),
      native: new SupremeNativeAdapter({ drivers: [driver] }),
      registry,
      policy: new MigrationPolicy(),
    });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("DELETE /v1/devices/:id calls the owning driver's unbind() and clears its per-device timer", async () => {
    // No `protocol` filter — DiscoverRequest's `protocol` field is the closed
    // `ProtocolKind` enum, which "fake-timer" (a test-only protocol id) isn't part
    // of; omitting it makes `CommissioningService.discover()` aggregate every
    // registered native driver's `discover()`, including this fake one.
    const disc = await fetch(`${baseUrl}/v1/commissioning/discover`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    const discovered = (await disc.json()) as { discovered: { backendId: string; suggestedName: string; capabilities: CapabilityKind[]; protocol?: string }[] };
    const found = discovered.discovered.find((d) => d.protocol === "fake-timer");
    expect(found).toBeTruthy();

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string }[] };
    const commission = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        backendId: found!.backendId,
        name: found!.suggestedName,
        roomId: home.rooms[0]!.id,
        capabilities: found!.capabilities,
        protocol: "fake-timer",
      }),
    });
    expect(commission.status).toBeLessThan(300);
    const device = (await commission.json()) as { device: { id: DeviceId } };
    const deviceId = device.device.id;

    // The driver genuinely holds a live resource for this device right now.
    expect(driver.activeTimers.has(deviceId)).toBe(true);
    expect(driver.unbindCalls).toEqual([]);

    const del = await fetch(`${baseUrl}/v1/devices/${deviceId}`, { method: "DELETE", headers: auth() });
    expect(del.status).toBeLessThan(300);

    // unbind() reached the driver, and the timer it was holding for this device is gone.
    expect(driver.unbindCalls).toEqual([deviceId]);
    expect(driver.activeTimers.has(deviceId)).toBe(false);

    // A second delete attempt (device already gone) must not resurrect the call or throw
    // unexpectedly — the route itself 404s (device not found), which is correct; the
    // point under test is that the driver-level unbind was NOT called a second time.
    const delAgain = await fetch(`${baseUrl}/v1/devices/${deviceId}`, { method: "DELETE", headers: auth() });
    expect(delAgain.status).toBe(404);
    expect(driver.unbindCalls).toEqual([deviceId]);
  });
});
