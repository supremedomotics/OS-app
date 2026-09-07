import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatterBridgeServer } from "@supreme/protocols";
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
  private commandListeners = new Set<(endpointNumber: number, on: boolean) => void>();
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  async addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void> {
    this.endpoints.set(args.endpointNumber, { name: args.name, on: args.initialOn });
  }
  async removeEndpoint(endpointNumber: number): Promise<void> {
    this.endpoints.delete(endpointNumber);
  }
  async setOnOffState(endpointNumber: number, on: boolean): Promise<void> {
    const e = this.endpoints.get(endpointNumber);
    if (e) e.on = on;
  }
  onCommand(listener: (endpointNumber: number, on: boolean) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  getCommissioningState() {
    return {
      commissioned: false,
      fabrics: [] as { fabricIndex: number; label: string | null; rootVendorId: number | null }[],
      pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 },
    };
  }
  async factoryReset() {
    this.endpoints.clear();
  }
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
    expect(await res.json()).toEqual({ enabled: false, running: false, commissioned: false, fabrics: [] });
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

  it("factory-resets the real driver instance through the route", async () => {
    expect(server.endpoints.size).toBeGreaterThan(0);
    const res = await fetch(`${baseUrl}/v1/matter-bridge/factory-reset`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(server.endpoints.size).toBe(0);
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
});
