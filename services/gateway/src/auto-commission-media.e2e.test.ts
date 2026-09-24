import { createServer } from "node:net";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  InMemoryProtocolBindingStore,
  MigrationPolicy,
  MockAdapter,
  DriverBindingEngine,
  ProviderRegistry,
  ProviderRouter,
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
 * A fake Yamaha-shaped native driver exercising the full Universal AV Driver SDK
 * workflow end-to-end (§ Phase 4 Validation): one unit with a strong, persistent
 * zone-name hint and two extra real zones (auto room assignment + auto zone
 * generation), and one unit with no location signal at all (must land in the fixed
 * "Unassigned Devices" room, never guessed).
 */
class FakeYamahaLike implements INativeProtocolDriver {
  readonly protocol = "yamaha";
  readonly bindCalls: ProtocolBinding[] = [];
  readonly commands: { id: DeviceId; command: CapabilityCommand }[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly listeners = new Set<StateListener>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async bind(b: ProtocolBinding): Promise<void> {
    this.devices.add(b.deviceId);
    this.bindCalls.push(b);
  }
  manages(id: DeviceId): boolean { return this.devices.has(id); }
  async command(id: DeviceId, command: CapabilityCommand): Promise<void> {
    this.commands.push({ id, command });
    if (command.capability === "onoff") {
      const state: CapabilityState = { kind: "onoff", on: command.action === "on" };
      for (const l of this.listeners) l({ deviceId: id, capability: "onoff", state, ts: new Date().toISOString() });
    }
  }
  getState(_id: DeviceId, _c: CapabilityKind): CapabilityState | null { return null; }
  async discover(): Promise<DiscoveredDevice[]> {
    return [
      {
        backendId: "192.168.1.70",
        suggestedName: "Media Room",
        capabilities: ["onoff", "media"],
        raw: {
          protocol: "yamaha",
          bindConfig: { zone: "main" },
          locationHint: { raw: "Media Room", source: "persistent_user_zone_name" },
          zones: [
            { id: "main", label: "Main Zone" },
            { id: "zone2", label: "Zone 2" },
          ],
        },
      },
      {
        backendId: "192.168.1.71",
        suggestedName: "Yamaha 192.168.1.71",
        capabilities: ["onoff", "media"],
        // No locationHint at all — the honest "no signal" case (classic Denon Telnet's
        // real situation, simulated here on the yamaha protocol purely for test brevity).
        raw: { protocol: "yamaha", bindConfig: { zone: "main" } },
      },
    ];
  }
  onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

describe("Auto-commission media (AVR/HEOS/Yamaha) → confidence-based rooms + zone generation + control", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  let driver: FakeYamahaLike;

  beforeAll(async () => {
    driver = new FakeYamahaLike();
    const registry = new EntityRegistryMirror();
    const routerEngine0 = new SupremeNativeAdapter({ drivers: [driver] });
    const routerProviders0 = new ProviderRegistry();
    const router = new ProviderRouter({ engine: routerEngine0, registry: routerProviders0, bindingEngine: new DriverBindingEngine(routerEngine0, routerProviders0) })
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

  it("rejects a protocol outside avr/heos/yamaha", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/auto-media`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ protocol: "casambi" }),
    });
    expect(res.status).toBe(422);
  });

  it("auto-assigns a room from a strong hint, auto-generates the extra zone as its own device, and leaves the hint-less unit Unassigned", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/auto-media`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ protocol: "yamaha" }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      devices: number;
      roomsCreated: number;
      unassigned: number;
      created: { name: string; room: string | null; confidence: number; autoAssigned: boolean }[];
    };
    // 2 discovered units + 1 auto-generated zone2 device for the first unit = 3.
    expect(out.devices).toBe(3);
    expect(out.roomsCreated).toBe(2); // "Media Room" + "Unassigned Devices"
    expect(out.unassigned).toBe(1);

    const main = out.created.find((d) => d.name === "Media Room");
    expect(main).toMatchObject({ room: "Media Room", confidence: 90, autoAssigned: true });
    const zone2 = out.created.find((d) => d.name === "Media Room Zone 2");
    expect(zone2).toMatchObject({ room: "Media Room", confidence: 90, autoAssigned: true });
    const hintless = out.created.find((d) => d.name === "Yamaha 192.168.1.71");
    expect(hintless).toMatchObject({ room: "Unassigned Devices", confidence: 0, autoAssigned: false });

    // The zone2 device shares the SAME physical address as the main-zone device, and
    // was bound with config.zone="zone2" — proving it's the same physical connection,
    // not a fabricated second unit.
    const zone2Bindings = driver.bindCalls.filter((b) => b.config?.zone === "zone2");
    expect(zone2Bindings.length).toBeGreaterThan(0);
    expect(zone2Bindings.every((b) => b.address === "192.168.1.70")).toBe(true);

    const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth() })).json()) as { rooms: { id: string; name: string }[] };
    const mediaRoom = home.rooms.find((r) => r.name === "Media Room")!;
    expect(mediaRoom).toBeTruthy();
    const unassignedRoom = home.rooms.find((r) => r.name === "Unassigned Devices")!;
    expect(unassignedRoom).toBeTruthy();

    // Control the main-zone device — the command must reach the fake bus.
    const mediaDevices = (await (await fetch(`${baseUrl}/v1/rooms/${mediaRoom.id}/devices`, { headers: auth() })).json()) as {
      devices: { id: string; name: string }[];
    };
    const mainDeviceId = mediaDevices.devices.find((d) => d.name === "Media Room")!.id;
    const cmd = await fetch(`${baseUrl}/v1/devices/${mainDeviceId}/command`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    expect(cmd.status).toBeLessThan(300);
    expect(driver.commands.at(-1)).toMatchObject({ command: { capability: "onoff", action: "on" } });
  });

  it("a repeat run doesn't re-commission or re-expand zones for already-bound devices", async () => {
    const res = await fetch(`${baseUrl}/v1/commissioning/auto-media`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ protocol: "yamaha" }),
    });
    // Everything discoverable was already commissioned by the previous test.
    expect(res.status).toBe(422);
  });
});

/** A minimal in-process Denon-style receiver — same query/reply shape as
 * `avr-probe.test.ts`'s own `startFakeAvr`, kept local here since it exercises a
 * different caller (`autoCommissionMedia`, not `probeAvr` directly). Only ever
 * answers the handful of `?` queries the init burst sends. */
function startFakeDenonReceiver(): Promise<{ server: import("node:net").Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts) {
          if (cmd === "PW?") sock.write("PWON\r");
          else if (cmd === "ZM?") sock.write("ZMON\r");
          else if (cmd === "MV?") sock.write("MV50\r");
          else if (cmd === "MU?") sock.write("MUOFF\r");
          else if (cmd === "SI?") sock.write("SICD\r");
          // The paced init-sync handshake (av-sdk/init-handshake.ts) sends one query at a
          // time and only advances on a reply to THAT query — every unconditional base
          // token must be answered or the handshake stalls before ever reaching Z2?/Z2MU?
          // (the tokens actually under test here), never a timing race.
          else if (cmd === "PSTONE CTRL ?") sock.write("PSTONE CTRL ON\r");
          else if (cmd === "PSBAS ?") sock.write("PSBAS 50\r");
          else if (cmd === "PSTRE ?") sock.write("PSTRE 50\r");
          else if (cmd === "MS?") sock.write("MSMOVIE\r");
          else if (cmd === "Z2?") sock.write("Z2ON\r"); // Zone 2 answers — this is the unit under test
          else if (cmd === "Z2MU?") sock.write("Z2MUOFF\r");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

/**
 * § Fix — auto-commission's Denon/Marantz Telnet path could never report a Zone 2
 * because `discover()`'s SSDP/UPnP scan has no wire signal for it (unlike Yamaha's real
 * getFeatures() query). This proves `autoCommissionMedia("avr")` now runs the SAME
 * active zone2 probe `probeAvr` already uses for the manual-add flow, against a REAL
 * fake receiver — not a fabricated capability.
 */
describe("Auto-commission media — AVR active zone2 probe (§ auto-discovery Zone 2 fix)", () => {
  it("auto-generates a Zone 2 device for a real Denon-shaped unit whose receiver answers Z2?, using the same active probe as manual add", async () => {
    const fake = await startFakeDenonReceiver();
    try {
      class FakeAvrDiscovery implements INativeProtocolDriver {
        readonly protocol = "avr";
        private readonly devices = new Set<DeviceId>();
        private readonly listeners = new Set<StateListener>();
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        isConnected(): boolean { return true; }
        async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
        manages(id: DeviceId): boolean { return this.devices.has(id); }
        async command(): Promise<void> {}
        getState(): CapabilityState | null { return null; }
        async discover(): Promise<DiscoveredDevice[]> {
          return [
            {
              backendId: `127.0.0.1:${fake.port}`,
              suggestedName: "Theater Receiver",
              capabilities: ["onoff", "media"],
              // No `raw.zones` at all — exactly what real Denon Telnet discovery
              // produces (no wire-level zone signal), unlike the Yamaha fixture above.
              raw: { protocol: "avr", bindConfig: { zone: "main" } },
            },
          ];
        }
        onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
      }

      const registry = new EntityRegistryMirror();
      const engine = new SupremeNativeAdapter({ drivers: [new FakeAvrDiscovery()] });
      const providers = new ProviderRegistry();
      const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
      const sil = new SupremeIntegrationLayer({ adapter: router, registry });
      const avrCtx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
        sil,
        protocolBindingStore: new InMemoryProtocolBindingStore(),
      });
      const avrApp = await buildServer(avrCtx);
      await avrApp.listen({ host: "127.0.0.1", port: 0 });
      const addr = avrApp.server.address();
      const avrBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      try {
        const loginRes = await fetch(`${avrBaseUrl}/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
        });
        const avrToken = ((await loginRes.json()) as { accessToken: string }).accessToken;
        const avrAuth = { authorization: `Bearer ${avrToken}`, "content-type": "application/json" };

        const res = await fetch(`${avrBaseUrl}/v1/commissioning/auto-media`, {
          method: "POST",
          headers: avrAuth,
          body: JSON.stringify({ protocol: "avr" }),
        });
        expect(res.status).toBe(201);
        const out = (await res.json()) as { devices: number; created: { name: string; room: string | null }[] };
        expect(out.devices).toBe(2); // main + the actively-probed zone2
        const zone2 = out.created.find((d) => d.name === "Theater Receiver Zone 2");
        expect(zone2).toBeTruthy();
      } finally {
        await avrApp.close();
        await avrCtx.shutdown();
      }
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 15_000);

  it("commissions only the main zone when the receiver never answers Z2? (honest — no fabricated zone)", async () => {
    class FakeAvrNoZone2 implements INativeProtocolDriver {
      readonly protocol = "avr";
      private readonly devices = new Set<DeviceId>();
      private readonly listeners = new Set<StateListener>();
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      isConnected(): boolean { return true; }
      async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
      manages(id: DeviceId): boolean { return this.devices.has(id); }
      async command(): Promise<void> {}
      getState(): CapabilityState | null { return null; }
      async discover(): Promise<DiscoveredDevice[]> {
        return [
          {
            // Nothing real is listening here — the active probe must fail closed
            // (unreachable), never fabricating a zone2 it couldn't confirm.
            backendId: "127.0.0.1:1",
            suggestedName: "Bedroom Receiver",
            capabilities: ["onoff", "media"],
            raw: { protocol: "avr", bindConfig: { zone: "main" } },
          },
        ];
      }
      onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
    }

    const registry = new EntityRegistryMirror();
    const engine = new SupremeNativeAdapter({ drivers: [new FakeAvrNoZone2()] });
    const providers = new ProviderRegistry();
    const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
    const sil = new SupremeIntegrationLayer({ adapter: router, registry });
    const avrCtx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      protocolBindingStore: new InMemoryProtocolBindingStore(),
    });
    const avrApp = await buildServer(avrCtx);
    await avrApp.listen({ host: "127.0.0.1", port: 0 });
    const addr = avrApp.server.address();
    const avrBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const loginRes = await fetch(`${avrBaseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      });
      const avrToken = ((await loginRes.json()) as { accessToken: string }).accessToken;
      const avrAuth = { authorization: `Bearer ${avrToken}`, "content-type": "application/json" };

      const res = await fetch(`${avrBaseUrl}/v1/commissioning/auto-media`, {
        method: "POST",
        headers: avrAuth,
        body: JSON.stringify({ protocol: "avr" }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { devices: number; created: { name: string }[] };
      expect(out.devices).toBe(1); // main zone only — no fabricated zone2
      expect(out.created.some((d) => d.name.includes("Zone 2"))).toBe(false);
    } finally {
      await avrApp.close();
      await avrCtx.shutdown();
    }
  }, 15_000);

  it("also surfaces Zone 2 as its own card on the Discover Devices LIST (not just auto-media commissioning)", async () => {
    const fake = await startFakeDenonReceiver();
    try {
      class FakeAvrDiscovery implements INativeProtocolDriver {
        readonly protocol = "avr";
        private readonly devices = new Set<DeviceId>();
        private readonly listeners = new Set<StateListener>();
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        isConnected(): boolean { return true; }
        async bind(b: ProtocolBinding): Promise<void> { this.devices.add(b.deviceId); }
        manages(id: DeviceId): boolean { return this.devices.has(id); }
        async command(): Promise<void> {}
        getState(): CapabilityState | null { return null; }
        async discover(): Promise<DiscoveredDevice[]> {
          return [
            {
              backendId: `127.0.0.1:${fake.port}`,
              suggestedName: "Theater Receiver",
              capabilities: ["onoff", "media"],
              raw: { protocol: "avr", bindConfig: { zone: "main" } },
            },
          ];
        }
        onState(l: StateListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
      }

      const registry = new EntityRegistryMirror();
      const engine = new SupremeNativeAdapter({ drivers: [new FakeAvrDiscovery()] });
      const providers = new ProviderRegistry();
      const router = new ProviderRouter({ engine, registry: providers, bindingEngine: new DriverBindingEngine(engine, providers) });
      const sil = new SupremeIntegrationLayer({ adapter: router, registry });
      const avrCtx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
        sil,
        protocolBindingStore: new InMemoryProtocolBindingStore(),
      });
      const avrApp = await buildServer(avrCtx);
      await avrApp.listen({ host: "127.0.0.1", port: 0 });
      const addr = avrApp.server.address();
      const avrBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      try {
        const loginRes = await fetch(`${avrBaseUrl}/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
        });
        const avrToken = ((await loginRes.json()) as { accessToken: string }).accessToken;
        const avrAuth = { authorization: `Bearer ${avrToken}`, "content-type": "application/json" };

        // No `protocol` filter — the discover-list route resolves a `protocol` filter to
        // installed-catalog driverIds first, which this minimal fixture never installs. Omitting
        // it runs every registered native driver unfiltered (same as autoCommissionMedia's own
        // `sil.discover()` bypass), which is enough to exercise the zone2-probe splice.
        const res = await fetch(`${avrBaseUrl}/v1/commissioning/discover`, {
          method: "POST",
          headers: avrAuth,
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const out = (await res.json()) as {
          discovered: { backendId: string; suggestedName: string; bindAddress?: string; bindConfig?: Record<string, unknown> }[];
        };
        expect(out.discovered).toHaveLength(2);
        const main = out.discovered.find((d) => d.suggestedName === "Theater Receiver");
        const zone2 = out.discovered.find((d) => d.suggestedName === "Theater Receiver Zone 2");
        expect(main).toBeTruthy();
        expect(zone2).toBeTruthy();
        // Zone 2's identity is suffixed for uniqueness, but it must carry the base unit's
        // real address + zone config so pairing it binds correctly instead of trying to
        // connect to the literal "<ip>#zone2" string.
        expect(zone2!.backendId).toBe(`127.0.0.1:${fake.port}#zone2`);
        expect(zone2!.bindAddress).toBe(`127.0.0.1:${fake.port}`);
        expect(zone2!.bindConfig).toEqual({ zone: "zone2" });
      } finally {
        await avrApp.close();
        await avrCtx.shutdown();
      }
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  }, 15_000);
});
