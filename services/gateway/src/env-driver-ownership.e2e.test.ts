import type { HomeView } from "@supreme/contracts";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  bindingKey,
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

/** Minimal fake bus driver — same shape as `protocol-binding.e2e.test.ts`'s `FakeBusDriver`. */
class FakeBusDriver implements INativeProtocolDriver {
  constructor(readonly protocol: string) {}
  private connected = false;
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async bind(b: ProtocolBinding) {
    this.devices.add(b.deviceId);
  }
  manages(d: DeviceId) {
    return this.devices.has(d);
  }
  async command(deviceId: DeviceId, command: CapabilityCommand) {
    const state: CapabilityState = { kind: "onoff", on: true };
    this.states.set(bindingKey(deviceId, command.capability), state);
    for (const l of this.listeners) l({ deviceId, capability: command.capability, state, ts: new Date().toISOString() });
  }
  getState(deviceId: DeviceId, capability: CapabilityKind) {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
  onState(l: StateListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/**
 * § PASS 22B Part G / § PASS 23 P2 — regression coverage for `bindProtocol()`'s
 * `env:${protocol}` ownership fallback (`installer-context.ts` around the `ownerId`
 * resolution comment). Every real-hub protocol driver (KNX/AVR/CoolMaster/…) is normally
 * wired through env-var configuration straight into `envDrivers` (bootstrap.ts) rather
 * than the catalog/installed-store `DriverManager` — a completely different path from
 * what `driver-uninstall-ownership.e2e.test.ts` exercises (that file installs REAL catalog
 * drivers and calls `setDriverOwner()` directly, bypassing `bindProtocol()`'s own ownerId
 * resolution entirely). Without this fallback, `registry().find(e => e.installed)` matches
 * nothing for an env-configured driver and ownership silently stays null — this test
 * proves the fallback actually fires end-to-end through the real `bindProtocol()` call.
 */
describe("bindProtocol() env-driver ownership fallback", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  const driver = new FakeBusDriver("fake-env");

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine: native, registry: providers, bindingEngine: new DriverBindingEngine(native, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry, providers });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
      // The real production wiring: an env-configured driver instance, never
      // catalog-installed — exactly what bootstrap.ts does for a real hub.
      envDrivers: new Map([["fake-env", driver]]),
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

  it("a device bound via bindProtocol() to an env-configured driver gets driverId = env:<protocol>", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;
    const commissioned = await ctx.installer.commissionDevice({
      backendId: "fake-env/1/1/1",
      name: "Env-Driven Light",
      roomId,
      capabilities: ["onoff"],
      protocol: "fake-env",
      address: "fake-env/1/1/1",
    });
    const stored = await ctx.home.getDevice(commissioned.id);
    expect(stored?.driverId).toBe("env:fake-env");
  });
});
