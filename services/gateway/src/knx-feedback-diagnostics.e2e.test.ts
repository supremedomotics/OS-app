import { newId, type DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
} from "@supreme/integration-layer";
// eslint-disable-next-line import/no-relative-packages
import { SupremeKnxDriver } from "../../protocols/src/knx/supreme-knx-driver.js";
// eslint-disable-next-line import/no-relative-packages
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "../../protocols/src/knx/provider.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Decisive KNX Feedback Diagnostic — proves the new
 * `GET /v1/devices/:id/diagnostics/knx-feedback` endpoint actually returns a
 * cross-hop snapshot that updates when a SYNTHETIC feedback telegram is fed through
 * the REAL SupremeKnxDriver + SupremeNativeAdapter + gateway pipeline (never a fake
 * response shape) — the exact thing a human tester will run against real hardware,
 * minus the physical keypad. Uses a fake provider (only the `knxultimate`-facing
 * transport is faked, same as `knx-feedback-adapter.e2e.test.ts` in
 * `@supreme/integration-layer`) so this runs with zero real KNX hardware.
 */
class FakeKnxProvider implements IKnxProvider {
  readonly name = "fake";
  connected = false;
  private observers = new Map<string, (value: unknown) => void>();
  async initialize(): Promise<void> {}
  async discover(): Promise<DiscoveredDevice[]> { return []; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async shutdown(): Promise<void> { this.connected = false; }
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "bus.group_write" || task.kind === "bus.group_read") return undefined;
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(ga: string, _dpt: string, handler: (value: unknown) => void): void { this.observers.set(ga, handler); }
  unsubscribe(ga: string): void { this.observers.delete(ga); }
  isSubscribed(ga: string): boolean { return this.observers.has(ga); }
  health(): ProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): ProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: 0, packetsReceived: 1, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

describe("GET /v1/devices/:id/diagnostics/knx-feedback (§ Decisive KNX Feedback Diagnostic)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let deviceId: DeviceId;
  const provider = new FakeKnxProvider();
  let knxDriver: SupremeKnxDriver;

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    knxDriver = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });
    const engine = new SupremeNativeAdapter({ drivers: [knxDriver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry, providers });
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

    deviceId = newId("device") as DeviceId;
    await ctx.home.addDevice(
      { id: deviceId, name: "Diagnostic Test Light", roomId: null, capabilities: [{ kind: "onoff" }], metadata: {} } as never,
      {},
    );
    await ctx.sil.bindNative({ deviceId, capability: "onoff", address: "5/3/0", config: { statusAddress: "5/3/1" } }, "knx");
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it("reports null hop snapshots before any feedback has ever arrived", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/diagnostics/knx-feedback`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastBackendState: unknown; lastPersistedState: unknown; lastWebSocketBroadcast: unknown; knx: unknown; isSubscribed: unknown;
    };
    expect(body.lastBackendState).toBeNull();
    expect(body.lastPersistedState).toBeNull();
    expect(body.lastWebSocketBroadcast).toBeNull();
    expect(body.knx).not.toBeNull(); // this device IS KNX-managed, so provider/binding diagnostics are non-null
    expect(body.isSubscribed).toBeNull(); // no ?ga= supplied
  });

  it("reflects a real synthetic feedback telegram across every gateway hop this pass instruments", async () => {
    // A physical keypad press: a real GroupValueWrite telegram arrives on the STATUS GA.
    provider.emit("5/3/1", true);
    // Let the async onState → onBackendState fan-out settle.
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${baseUrl}/v1/devices/${deviceId}/diagnostics/knx-feedback?ga=5/3/1`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastBackendState: { deviceId: string; state: string } | null;
      lastPersistedState: { deviceId: string; state: string } | null;
      lastWebSocketBroadcast: { deviceId: string; state: string } | null;
      knx: { lastRecordedState: { deviceId: string; capability: string } | null } | null;
      isSubscribed: boolean;
    };
    expect(body.lastBackendState).toMatchObject({ deviceId, state: "onoff" });
    expect(body.lastPersistedState).toMatchObject({ deviceId, state: "onoff" });
    expect(body.lastWebSocketBroadcast).toMatchObject({ deviceId, state: "onoff" });
    expect(body.knx?.lastRecordedState).toMatchObject({ deviceId, capability: "onoff" });
    expect(body.isSubscribed).toBe(true); // 5/3/1 genuinely has a live subscription
  });

  it("knx-feedback for a non-KNX (unmanaged) device reports knx: null, never fabricated", async () => {
    const otherId = newId("device") as DeviceId;
    await ctx.home.addDevice(
      { id: otherId, name: "Unmanaged Device", roomId: null, capabilities: [], metadata: {} } as never,
      {},
    );
    const res = await fetch(`${baseUrl}/v1/devices/${otherId}/diagnostics/knx-feedback`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knx: unknown };
    expect(body.knx).toBeNull();
  });
});
