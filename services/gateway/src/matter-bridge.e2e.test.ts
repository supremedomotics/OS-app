import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatterBridgeServer } from "@supreme/protocols";
import { InMemoryHomeStore } from "@supreme/home";
import { InMemoryIdentityStore } from "@supreme/identity";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Matter Bridge Phase 3 — the real native runtime wiring, through the REAL gateway boot
 * path (`AppContext.create()` -> `init()`), the REAL SIL, and the REAL demo home — exactly
 * the same shape as `homekit.e2e.test.ts`, which this file mirrors deliberately. Only the
 * Matter TRANSPORT is faked (`deps.matterBridgeServer`), per instruction #4: "Do not use the
 * fake/injectable server in production. The injectable server remains useful for tests." This
 * proves the wiring — config -> AppContext -> MatterBridgeDriver -> SIL -> native driver ->
 * demo device, and back — is real, not that a real ecosystem can commission it (§29, unchanged).
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
    return { commissioned: false, fabrics: [], pairing: { manualPairingCode: "34970112332", qrPairingCode: "MT:FAKE", discriminator: 3840 } };
  }
  async factoryReset() {
    this.endpoints.clear();
  }
  simulateEcosystemCommand(endpointNumber: number, on: boolean): void {
    for (const l of this.commandListeners) l(endpointNumber, on);
  }
}

describe("Matter Bridge (gateway e2e — real native runtime wiring)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  const server = new FakeMatterBridgeServer();
  let storageDir: string;

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "matter-bridge-e2e-"));
    ctx = await AppContext.create(
      loadConfig({
        SUPREME_PORT: "0",
        SUPREME_LOG_LEVEL: "silent",
        SUPREME_MATTER_BRIDGE_ENABLED: "1",
        SUPREME_MATTER_STORAGE_PATH: storageDir,
      }),
      { matterBridgeServer: server },
    );
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("starts the Matter Bridge and auto-exposes every onoff device in the demo home as a bridged endpoint", () => {
    expect(server.started).toBe(true);
    expect(server.endpoints.size).toBeGreaterThan(0);
  });

  it("routes a real Matter On command through the SIL to the actual device state (Matter -> SupremeOS)", async () => {
    const [endpointNumber] = [...server.endpoints.keys()];
    const mapping = ctx.matterBridge!.driver; // sanity: handle exists
    expect(mapping).toBeTruthy();

    server.simulateEcosystemCommand(endpointNumber, true);
    await new Promise((r) => setTimeout(r, 50));

    expect(server.endpoints.get(endpointNumber)?.on).toBe(true);
  });

  it("mirrors a real SupremeOS state change onto the Matter attribute (SupremeOS -> Matter)", async () => {
    const [endpointNumber] = [...server.endpoints.keys()];
    server.simulateEcosystemCommand(endpointNumber, false);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.endpoints.get(endpointNumber)?.on).toBe(false);

    server.simulateEcosystemCommand(endpointNumber, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.endpoints.get(endpointNumber)?.on).toBe(true);
  });

});

describe("Matter Bridge (gateway e2e — restart identity)", () => {
  it("survives a full, separate AppContext restart at the SAME endpoint identity, for the SAME devices", async () => {
    const restartDir = mkdtempSync(join(tmpdir(), "matter-bridge-restart-e2e-"));
    const restartServer = new FakeMatterBridgeServer();
    // Shared across both AppContext instances so the SECOND boot finds the SAME already-
    // commissioned home/devices (ctx.home.getHome() truthy -> rebindRegistry(), not a fresh
    // seedDemoHome() with brand-new device ids) — genuinely the same restart scenario a real
    // Postgres-backed hub reboot goes through, not two unrelated demo homes sharing one file.
    const homeStore = new InMemoryHomeStore();
    const identityStore = new InMemoryIdentityStore();
    try {
      const cfg = () =>
        loadConfig({
          SUPREME_PORT: "0",
          SUPREME_LOG_LEVEL: "silent",
          SUPREME_MATTER_BRIDGE_ENABLED: "1",
          SUPREME_MATTER_STORAGE_PATH: restartDir,
        });

      const ctx1 = await AppContext.create(cfg(), { matterBridgeServer: restartServer, homeStore, identityStore });
      const before = new Map(restartServer.endpoints);
      const devicesBefore = (await ctx1.home.listDevices()).map((d) => d.id).sort();
      expect(before.size).toBeGreaterThan(0);
      await ctx1.shutdown();
      expect(restartServer.started).toBe(false);

      const ctx2 = await AppContext.create(cfg(), { matterBridgeServer: restartServer, homeStore, identityStore });
      expect(restartServer.started).toBe(true);
      const devicesAfter = (await ctx2.home.listDevices()).map((d) => d.id).sort();
      // Same devices, not a second demo home's worth of freshly-seeded ones.
      expect(devicesAfter).toEqual(devicesBefore);
      // No endpoint churn: the same set of endpoint numbers, at the same size — a genuine
      // identity-preserving restart, not merely "the file wasn't deleted."
      expect(restartServer.endpoints.size).toBe(before.size);
      for (const [endpointNumber, entry] of before) {
        expect(restartServer.endpoints.get(endpointNumber)).toEqual(entry);
      }
      await ctx2.shutdown();
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  });
});

describe("Matter Bridge (gateway e2e — per-device isolation, real bug found live)", () => {
  it("one device failing to expose does not stop the REST of the demo home's onoff devices from being bridged", async () => {
    // Real production bug: this loop had no per-device try/catch, so one device throwing
    // silently aborted the whole loop — every device queued AFTER the failing one never even
    // got attempted, while devices already added stayed visible. Looked exactly like "only the
    // first device appears" on a real Matter controller.
    class FlakyOnceServer extends FakeMatterBridgeServer {
      private failedOnce = false;
      async addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void> {
        if (!this.failedOnce && this.endpoints.size === 1) {
          this.failedOnce = true;
          throw new Error("simulated: second device failed to expose");
        }
        await super.addOnOffLight(args);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "matter-bridge-isolation-e2e-"));
    const server = new FlakyOnceServer();
    try {
      const ctx = await AppContext.create(
        loadConfig({
          SUPREME_PORT: "0",
          SUPREME_LOG_LEVEL: "silent",
          SUPREME_MATTER_BRIDGE_ENABLED: "1",
          SUPREME_MATTER_STORAGE_PATH: dir,
        }),
        { matterBridgeServer: server },
      );
      const onoffDeviceCount = (await ctx.home.listDevices()).filter((d) => d.capabilities.some((c) => c.kind === "onoff")).length;
      expect(onoffDeviceCount).toBeGreaterThan(2); // the demo home has several — this bug needs 3+ to reproduce

      // The one device whose addOnOffLight call was made to fail is missing, but every OTHER
      // onoff device — critically, the ones queued AFTER it — still got bridged.
      expect(server.endpoints.size).toBe(onoffDeviceCount - 1);
      await ctx.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
