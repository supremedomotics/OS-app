import { newId, type CapabilityState, type DeviceId, type HomeId, type KeypadInputEvent } from "@supreme/domain-model";
import type { AutomationExecutors } from "@supreme/automations";
import { EntityRegistryMirror, SupremeNativeAdapter, SupremeIntegrationLayer } from "@supreme/integration-layer";
import { CasambiProtocolDriver, LutronProtocolDriver, SupremeKnxDriver } from "@supreme/protocols";
import type { IKnxProvider, KnxTask, KnxProviderDiagnostics, KnxProviderHealth } from "@supreme/protocols";
import type { UdpTransport } from "@supreme/lan";
import { KeypadMappingEngine, KeypadMappingService, UniversalInputEngine, InMemoryKeypadMappingStore } from "@supreme/keypad-framework";
import { afterEach, describe, expect, it } from "vitest";
import type net from "node:net";
import { EventEmitter } from "node:events";

/**
 * § Supreme Universal Keypad, Stage 4A — Cross-Protocol Vertical Slice.
 *
 * Proves the FULL, REAL execution path exists end to end with NO keypad-specific execution
 * engine and NO protocol-specific branch anywhere above each driver's own boundary:
 *
 *   physical Casambi UDP telegram
 *     -> CasambiProtocolDriver decodes it (real, unmodified decode path)
 *     -> CasambiProtocolDriver.onInputEvent (Stage 4A's one new bridge — driver-owned identity
 *        resolution only, see casambi-driver.ts)
 *     -> SupremeNativeAdapter's generic per-driver `onInputEvent` wiring (pre-existing,
 *        unmodified — the same fan-out every driver's state events already use)
 *     -> SupremeIntegrationLayer.subscribeKeypadInput (pre-existing passthrough)
 *     -> UniversalInputEngine.ingest (pre-existing, protocol-agnostic press-timing engine)
 *     -> KeypadMappingService.onInputEvent -> KeypadMappingEngine (Stage 2, unmodified)
 *     -> resolveBehaviorCommand / runAutomationAction (Stage 2, unmodified)
 *     -> AutomationExecutors.command == SupremeNativeAdapter.command (pre-existing, the SAME
 *        generic dispatcher every Automation/Scene action already uses)
 *     -> the TARGET protocol's own driver (KNX / Lutron), each exercised through its own
 *        existing, real DI seam (KNX's `IKnxProvider`, Lutron's `createSocket`) — never a fake
 *        protocol implementation invented for this test.
 *
 * Nothing here is a keypad-specific abstraction: `SupremeNativeAdapter`, `SupremeIntegrationLayer`,
 * `KeypadMappingEngine`, and every protocol driver are used completely unmodified from how
 * production wires them (see `services/gateway/src/context.ts` for the identical wiring this
 * test reproduces by hand, minus the HTTP/manifest/commissioning machinery irrelevant to this
 * proof).
 */

// ── Casambi Local UDP fake transport — IDENTICAL to casambi-driver.test.ts's own fake, the
// established convention for exercising the real UDP decode path without a real socket. ──
class FakeUdpTransport implements UdpTransport {
  sent: string[] = [];
  closed = false;
  private messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private listeningListeners = new Set<() => void>();
  private bound: { address: string; port: number } | null = null;
  async bind(opts: { localPort?: number; localAddress?: string } = {}): Promise<void> {
    this.bound = { address: opts.localAddress ?? "0.0.0.0", port: opts.localPort ?? 5100 };
    for (const l of this.listeningListeners) l();
  }
  async send(data: Buffer): Promise<void> {
    this.sent.push(data.toString("ascii"));
  }
  async joinMulticast(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  onMessage(cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }
  onListening(cb: () => void): () => void {
    this.listeningListeners.add(cb);
    return () => this.listeningListeners.delete(cb);
  }
  address(): { address: string; port: number } | null {
    return this.bound;
  }
  receive(raw: string): void {
    for (const l of this.messageListeners) l(Buffer.from(raw, "ascii"), { address: "192.168.1.90", port: 5100 });
  }
}

// ── KNX fake provider — the SAME shape/convention as
// services/integration-layer/src/knx-feedback-adapter.e2e.test.ts's FakeKnxProvider. ──
class FakeKnxProvider implements IKnxProvider {
  readonly name = "fake";
  connected = false;
  writes: KnxTask[] = [];
  private observers = new Map<string, (value: unknown) => void>();
  async initialize(): Promise<void> {}
  async discover() { return []; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async shutdown(): Promise<void> { this.connected = false; }
  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "bus.group_write") { this.writes.push(task); return undefined; }
    if (task.kind === "bus.group_read") return undefined;
    throw new Error(`unsupported: ${task.kind}`);
  }
  subscribe(ga: string, _dpt: string, handler: (value: unknown) => void): void { this.observers.set(ga, handler); }
  unsubscribe(ga: string): void { this.observers.delete(ga); }
  health(): KnxProviderHealth { return { connected: this.connected, lastError: null }; }
  diagnostics(): KnxProviderDiagnostics {
    return { provider: this.name, connected: this.connected, packetsSent: this.writes.length, packetsReceived: 0, lastTelegramAt: null, lastCommandAt: null, lastError: null, reconnectAttempts: 0 };
  }
  /** Simulates a REAL external system (a physical keypad, an installer's ETS panel, anything
   * else on the bus) changing the light's status GA — the exact mechanism §2's "authoritative
   * toggle" proof needs. */
  emit(ga: string, value: unknown): void { this.observers.get(ga)?.(value); }
}

// ── Lutron fake bridge socket — exercises LutronProtocolDriver's own EXISTING `createSocket`
// DI seam (lutron-driver.ts), the real login/password/GNET> handshake + ~OUTPUT report format
// (lutron-codec.ts's parseLutronLine) — not a fabricated protocol, the driver's own real wire
// parser driven by a fake transport, same posture as Casambi's udpTransportFactory. ──
class FakeLutronSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  setEncoding(): void {}
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Drives the real driver through its real login handshake. */
  handshake(): void {
    this.emit("data", "login: ");
    this.emit("data", "password: ");
    this.emit("data", "GNET> ");
  }
  /** A REAL ~OUTPUT status report — e.g. from a physical Lutron keypad/switch reporting a level. */
  reportOutput(id: string, level: number): void {
    this.emit("data", `~OUTPUT,${id},1,${level}\r\n`);
  }
}

function executors(adapter: SupremeNativeAdapter): AutomationExecutors {
  return {
    command: (deviceId, command) => adapter.command(deviceId, command),
    getState: (deviceId, capability) => Promise.resolve(adapter.getState(deviceId, capability)),
    activateScene: async () => {},
    notify: async () => {},
  };
}

describe("Supreme Universal Keypad — Stage 4A cross-protocol vertical slice", () => {
  let cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  /** Wires the REAL execution path — SupremeNativeAdapter -> SIL -> UniversalInputEngine ->
   * KeypadMappingService -> KeypadMappingEngine -> AutomationExecutors -> target driver —
   * exactly as `context.ts` does in production, minus HTTP/manifest machinery. */
  async function wireKeypadPipeline(drivers: import("@supreme/integration-layer").INativeProtocolDriver[]) {
    const adapter = new SupremeNativeAdapter({ drivers });
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();
    const mappingEngine = new KeypadMappingEngine({ executors: executors(adapter), sleep: async () => {} });
    const mappingService = new KeypadMappingService(mappingEngine, new InMemoryKeypadMappingStore());
    await mappingService.start();
    const inputEngine = new UniversalInputEngine({
      publish: (event: KeypadInputEvent) => { void mappingService.onInputEvent(event); },
    });
    const unsub = sil.subscribeKeypadInput((event) => inputEngine.ingest(event));
    cleanup.push(() => { unsub(); inputEngine.dispose(); });
    return { adapter, sil, mappingEngine, mappingService };
  }

  it("1. Casambi Button 1 -> Short Press -> Direct -> KNX Light (deviceId + capability, not protocol)", async () => {
    const registry = new EntityRegistryMirror();
    const socket = new FakeUdpTransport();
    const casambi = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: (deviceId) => {
          const backendId = registry.backendIdOfDevice(deviceId);
          return backendId ? Number(backendId.split(":").pop()) : null;
        },
      },
    });
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadId = newId("device") as DeviceId;
    const lightId = newId("device") as DeviceId;
    registry.mapDevice(keypadId, "casambi:4"); // § Stage 3A's real capability-less registration

    const { adapter, mappingService } = await wireKeypadPipeline([casambi, knx]);
    cleanup.push(() => casambi.disconnect());
    await adapter.bind({ deviceId: lightId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } }, "knx");

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "Button 1 -> KNX Light",
      input: { keypadId, control: "1", event: "short_press" },
      behavior: "direct",
      actions: [{ type: "device_command", deviceId: lightId, command: { capability: "onoff", action: "on" } }],
    });

    socket.receive("0.70.5.51.4.1.1.2\r\n"); // real 0x51 telegram: unit 4, button 1, short press
    await new Promise((r) => setTimeout(r, 5));

    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ kind: "bus.group_write", groupAddress: "1/1/1" });
  });

  it("2. Authoritative toggle: KNX Light OFF -> press -> ON; external change to OFF -> press -> ON again (never a locally cached boolean)", async () => {
    const registry = new EntityRegistryMirror();
    const socket = new FakeUdpTransport();
    const casambi = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadId = newId("device") as DeviceId;
    const lightId = newId("device") as DeviceId;
    registry.mapDevice(keypadId, "casambi:4");

    const { adapter, mappingService } = await wireKeypadPipeline([casambi, knx]);
    cleanup.push(() => casambi.disconnect());
    await adapter.bind({ deviceId: lightId, capability: "onoff", address: "1/1/1", config: { statusAddress: "1/1/2" } }, "knx");

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "Toggle KNX Light",
      input: { keypadId, control: "1", event: "short_press" },
      behavior: "toggle",
      target: { deviceId: lightId, capability: "onoff", step: 10 },
    });

    // Light starts OFF (a real status telegram, not an assumption).
    provider.emit("1/1/2", false);
    await new Promise((r) => setTimeout(r, 5));
    expect(await adapter.getState(lightId, "onoff")).toMatchObject({ on: false });

    socket.receive("0.70.5.51.4.1.1.2\r\n"); // press #1
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes.at(-1)).toMatchObject({ groupAddress: "1/1/1", value: true });

    // Real driver feedback loop: the write it just sent is echoed back as the light's own
    // status, exactly like a real KNX actuator confirming it turned on.
    provider.emit("1/1/2", true);
    await new Promise((r) => setTimeout(r, 5));

    // An EXTERNAL system (an installer's ETS panel, a different keypad entirely) turns the
    // light off — never through this keypad's mapping.
    provider.emit("1/1/2", false);
    await new Promise((r) => setTimeout(r, 5));
    expect(await adapter.getState(lightId, "onoff")).toMatchObject({ on: false });

    socket.receive("0.70.5.51.4.1.1.2\r\n"); // press #2 — must read the REAL current state
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes.at(-1)).toMatchObject({ groupAddress: "1/1/1", value: true });
  });

  it("3. Casambi Button 2 -> Short Press -> Toggle -> Lutron output (second protocol, same pipeline, zero protocol branches)", async () => {
    const registry = new EntityRegistryMirror();
    const socket = new FakeUdpTransport();
    const casambi = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    const lutronSocket = new FakeLutronSocket();
    const lutron = new LutronProtocolDriver({ host: "10.0.0.2", createSocket: () => lutronSocket as unknown as net.Socket });

    const keypadId = newId("device") as DeviceId;
    const shadeLightId = newId("device") as DeviceId;
    registry.mapDevice(keypadId, "casambi:4");

    const { adapter, mappingService } = await wireKeypadPipeline([casambi, lutron]);
    cleanup.push(() => casambi.disconnect());
    await adapter.bind({ deviceId: shadeLightId, capability: "onoff", address: "2" }, "lutron");
    lutronSocket.handshake(); // real login/password/GNET> exchange the real driver requires

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "Button 2 -> Lutron",
      input: { keypadId, control: "2", event: "short_press" },
      behavior: "toggle",
      target: { deviceId: shadeLightId, capability: "onoff", step: 10 },
    });

    lutronSocket.reportOutput("2", 0); // real feedback: output 2 currently off
    await new Promise((r) => setTimeout(r, 5));

    socket.receive("0.70.5.51.4.1.2.2\r\n"); // unit 4, button 2, short press
    await new Promise((r) => setTimeout(r, 5));

    expect(lutronSocket.written.some((w) => w.includes("#OUTPUT,2,1,100"))).toBe(true);
  });

  it("4. Non-light capability: Casambi Button 3 -> Increment -> KNX blind/shade position", async () => {
    const registry = new EntityRegistryMirror();
    const socket = new FakeUdpTransport();
    const casambi = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadId = newId("device") as DeviceId;
    const blindId = newId("device") as DeviceId;
    registry.mapDevice(keypadId, "casambi:4");

    const { adapter, mappingService } = await wireKeypadPipeline([casambi, knx]);
    cleanup.push(() => casambi.disconnect());
    await adapter.bind({ deviceId: blindId, capability: "position", address: "2/1/1", config: { statusAddress: "2/1/2" } }, "knx");

    provider.emit("2/1/2", 50); // blind currently at 50% (a real status telegram)
    await new Promise((r) => setTimeout(r, 5));

    await mappingService.create({
      homeId: newId("home") as HomeId,
      name: "Button 3 -> Blind increment",
      input: { keypadId, control: "3", event: "short_press" },
      behavior: "increment",
      target: { deviceId: blindId, capability: "position", step: 20 },
    });

    socket.receive("0.70.5.51.4.1.3.2\r\n"); // unit 4, button 3, short press
    await new Promise((r) => setTimeout(r, 5));

    expect(provider.writes.at(-1)).toMatchObject({ groupAddress: "2/1/1" });
  });

  it("5. Multi-instance isolation: two Casambi networks, both Unit 4, never cross-fire each other's mapping", async () => {
    const registry = new EntityRegistryMirror();
    const socketA = new FakeUdpTransport();
    const socketB = new FakeUdpTransport();
    // Network A: primary instance, bare "casambi:4" addressing (§ Multi-network Casambi Stage 4).
    const casambiA = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socketA },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    // Network B: a second instance, scoped "casambi:drv_net2:4" addressing — the SAME scheme
    // native-driver-factory.ts's withCasambiInstanceAddressing already applies in production.
    const casambiB = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.91", restPort: 80, udpPort: 5101, netId: 0, udpTransportFactory: () => socketB },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:drv_net2:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadA = newId("device") as DeviceId;
    const keypadB = newId("device") as DeviceId;
    const lightA = newId("device") as DeviceId;
    const lightB = newId("device") as DeviceId;
    registry.mapDevice(keypadA, "casambi:4");
    registry.mapDevice(keypadB, "casambi:drv_net2:4");

    const { adapter, mappingService } = await wireKeypadPipeline([casambiA, casambiB, knx]);
    cleanup.push(() => casambiA.disconnect(), () => casambiB.disconnect());
    await adapter.bind({ deviceId: lightA, capability: "onoff", address: "1/1/1" }, "knx");
    await adapter.bind({ deviceId: lightB, capability: "onoff", address: "1/1/3" }, "knx");

    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Network A mapping",
      input: { keypadId: keypadA, control: "4", event: "short_press" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: lightA, command: { capability: "onoff", action: "on" } }],
    });
    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Network B mapping",
      input: { keypadId: keypadB, control: "4", event: "short_press" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: lightB, command: { capability: "onoff", action: "on" } }],
    });

    // Network A's Unit 4 fires — only Network A's mapping/light must react.
    socketA.receive("0.70.5.51.4.1.4.2\r\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({ groupAddress: "1/1/1" });

    // Network B's Unit 4 (the SAME unit id) fires — only Network B's mapping/light reacts.
    socketB.receive("0.70.5.51.4.1.4.2\r\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes).toHaveLength(2);
    expect(provider.writes[1]).toMatchObject({ groupAddress: "1/1/3" });
  });

  it("6. Long press start/end remain distinct — two independent mappings never merge", async () => {
    const registry = new EntityRegistryMirror();
    const socket = new FakeUdpTransport();
    const casambi = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
      keypadIdentity: {
        deviceIdForUnit: (unitId) => registry.reverseLookupDevice(`casambi:${unitId}`) ?? null,
        unitForDeviceId: () => null,
      },
    });
    const provider = new FakeKnxProvider();
    const knx = new SupremeKnxDriver({ host: "10.0.0.1", ultimateProvider: provider });

    const keypadId = newId("device") as DeviceId;
    const lightId = newId("device") as DeviceId;
    registry.mapDevice(keypadId, "casambi:4");

    const { adapter, mappingService } = await wireKeypadPipeline([casambi, knx]);
    cleanup.push(() => casambi.disconnect());
    await adapter.bind({ deviceId: lightId, capability: "onoff", address: "1/1/1" }, "knx");

    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Long press start",
      input: { keypadId, control: "0", event: "hold_start" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: lightId, command: { capability: "onoff", action: "on" } }],
    });
    await mappingService.create({
      homeId: newId("home") as HomeId, name: "Long press end",
      input: { keypadId, control: "0", event: "hold_end" },
      behavior: "direct", actions: [{ type: "device_command", deviceId: lightId, command: { capability: "onoff", action: "off" } }],
    });

    socket.receive("0.70.5.51.4.1.0.9\r\n"); // long press start
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes.at(-1)).toMatchObject({ value: true });

    socket.receive("0.70.5.51.4.1.0.c\r\n"); // long press end
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.writes.at(-1)).toMatchObject({ value: false });
    expect(provider.writes).toHaveLength(2); // exactly one write per event, never merged/duplicated
  });
});
