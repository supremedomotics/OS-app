import type { HomeView, MigrationStatus } from "@supreme/contracts";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  HaAdapter,
  HomeAssistantProviderDriver,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type HaTransport,
} from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase-4 native migration: the `/v1/migration` installer wizard still reports and
 * flips per-domain routing intent. ADR-0023 § Remove Runtime Simulation changed what
 * "migrated" means, though: it no longer fabricates live native state for a domain's
 * devices (the old behavior — instant, driver-less "control continues unchanged" —
 * was exactly the kind of simulated state the new architecture forbids). A migrated
 * device is honestly UNBOUND until a real driver binds it via `bindNative()`.
 */
/** No-socket HA transport (mirrors integration-layer's own ha-adapter.test.ts pattern). */
class FakeHaTransport implements HaTransport {
  opened = false;
  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  isOpen(): boolean { return this.opened; }
  onEvent(): void {}
  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (message.type === "get_states") return { result: [] };
    return {};
  }
}

describe("Phase-4 native migration", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let native: SupremeNativeAdapter;
  let baseUrl: string;
  let wsBase: string;
  let token = "";

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const haDriver = new HomeAssistantProviderDriver(new HaAdapter({ transport: new FakeHaTransport(), registry }), registry);
    native = new SupremeNativeAdapter({ drivers: [haDriver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine: native, registry: providers, bindingEngine: new DriverBindingEngine(native, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry, providers });

    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), { sil });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;

    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  async function dimmer(): Promise<string> {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const living = home.rooms.find((r) => r.name === "Living Room")!;
    const devs = (await (
      await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, { headers: auth() })
    ).json()) as { devices: { id: string; supremeType: string }[] };
    return devs.devices.find((d) => d.supremeType === "dimmer")!.id;
  }

  it("reports per-domain routing, defaulting to HA", async () => {
    const status = (await (await fetch(`${baseUrl}/v1/migration`, { headers: auth() })).json()) as MigrationStatus;
    expect(status.enabled).toBe(true);
    const light = status.domains.find((d) => d.domain === "light");
    expect(light?.engine).toBe("ha");
    expect(status.fullyMigrated).toBe(false);
  });

  it("migrates the 'light' domain's tracked engine to native honestly — never fabricates live control", async () => {
    const deviceId = await dimmer();

    // Control via the HA side first — genuinely bound via HomeAssistantProviderDriver.
    const before = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 30 } }),
    });
    expect(before.status).toBeLessThan(300);
    expect(native.manages(deviceId as never)).toBe(true); // HA registers into the SAME driver registry (ADR-0023)

    // Migrate the light domain's tracked engine to native.
    const res = await fetch(`${baseUrl}/v1/migration/light`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ engine: "native" }),
    });
    const migrated = (await res.json()) as { engine: string; moved: number };
    expect(migrated.engine).toBe("native");

    // ADR-0023 § Remove Runtime Simulation: migrating the domain's tracked engine is
    // NOT the same as binding a real driver — the device has no real native protocol
    // bound, so it must stay honestly unbound/uncommandable, never instantly "just
    // work" via fabricated state.
    const afterMigrate = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 80 } }),
    });
    expect(afterMigrate.status).toBeGreaterThanOrEqual(400);

    // Status reflects the migration; other domains remain on HA.
    const status = (await (await fetch(`${baseUrl}/v1/migration`, { headers: auth() })).json()) as MigrationStatus;
    expect(status.domains.find((d) => d.domain === "light")?.engine).toBe("native");
    expect(status.domains.find((d) => d.domain === "climate")?.engine).toBe("ha");
  });
});
