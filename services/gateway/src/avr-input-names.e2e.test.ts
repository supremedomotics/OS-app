import type { HomeView } from "@supreme/contracts";
import {
  DriverBindingEngine,
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  ProviderRegistry,
  ProviderRouter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
} from "@supreme/integration-layer";
import { AvrProtocolDriver } from "@supreme/protocols";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/** Minimal fake Denon/Marantz Telnet listener — just enough for `bind()` to connect and
 * for the AVR driver to consider the device managed. Mirrors the harness other AVR e2e
 * tests in this package already use (avr-diagnostics-export.e2e.test.ts). */
function startFakeAvr(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, server });
    });
  });
}

/**
 * § Pass 12.6, Part E/F/L — end-to-end: commission a real AvrProtocolDriver-backed device,
 * set a custom input name via the new API, confirm it persists (protocol_bindings store —
 * in-memory here, real Postgres proven separately in persistence.test.ts) and survives a
 * rediscovery-style rebind, and confirm invalid device/input/name are rejected.
 */
describe("AVR input customization API e2e", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let fakeAvr: { port: number; server: net.Server };
  const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
  const bindingStore = new InMemoryProtocolBindingStore();

  beforeAll(async () => {
    fakeAvr = await startFakeAvr();
    const registry = new EntityRegistryMirror();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine: native, registry: providers, bindingEngine: new DriverBindingEngine(native, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry, providers });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: bindingStore,
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

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
    await new Promise<void>((r) => fakeAvr.server.close(() => r()));
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("sets, persists, and rediscovery-preserves a custom AVR input name; rejects invalid device/input/name", async () => {
    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as HomeView;
    const roomId = home.rooms[0]!.id;

    const commissioned = await fetch(`${baseUrl}/v1/commissioning/commission`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ backendId: "denon.avr.1", name: "Living Room AVR", roomId, capabilities: ["media"] }),
    });
    expect(commissioned.status).toBe(201);
    const deviceId = ((await commissioned.json()) as { device: { id: string } }).device.id;

    const bound = await fetch(`${baseUrl}/v1/commissioning/bind`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ deviceId, capability: "media", protocol: "avr", address: `127.0.0.1:${fakeAvr.port}` }),
    });
    expect(bound.status).toBe(201);

    // GET before any rename: SAT/CBL has no custom name yet.
    const before = (await (
      await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs`, { headers: auth() })
    ).json()) as { inputs: { technicalId: string; customName: string | null; displayName: string }[] };
    const satBefore = before.inputs.find((i) => i.technicalId === "SAT/CBL")!;
    expect(satBefore.customName).toBeNull();

    // PATCH: set SAT/CBL -> "Apple TV".
    const patched = await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs/SAT%2FCBL`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ name: "Apple TV" }),
    });
    expect(patched.status).toBe(200);

    // READ BACK immediately.
    const after = (await (
      await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs`, { headers: auth() })
    ).json()) as { inputs: { technicalId: string; customName: string | null; displayName: string }[] };
    expect(after.inputs.find((i) => i.technicalId === "SAT/CBL")?.displayName).toBe("Apple TV");

    // PERSISTED in the binding store (never a Device.metadata field — technical identity
    // stays on ProtocolBinding.config, keyed by the wire token, not a display name).
    const stored = (await bindingStore.list()).find((b) => b.deviceId === deviceId && b.capability === "media");
    expect((stored?.config?.customInputNames as Record<string, string> | undefined)?.["SAT/CBL"]).toBe("Apple TV");

    // REDISCOVERY: re-run bind() with the persisted config (what a hub restart's
    // "restoring_bindings" stage does) — the custom name survives.
    await driver.bind({ deviceId: deviceId as never, capability: "media", address: `127.0.0.1:${fakeAvr.port}`, config: stored!.config });
    const afterRebind = (await (
      await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs`, { headers: auth() })
    ).json()) as { inputs: { technicalId: string; displayName: string }[] };
    expect(afterRebind.inputs.find((i) => i.technicalId === "SAT/CBL")?.displayName).toBe("Apple TV");

    // INVALID input: not a real wire token.
    const badInput = await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs/NOT_REAL`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ name: "Hack" }),
    });
    expect(badInput.status).toBe(422);

    // INVALID device.
    const badDevice = await fetch(`${baseUrl}/v1/devices/does-not-exist/avr/inputs/SAT%2FCBL`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ name: "Hack" }),
    });
    expect(badDevice.status).toBe(404);

    // INVALID (empty) name.
    const badName = await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs/SAT%2FCBL`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ name: "" }),
    });
    expect(badName.status).toBe(422);

    // DELETE clears back to the reported name.
    const cleared = await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs/SAT%2FCBL`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(cleared.status).toBe(200);
    const afterClear = (await (
      await fetch(`${baseUrl}/v1/devices/${deviceId}/avr/inputs`, { headers: auth() })
    ).json()) as { inputs: { technicalId: string; customName: string | null }[] };
    expect(afterClear.inputs.find((i) => i.technicalId === "SAT/CBL")?.customName).toBeNull();
  });
});
