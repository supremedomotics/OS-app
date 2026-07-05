import type { HomeView, MigrationStatus, ServerFrame } from "@supreme/contracts";
import {
  EntityRegistryMirror,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
} from "@supreme/integration-layer";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Phase-4 native migration: a device controlled via the HA-side backend is migrated
 * to the Supreme-native engine at runtime, and control continues over the IDENTICAL
 * client API — proving the migration guarantee (zero change above the SIL).
 */
describe("Phase-4 native migration", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let native: SupremeNativeAdapter;
  let baseUrl: string;
  let wsBase: string;
  let token = "";

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    native = new SupremeNativeAdapter();
    const router = new RoutingBackendAdapter({ ha: new MockAdapter(), native, registry });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });

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

  it("migrates the 'light' domain to native; control continues unchanged", async () => {
    const deviceId = await dimmer();

    // Control via the HA side first.
    await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 30 } }),
    });
    expect(native.manages(deviceId as never)).toBe(false);

    // Migrate the light domain to the native engine.
    const res = await fetch(`${baseUrl}/v1/migration/light`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ engine: "native" }),
    });
    const migrated = (await res.json()) as { engine: string; moved: number };
    expect(migrated.engine).toBe("native");
    expect(migrated.moved).toBeGreaterThan(0);

    // The SAME command endpoint now drives the native engine — observed over WSS.
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${token}`);
    await new Promise((r) => ws.once("open", r));
    const delta = new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no native state delta")), 4000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString()) as ServerFrame;
        if (f.type === "state" && f.deviceId === deviceId) {
          clearTimeout(t);
          resolve(f);
        }
      });
    });
    ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] }));
    await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "brightness", action: "set", level: 80 } }),
    });
    const frame = await delta;
    if (frame.type !== "state") throw new Error("unreachable");
    expect(frame.state).toEqual({ kind: "brightness", on: true, level: 80 });
    expect(native.manages(deviceId as never)).toBe(true); // now under native control
    ws.close();

    // Status reflects the migration; other domains remain on HA.
    const status = (await (await fetch(`${baseUrl}/v1/migration`, { headers: auth() })).json()) as MigrationStatus;
    expect(status.domains.find((d) => d.domain === "light")?.engine).toBe("native");
    expect(status.domains.find((d) => d.domain === "climate")?.engine).toBe("ha");
  });
});
