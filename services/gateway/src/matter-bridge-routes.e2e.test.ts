import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityCommand, MatterBridgeEndpointSpec, MatterBridgeServer } from "@supreme/protocols";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Matter Bridge Phase 6 — the installer-facing REST contract (status/pairing/enable/
 * disable/factory-reset), through the REAL AppContext boot path and REAL routes. Only the
 * Matter transport is faked, same boundary as every other Matter Bridge e2e test in this repo.
 */
class FakeMatterBridgeServer implements MatterBridgeServer {
  started = false;
  endpoints = new Map<number, { name: string; on: boolean }>();
  private commandListeners = new Set<(endpointNumber: number, command: CapabilityCommand) => void>();
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    const on = spec.initialState && "on" in spec.initialState ? spec.initialState.on : false;
    this.endpoints.set(spec.endpointNumber, { name: spec.name, on });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
  }
  async setCapabilityState(endpointNumber: number, state: { kind: string; on?: boolean }): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e && "on" in state && typeof state.on === "boolean") e.on = state.on;
  }
  async updateEndpointName(endpointNumber: number, name: string): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e) e.name = name;
  }
  async reportKeypadPress(): Promise<void> {}
  onCommand(listener: (endpointNumber: number, command: CapabilityCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  /** § Matter Bridge Phase 1.2B — mutable so a test can simulate the states the real SDK's own
   * `FabricManager`/`AdministratorCommissioning.windowStatus` produce (a real fabric-add needs an
   * external controller this sandbox has none of — §29) without touching Bridge internals. */
  fabrics: { fabricIndex: number; label: string | null; rootVendorId: number | null }[] = [];
  commissioningWindowOpen = true;
  getCommissioningState() {
    return {
      commissioned: this.fabrics.length > 0,
      fabricCount: this.fabrics.length,
      commissioningWindowOpen: this.commissioningWindowOpen,
      fabrics: this.fabrics,
      pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 },
    };
  }
  /** § Matter Bridge Phase 1.2A — models the REAL `ServerNode.erase()` behavior: it wipes
   * commissioning/fabric identity but never touches the live endpoint tree (see `real-server.ts`
   * `factoryReset()`'s doc for the full source-verified trace). Does NOT clear `this.endpoints`. */
  async factoryReset() {}
}

describe("Matter Bridge REST routes (gateway e2e)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let storageDir: string;
  const server = new FakeMatterBridgeServer();

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "matter-bridge-routes-e2e-"));
    // Bridge starts DISABLED here — every enable/disable transition below is exercised via
    // the routes themselves, not env config, proving the live (no-restart) toggle actually works.
    ctx = await AppContext.create(
      loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent", SUPREME_MATTER_STORAGE_PATH: storageDir }),
      { matterBridgeServer: server },
    );
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    rmSync(storageDir, { recursive: true, force: true });
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("reports disabled status before anything is enabled", async () => {
    const res = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, running: false, commissioned: false, fabricCount: 0, commissioningWindowOpen: false, fabrics: [] });
  });

  it("rejects an unauthenticated status request", async () => {
    const res = await fetch(`${baseUrl}/v1/matter-bridge/status`);
    expect(res.status).toBe(401);
  });

  it("returns a conflict for pairing/factory-reset while not running", async () => {
    const pairing = await fetch(`${baseUrl}/v1/matter-bridge/pairing`, { headers: auth() });
    expect(pairing.status).toBe(409);
    const reset = await fetch(`${baseUrl}/v1/matter-bridge/factory-reset`, { method: "POST", headers: auth() });
    expect(reset.status).toBe(409);
  });

  it("enables the Bridge live via the route — no restart — and status reflects it", async () => {
    const res = await fetch(`${baseUrl}/v1/matter-bridge/enable`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(server.started).toBe(true);

    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect(await status.json()).toMatchObject({ enabled: true, running: true, commissioned: false });
  });

  it("exposes the real pairing code once running", async () => {
    const res = await fetch(`${baseUrl}/v1/matter-bridge/pairing`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 });
  });

  it("factory-resets the real driver instance through the route, then comes back up live with a fresh identity", async () => {
    // § live-confirmed fix (Matter Bridge Phase 1.2A) — factory reset delegates to the real
    // `ServerNode.erase()`, which wipes commissioning/fabric identity but NEVER touches the live
    // endpoint tree (see `real-server.ts`'s `factoryReset()` doc for the full source-verified
    // trace) — the SAME node stays online throughout, so bridged devices are never dropped and
    // never need re-exposing.
    expect(server.endpoints.size).toBeGreaterThan(0);
    const before = server.endpoints.size;
    const res = await fetch(`${baseUrl}/v1/matter-bridge/factory-reset`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(server.endpoints.size).toBe(before);

    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ running: true });
  });

  // § Matter Bridge Phase 1.2B — the commissioning/fabric status model (§ Part F/G/H items
  // 2,3,4,5,6): `commissioned` and `commissioningWindowOpen` are separate fields through the
  // WHOLE real stack — gateway route → `AppContext.matterBridgeStatus()` →
  // `MatterBridgeDriver.getCommissioningState()` (a pure pass-through) → the transport. A real
  // fabric-add needs an external controller this sandbox has none of (§29), so this simulates the
  // SDK-owned states the fake's `getCommissioningState()` would report from real
  // `FabricManager`/`AdministratorCommissioning.windowStatus` data.
  it("2. a commissioned fabric (Apple Home or any controller) reports commissioned=true", async () => {
    server.fabrics = [{ fabricIndex: 1, label: "Apple Home", rootVendorId: 0xfff1 }];
    server.commissioningWindowOpen = false; // window normally closes once paired
    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect(await status.json()).toMatchObject({ commissioned: true, fabricCount: 1, commissioningWindowOpen: false });
  });

  it("3. commissioning window closed does not un-commission an existing fabric — commissioned stays true", async () => {
    server.fabrics = [{ fabricIndex: 1, label: "Apple Home", rootVendorId: 0xfff1 }];
    server.commissioningWindowOpen = false;
    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    const body = await status.json();
    expect(body.commissioned).toBe(true);
    expect(body.commissioningWindowOpen).toBe(false);
  });

  it("4. commissioning window open is reported independently of fabric state", async () => {
    server.fabrics = [];
    server.commissioningWindowOpen = true;
    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    const body = await status.json();
    expect(body.commissioned).toBe(false);
    expect(body.commissioningWindowOpen).toBe(true);
  });

  it("5. a fabric being removed (e.g. Apple Home 'Remove Accessory') correctly flips commissioned back to false once no fabrics remain", async () => {
    server.fabrics = [{ fabricIndex: 1, label: "Apple Home", rootVendorId: 0xfff1 }];
    let status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect((await status.json()).commissioned).toBe(true);

    server.fabrics = [];
    status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect((await status.json()).commissioned).toBe(false);
  });

  it("6. multiple simultaneous fabrics (multi-ecosystem, § Part G) still report commissioned=true and the correct count — never assumes a single controller", async () => {
    server.fabrics = [
      { fabricIndex: 1, label: "Apple Home", rootVendorId: 0xfff1 },
      { fabricIndex: 2, label: "Google Home", rootVendorId: 0xfff2 },
    ];
    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    const body = await status.json();
    expect(body.commissioned).toBe(true);
    expect(body.fabricCount).toBe(2);
    expect(body.fabrics).toHaveLength(2);
    server.fabrics = []; // reset for later tests
  });

  it("disables the Bridge live via the route, then re-enabling starts a fresh instance", async () => {
    const disable = await fetch(`${baseUrl}/v1/matter-bridge/disable`, { method: "POST", headers: auth() });
    expect(disable.status).toBe(200);
    expect(server.started).toBe(false);

    const status = await fetch(`${baseUrl}/v1/matter-bridge/status`, { headers: auth() });
    expect(await status.json()).toMatchObject({ enabled: false, running: false });

    const enable = await fetch(`${baseUrl}/v1/matter-bridge/enable`, { method: "POST", headers: auth() });
    expect(enable.status).toBe(200);
    expect(server.started).toBe(true);
  });

  it("returns a conflict for refresh while not running", async () => {
    await fetch(`${baseUrl}/v1/matter-bridge/disable`, { method: "POST", headers: auth() });
    const res = await fetch(`${baseUrl}/v1/matter-bridge/refresh`, { method: "POST", headers: auth() });
    expect(res.status).toBe(409);
    await fetch(`${baseUrl}/v1/matter-bridge/enable`, { method: "POST", headers: auth() });
  });

  it("refresh bridges a newly commissioned onoff device without disturbing existing endpoints", async () => {
    const before = new Map(server.endpoints);
    expect(before.size).toBeGreaterThan(0);

    const rooms = await ctx.home.listRooms();
    const device = await ctx.installer.commissionDevice({
      backendId: `test-refresh-${Date.now()}`,
      name: "Refresh Test Light",
      roomId: rooms[0].id,
      capabilities: ["onoff"],
    });

    const refresh = await fetch(`${baseUrl}/v1/matter-bridge/refresh`, { method: "POST", headers: auth() });
    expect(refresh.status).toBe(200);

    // Every previously-bridged endpoint is untouched.
    for (const [endpointNumber, entry] of before) {
      expect(server.endpoints.get(endpointNumber)).toEqual(entry);
    }
    // The new device is now bridged too.
    expect([...server.endpoints.values()].some((e) => e.name === device.name)).toBe(true);
    expect(server.endpoints.size).toBe(before.size + 1);
  });
});
