import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasambiProtocolDriver } from "./casambi-driver.js";
import type {
  CasambiEvent,
  CasambiNetwork,
  CasambiSession,
  CasambiTransport,
  CasambiWire,
  CasambiWireHandlers,
} from "./cloud-transport.js";
import type { CasambiUnit } from "./entity-mapper.js";
import type { UdpTransport } from "@supreme/lan";
import type { CasambiDriverEvent } from "./event-engine.js";

/** A captured WebSocket wire — records every framed message the driver sends. */
class FakeWire implements CasambiWire {
  connected = true;
  opens: number[] = [];
  pings = 0;
  controls: { unitId: number; targetControls: Record<string, unknown> }[] = [];
  open(_session: CasambiSession, wire: number): void {
    this.opens.push(wire);
  }
  ping(_wire: number): void {
    this.pings += 1;
  }
  controlUnit(_wire: number, unitId: number, targetControls: Record<string, unknown>): void {
    this.controls.push({ unitId, targetControls });
  }
  close(): void {
    this.connected = false;
  }
}

/** An in-memory Casambi cloud: serves a fixed network, streams events the test injects. */
class FakeCasambiTransport implements CasambiTransport {
  sessions = 0;
  fetches = 0;
  handlers: CasambiWireHandlers | null = null;
  wire = new FakeWire();
  constructor(
    private readonly network: CasambiNetwork,
    private readonly stateUnits: CasambiUnit[] = [],
  ) {}
  async createSession(): Promise<CasambiSession> {
    this.sessions += 1;
    return { sessionId: "sess-1", networkId: "net-1", networkName: "Villa" };
  }
  async fetchNetwork(): Promise<CasambiNetwork> {
    this.fetches += 1;
    return this.network;
  }
  async fetchState(): Promise<CasambiUnit[]> {
    return this.stateUnits;
  }
  async openWire(handlers: CasambiWireHandlers): Promise<CasambiWire> {
    this.handlers = handlers;
    this.wire = new FakeWire();
    return this.wire;
  }
  emit(event: CasambiEvent): void {
    this.handlers?.onEvent(event);
  }
  drop(): void {
    this.wire.connected = false;
    this.handlers?.onClose();
  }
}

const NETWORK: CasambiNetwork = {
  units: [
    { id: 45, name: "Ceiling", type: "Luminaire", groupId: 1, controls: [{ type: "Dimmer", value: 0 }, { type: "CCT", value: 4000, min: 2700, max: 6000 }] },
    { id: 46, name: "Blind", groupId: 1, controls: [{ type: "Slider", value: 0, min: 0, max: 100 }] },
  ],
  groups: [{ id: 1, name: "Living Room", units: [45, 46] }],
};

const creds = { apiKey: "key", email: "a@b.com", password: "pw", networkId: "net-1" };
const dev = "device-ceiling" as DeviceId;

const nextEvent = (driver: CasambiProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = driver.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("CasambiProtocolDriver (fake transport)", () => {
  it("authenticates, opens a wire, and seeds state", async () => {
    const transport = new FakeCasambiTransport(NETWORK, [
      { id: 45, dimLevel: 0.5, controls: [{ type: "Dimmer", value: 0.5 }, { type: "CCT", value: 4000, min: 2700, max: 6000 }] },
    ]);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport });
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:45" });
    await driver.connect();

    expect(transport.sessions).toBe(1);
    expect(transport.wire.opens).toEqual([1]);
    expect(driver.isConnected()).toBe(true);
    expect(driver.getState(dev, "brightness")).toEqual({ kind: "brightness", on: true, level: 50 });
    await driver.disconnect();
  });

  it("maps Casambi groups to Supreme rooms via discovery", async () => {
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport });
    await driver.connect();
    const discovered = await driver.discover();

    const ceiling = discovered.find((d) => d.backendId === "casambi:45");
    expect(ceiling).toMatchObject({ suggestedName: "Ceiling", capabilities: ["brightness", "color"] });
    expect(ceiling?.raw.room).toBe("Living Room");
    const blind = discovered.find((d) => d.backendId === "casambi:46");
    expect(blind?.capabilities).toEqual(["position"]);
    await driver.disconnect();
  });

  it("emits normalized state from a unitChanged event", async () => {
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport });
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:45" });
    await driver.connect();

    const ev = nextEvent(driver, (e) => e.capability === "brightness");
    transport.emit({ method: "unitChanged", id: 45, dimLevel: 0.75, controls: [{ type: "Dimmer", value: 0.75 }] });
    const state = (await ev).state;
    expect(state).toEqual({ kind: "brightness", on: true, level: 75 });
  });

  it("translates commands into controlUnit target controls", async () => {
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport });
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:45" });
    await driver.bind({ deviceId: dev, capability: "color", address: "casambi:45" });
    await driver.connect();

    await driver.command(dev, { capability: "brightness", action: "set", level: 40 });
    await driver.command(dev, { capability: "color", kelvin: 3000 });
    expect(transport.wire.controls).toEqual([
      { unitId: 45, targetControls: { Dimmer: { value: 0.4 } } },
      { unitId: 45, targetControls: { ColorTemperature: { value: 3000 }, Colorsource: { source: "TW" } } },
    ]);
    await driver.disconnect();
  });

  it("refuses commands while the wire is down", async () => {
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport, reconnectBaseMs: 10_000_000 });
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:45" });
    await driver.connect();
    transport.drop();
    await expect(driver.command(dev, { capability: "brightness", action: "on" })).rejects.toThrow(/not connected/);
    await driver.disconnect();
  });

  it("auto-reconnects with a fresh session after the socket drops", async () => {
    vi.useFakeTimers();
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport, reconnectBaseMs: 1_000, reconnectMaxMs: 1_000 });
    await driver.connect();
    expect(transport.sessions).toBe(1);

    transport.drop();
    expect(driver.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(transport.sessions).toBe(2);
    expect(driver.isConnected()).toBe(true);
    expect(driver.getHealth().reconnects).toBe(0); // reset once the fresh wire opens
    await driver.disconnect();
  });

  it("keeps the wire alive with heartbeat pings", async () => {
    vi.useFakeTimers();
    const transport = new FakeCasambiTransport(NETWORK);
    const driver = new CasambiProtocolDriver({ credentials: creds, transport, pingIntervalMs: 1_000 });
    await driver.connect();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(transport.wire.pings).toBe(3);
    await driver.disconnect();
  });
});

/** A real event-emitting fake `UdpTransport` for Local-mode driver tests (§ LAN Transport Phase 2
 * — Casambi no longer owns a raw socket or a Casambi-specific socket interface) — see
 * `local-transport/udp-engine.test.ts` for the same pattern used directly against
 * `CasambiUdpEngine`. */
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

describe("CasambiProtocolDriver (Local Gateway, fake UDP socket)", () => {
  function makeLocalDriver() {
    const socket = new FakeUdpTransport();
    const driver = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpTransportFactory: () => socket },
    });
    return { socket, driver };
  }

  it("connect() binds the UDP socket and reports isConnected() true", async () => {
    const { driver } = makeLocalDriver();
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
  });

  it("connect() sends the SetDefaultMask/Subscribe/NotifyButtonEvent bootstrap sequence", async () => {
    const { socket, driver } = makeLocalDriver();
    await driver.connect();
    expect(socket.sent).toEqual([
      "0.72.8.4b.3.0.0.ff.ff.ff.ff\r\n", // SetDefaultMask
      "0.72.4.4b.1.0.fa\r\n", // Subscribe target ids 0..250
      "0.72.2.50.fd\r\n", // NotifyButtonEvent enable
    ]);
    await driver.disconnect();
  });

  it("disconnect() sends the teardown sequence and stops the socket", async () => {
    const { socket, driver } = makeLocalDriver();
    await driver.connect();
    socket.sent.length = 0;
    await driver.disconnect();
    expect(socket.sent).toEqual(["0.72.2.50.0\r\n", "0.72.4.4b.0.0.fa\r\n"]);
    expect(socket.closed).toBe(true);
    expect(driver.isConnected()).toBe(false);
  });

  it("an incoming NotifyControlValues packet updates state for a bound device", async () => {
    const { socket, driver } = makeLocalDriver();
    const dev = "local-dev-5" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:5" });
    await driver.connect();

    const changed = new Promise<BackendStateEvent>((resolve) => {
      const off = driver.onState((e) => {
        if (e.deviceId === dev) {
          off();
          resolve(e);
        }
      });
    });
    // 0x4B: Target_ID=5, TYPE=1 (dimmerChannel)=200
    socket.receive("0.70.4.4b.5.1.c8\r\n");
    const state = (await changed).state;
    expect(state).toEqual({ kind: "brightness", on: true, level: Math.round((200 / 255) * 100) });
    await driver.disconnect();
  });

  it("command() sends a real UDP packet for a bound device", async () => {
    const { socket, driver } = makeLocalDriver();
    const dev = "local-dev-5" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "casambi:5" });
    await driver.connect();
    socket.sent.length = 0;

    await driver.command(dev, { capability: "onoff", action: "on" });
    // § live-confirmed fix — full-length 0x20 (explicit 0 Duration) so Target_Type/Target_ID land
    // where the gateway actually reads them; the old short form broadcast to the whole network.
    expect(socket.sent).toEqual(["0.72.6.20.ff.0.0.1.5\r\n"]);
    await driver.disconnect();
  });

  it("command() refuses when the UDP socket is not listening", async () => {
    const { driver } = makeLocalDriver();
    const dev = "local-dev-5" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "casambi:5" });
    await expect(driver.command(dev, { capability: "onoff", action: "on" })).rejects.toThrow(/not connected/);
  });

  it("command() refuses an unsupported capability (position) rather than fabricating a mapping", async () => {
    const { driver } = makeLocalDriver();
    const dev = "local-dev-6" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "position", address: "casambi:6" });
    await driver.connect();
    await expect(driver.command(dev, { capability: "position", action: "open" })).rejects.toThrow(/unsupported command/);
    await driver.disconnect();
  });

  it("a 0x51 button event publishes a typed ButtonEvent on the driver event bus", async () => {
    const { socket, driver } = makeLocalDriver();
    await driver.connect();
    const events: CasambiDriverEvent[] = [];
    driver.onDriverEvent((e) => events.push(e));
    // 0x51: Unit_ID=9, Source=1, Button=0, Event=2 (short press)
    socket.receive("0.70.5.51.9.1.0.2\r\n");
    expect(events).toContainEqual({ type: "button", unitId: 9, action: "short_press", ts: expect.any(String) });
    await driver.disconnect();
  });

  it("a 0x3A Notify Node removed forgets the unit and publishes a networkUpdated event", async () => {
    const { socket, driver } = makeLocalDriver();
    const dev = "local-dev-7" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:7" });
    await driver.connect();
    socket.receive("0.70.4.4b.7.1.c8\r\n"); // discover unit 7 first
    expect(driver.getState(dev, "brightness")).not.toBeNull();

    const events: CasambiDriverEvent[] = [];
    driver.onDriverEvent((e) => events.push(e));
    socket.receive("0.70.2.3a.7\r\n"); // Notify Node removed, Unit_ID=7
    expect(events).toContainEqual({ type: "network", kind: "networkUpdated", detail: "unit 7 removed", ts: expect.any(String) });
    await driver.disconnect();
  });

  it("getHealth()/getCasambiDiagnostics() reflect the real Local connection state", async () => {
    const { driver } = makeLocalDriver();
    await driver.connect();
    expect(driver.getHealth().connected).toBe(true);
    expect(driver.getHealth().connectionType).toBe("local");
    const diag = driver.getCasambiDiagnostics();
    expect(diag.udpStatus).toBe("connected");
    expect(diag.restStatus).toBe("not_configured");
    expect(diag.gateway).toBe("192.168.1.90:80");
    await driver.disconnect();
    expect(driver.getCasambiDiagnostics().udpStatus).toBe("disconnected");
  });

  describe("staged UDP diagnostics (§ UDP Diagnostics audit)", () => {
    it("reports stage 'bound_waiting' immediately after connect, before any notification arrives", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const udp = driver.getCasambiDiagnostics().udp;
      expect(udp).not.toBeNull();
      expect(udp?.socketState).toBe("bound");
      expect(udp?.stage).toBe("bound_waiting");
      expect(udp?.remoteAddress).toBe("192.168.1.90");
      expect(udp?.remotePort).toBe(5100);
      // connect() already sent the SetDefaultMask/Subscribe/NotifyButtonEvent bootstrap.
      expect(udp?.packetsSent).toBe(3);
      expect(udp?.packetsReceived).toBe(0);
      expect(udp?.lastPacketAt).toBeNull();
      await driver.disconnect();
    });

    it("moves to stage 'active' and increments packetsReceived once a notification arrives", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const udp = driver.getCasambiDiagnostics().udp;
      expect(udp?.stage).toBe("active");
      expect(udp?.packetsReceived).toBe(1);
      expect(udp?.lastPacketAt).not.toBeNull();
      await driver.disconnect();
    });

    it("surfaces a full protocol trace in Driver Diagnostics for a received broadcast packet, even a firmware-6.25-shaped payload the codec can't fully decode", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      // A broadcast NotifyControlValues packet from the gateway (sender = gateway, not addressed
      // only to this client) — proves reception + tracing works for exactly the real Wireshark
      // scenario, not just the fake unicast shape other tests use.
      socket.receive("c.70.27.4b.1e.15.0.14.0.0\r\n");
      const udp = driver.getCasambiDiagnostics().udp;
      expect(udp?.recentTraces).toHaveLength(1);
      expect(udp?.recentTraces[0]).toMatchObject({
        rawAscii: "c.70.27.4b.1e.15.0.14.0.0\r\n",
        decoded: expect.objectContaining({ opcode: 0x4b }),
        parseError: null,
      });
      await driver.disconnect();
    });

    it("traces AND counts a datagram that fails to parse — reception is never gated on successful decode", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("garbage\r\n");
      const udp = driver.getCasambiDiagnostics().udp;
      expect(udp?.packetsReceived).toBe(1);
      expect(udp?.recentTraces[0]).toMatchObject({ rawAscii: "garbage\r\n", decoded: null });
      expect(udp?.recentTraces[0]?.parseError).toMatch(/Malformed/);
      await driver.disconnect();
    });

    it("udp diagnostics are null in Cloud mode — no fabricated UDP detail for a transport that doesn't exist", async () => {
      const transport = new FakeCasambiTransport(NETWORK);
      const driver = new CasambiProtocolDriver({ credentials: creds, transport });
      await driver.connect();
      expect(driver.getCasambiDiagnostics().udp).toBeNull();
      await driver.disconnect();
    });
  });

  // § LAN Transport Phase 2 — Transport Monitor: the layered Transport/Casambi Adapter/Driver
  // debugging view built on top of the same real engine/driver state, additive to
  // getCasambiDiagnostics() (this method changes nothing about that existing shape).
  describe("getCasambiTransportMonitor() (§ LAN Transport Phase 2)", () => {
    it("driver counters start at zero and entities/adapter reflect no traffic yet", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.connectionType).toBe("local");
      expect(monitor.driver).toEqual({
        entities: 0,
        discoveryEvents: 0,
        commandsIssued: 0,
        feedbackEvents: 0,
        unmappedOpcodeEvents: 0,
        lastUnmappedOpcode: null,
        recentJourney: [],
      });
      expect(monitor.adapter?.packetsReceived).toBe(0);
      expect(monitor.adapter?.decoded).toBe(0);
      expect(monitor.adapter?.decodeFailures).toBe(0);
      // FakeUdpTransport is neither NatsUdpTransportClient nor LocalDirectUdpTransport — the
      // honest "unknown" backend, never guessed as one of the two real ones.
      expect(monitor.transport).toMatchObject({ backend: "unknown", listening: true });
      await driver.disconnect();
    });

    it("discoveryEvents/entities/feedbackEvents increment when a real packet discovers and updates a bound unit", async () => {
      const { socket, driver } = makeLocalDriver();
      const dev = "local-dev-5" as DeviceId;
      await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:5" });
      await driver.connect();
      socket.receive("0.70.4.4b.5.1.c8\r\n"); // first-ever packet for unit 5
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.driver.discoveryEvents).toBe(1);
      expect(monitor.driver.entities).toBe(1);
      expect(monitor.driver.feedbackEvents).toBe(1);
      expect(monitor.adapter?.packetsReceived).toBe(1);
      expect(monitor.adapter?.decoded).toBe(1);
      expect(monitor.adapter?.decodeFailures).toBe(0);

      // A repeat of the identical state is deduplicated — not double-counted as a new feedback event.
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      expect(driver.getCasambiTransportMonitor().driver.feedbackEvents).toBe(1);
      // But it IS still a real received/decoded datagram at the adapter layer.
      expect(driver.getCasambiTransportMonitor().adapter?.packetsReceived).toBe(2);
      await driver.disconnect();
    });

    it("commandsIssued increments only after command() actually dispatches", async () => {
      const { driver } = makeLocalDriver();
      const dev = "local-dev-5" as DeviceId;
      await driver.bind({ deviceId: dev, capability: "onoff", address: "casambi:5" });
      await driver.connect();
      expect(driver.getCasambiTransportMonitor().driver.commandsIssued).toBe(0);
      await driver.command(dev, { capability: "onoff", action: "on" });
      expect(driver.getCasambiTransportMonitor().driver.commandsIssued).toBe(1);
      await driver.disconnect();
    });

    it("a well-formed but unmapped opcode is decoded but ignored — observable, never a silent drop", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      // 0x39 Node Status — a real, documented opcode this driver's event normalizer doesn't map
      // to any CasambiSignal (it's only ever used as a probe() response check, not a discovery/
      // feedback signal). Well-formed per the codec (length=2, one arg=0xff), so it decodes
      // successfully — this is the exact "Adapter decoded, Discovery ignored packet" case.
      socket.receive("0.70.2.39.ff\r\n");
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.adapter?.decoded).toBe(1);
      expect(monitor.adapter?.decodeFailures).toBe(0);
      expect(monitor.driver.unmappedOpcodeEvents).toBe(1);
      expect(monitor.driver.lastUnmappedOpcode).toBe(0x39);
      expect(monitor.driver.discoveryEvents).toBe(0);
      expect(monitor.driver.feedbackEvents).toBe(0);
      expect(monitor.driver.recentJourney).toHaveLength(1);
      expect(monitor.driver.recentJourney[0]).toMatchObject({
        decoded: true,
        decodeError: null,
        opcode: 0x39,
        handlerInvoked: null,
        outcome: "unmapped_opcode",
      });
      expect(monitor.driver.recentJourney[0]?.processingDurationMs).toBeGreaterThanOrEqual(0);
      await driver.disconnect();
    });

    it("packet journey records 'mapped' with the resolved signal kind for a NotifyControlValues packet", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const journey = driver.getCasambiTransportMonitor().driver.recentJourney;
      expect(journey).toHaveLength(1);
      expect(journey[0]).toMatchObject({ decoded: true, opcode: 0x4b, handlerInvoked: "unit", outcome: "mapped" });
      await driver.disconnect();
    });

    it("packet journey records a decode failure distinctly from an unmapped opcode", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("garbage\r\n");
      const journey = driver.getCasambiTransportMonitor().driver.recentJourney;
      expect(journey).toHaveLength(1);
      expect(journey[0]).toMatchObject({ decoded: false, opcode: null, handlerInvoked: null, outcome: "decode_failed" });
      expect(journey[0]?.decodeError).toMatch(/Malformed/);
      await driver.disconnect();
    });

    it("a malformed datagram counts toward adapter.decodeFailures, not decoded", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("garbage\r\n");
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.adapter?.packetsReceived).toBe(1);
      expect(monitor.adapter?.decoded).toBe(0);
      expect(monitor.adapter?.decodeFailures).toBe(1);
      await driver.disconnect();
    });

    it("transport/adapter are null in Cloud mode; driver counters still populate from real Cloud activity", async () => {
      const transport = new FakeCasambiTransport(NETWORK);
      const driver = new CasambiProtocolDriver({ credentials: creds, transport });
      await driver.connect();
      const monitor = driver.getCasambiTransportMonitor();
      expect(monitor.connectionType).toBe("cloud");
      expect(monitor.transport).toBeNull();
      expect(monitor.adapter).toBeNull();
      expect(monitor.driver.entities).toBeGreaterThan(0); // NETWORK's fixture units, fetched on connect
      await driver.disconnect();
    });
  });

  describe("syncNamesFromCloud() (§ Casambi Local Gateway — one-time Cloud name sync)", () => {
    it("matches an already-discovered Local unit to its real Cloud name, by numeric id", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      // Unit 5 becomes known locally via its first NotifyControlValues packet (dimmer=200).
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const before = (await driver.discover()).find((d) => d.raw.unitId === 5)!;
      expect(before.suggestedName).toBe("Casambi 5"); // honest placeholder, per local-discovery.ts

      const cloudTransport = new FakeCasambiTransport({
        units: [
          { id: 5, name: "Living Room Downlight" },
          { id: 99, name: "Never Discovered Locally" }, // present in the Cloud account, not yet locally
        ],
        groups: [],
      });
      const result = await driver.syncNamesFromCloud(creds, cloudTransport);
      expect(result).toEqual({ matched: 1, total: 2, networkName: "Villa" });
      expect(cloudTransport.sessions).toBe(1);
      expect(cloudTransport.fetches).toBe(1);

      const after = (await driver.discover()).find((d) => d.raw.unitId === 5)!;
      expect(after.suggestedName).toBe("Living Room Downlight");
      await driver.disconnect();
    });

    it("never opens a WebSocket wire — REST session + fetch only", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const cloudTransport = new FakeCasambiTransport({ units: [{ id: 5, name: "Downlight" }], groups: [] });
      await driver.syncNamesFromCloud(creds, cloudTransport);
      expect(cloudTransport.handlers).toBeNull(); // openWire() was never called
      await driver.disconnect();
    });

    it("is a safe no-op for units the Cloud network reports with no name", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const cloudTransport = new FakeCasambiTransport({ units: [{ id: 5 }], groups: [] }); // no `name` field
      const result = await driver.syncNamesFromCloud(creds, cloudTransport);
      expect(result.matched).toBe(0);
      const after = (await driver.discover()).find((d) => d.raw.unitId === 5)!;
      expect(after.suggestedName).toBe("Casambi 5"); // untouched, never overwritten with an empty name
      await driver.disconnect();
    });

    it("throws when called on a Cloud-mode driver — it already has real names from its own session", async () => {
      const transport = new FakeCasambiTransport(NETWORK);
      const driver = new CasambiProtocolDriver({ credentials: creds, transport });
      await driver.connect();
      await expect(driver.syncNamesFromCloud(creds)).rejects.toThrow(/only meaningful in Local mode/);
      await driver.disconnect();
    });
  });

  describe("discoverFromCloud() (§ Casambi Local Gateway — Cloud device discovery)", () => {
    it("adds units the Cloud network reports that were never seen over local UDP, marked awaitingLocalSignal", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const cloudTransport = new FakeCasambiTransport(NETWORK); // units 45 (Dimmer+CCT) and 46 (Slider)
      const result = await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect(result).toEqual({ discovered: 2, total: 2, networkName: "Villa" });

      const discovered = await driver.discover();
      const ceiling = discovered.find((d) => d.raw.unitId === 45)!;
      expect(ceiling.suggestedName).toBe("Ceiling");
      expect(ceiling.raw.awaitingLocalSignal).toBe(true);
      await driver.disconnect();
    });

    it("never overwrites a unit already known from a real local signal", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      // Unit 5 becomes known locally via its first NotifyControlValues packet (dimmer=200).
      socket.receive("0.70.4.4b.5.1.c8\r\n");
      const cloudTransport = new FakeCasambiTransport({ units: [{ id: 5, name: "Should not overwrite", controls: [{ type: "Dimmer", value: 0 }] }], groups: [] });
      const result = await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect(result.discovered).toBe(0); // already known — skipped, never overwritten

      const after = (await driver.discover()).find((d) => d.raw.unitId === 5)!;
      expect(after.suggestedName).toBe("Casambi 5"); // untouched
      expect(after.raw.awaitingLocalSignal).toBe(false); // genuinely local-known, never marked pending
      await driver.disconnect();
    });

    it("clears awaitingLocalSignal the moment a real local packet confirms a Cloud-discovered unit", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      const cloudTransport = new FakeCasambiTransport(NETWORK);
      await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect((await driver.discover()).find((d) => d.raw.unitId === 45)!.raw.awaitingLocalSignal).toBe(true);

      // Unit 45's first real local packet arrives — dimmer=200.
      socket.receive("0.70.4.4b.2d.1.c8\r\n");
      const after = (await driver.discover()).find((d) => d.raw.unitId === 45)!;
      expect(after.raw.awaitingLocalSignal).toBe(false);
      await driver.disconnect();
    });

    it("§ live-confirmed fix — adds the Cloud-known CCT control onto a unit local UDP already saw as dimmer-only, instead of leaving it permanently misclassified as plain dimmable", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      // Local UDP hears unit 45 first — only its dimmer channel (type 1) has reported so far,
      // the CCT NotifyControlValues packet (type 10) hasn't arrived yet.
      socket.receive("0.70.4.4b.2d.1.c8\r\n");
      const cloudTransport = new FakeCasambiTransport(NETWORK); // unit 45 = Dimmer + CCT, unit 46 = new
      const result = await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect(result.discovered).toBe(1); // only unit 46 is newly discovered — 45 was already known

      const after = (await driver.discover()).find((d) => d.raw.unitId === 45)!;
      expect(after.capabilities).toContain("color"); // CCT capability now present, not just brightness
      expect(after.raw.awaitingLocalSignal).toBe(false); // still genuinely local-known, never marked pending
      await driver.disconnect();
    });

    it("§ live-confirmed fix — a later dimmer-only local packet doesn't drop the CCT control the Cloud merge already added", async () => {
      const { socket, driver } = makeLocalDriver();
      await driver.connect();
      const cloudTransport = new FakeCasambiTransport(NETWORK); // unit 45 = Dimmer + CCT per Cloud
      await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect((await driver.discover()).find((d) => d.raw.unitId === 45)!.capabilities).toContain("color");

      // A real local packet arrives reporting ONLY the dimmer channel (no CCT byte in this frame).
      socket.receive("0.70.4.4b.2d.1.80\r\n");
      const after = (await driver.discover()).find((d) => d.raw.unitId === 45)!;
      expect(after.capabilities).toContain("color"); // still tunable white, not silently downgraded
      expect(after.capabilities).toContain("brightness"); // and the fresh dimmer level still applied
      await driver.disconnect();
    });

    it("§ live-confirmed fix — fetchNetwork alone carries no controls (real Casambi API shape: GET /v1/networks/{id} is structural-only, controls only come from GET /v1/networks/{id}/state); discoverFromCloud must merge in state's controls or every unit stays capability-less", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const structuralOnlyNetwork: CasambiNetwork = {
        units: [{ id: 45, name: "Ceiling", type: "Luminaire", groupId: 1 }], // no `controls` at all
        groups: [],
      };
      const stateUnits: CasambiUnit[] = [
        { id: 45, controls: [{ type: "Dimmer", value: 0 }, { type: "CCT", value: 4000, min: 2700, max: 6000 }] },
      ];
      const cloudTransport = new FakeCasambiTransport(structuralOnlyNetwork, stateUnits);
      await driver.discoverFromCloud(creds, cloudTransport, 0);

      const after = (await driver.discover()).find((d) => d.raw.unitId === 45)!;
      expect(after.capabilities).toEqual(["brightness", "color"]);
      await driver.disconnect();
    });

    it("skips the WebSocket enrichment burst entirely when wireBurstMs is 0 — REST session + fetch only", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const cloudTransport = new FakeCasambiTransport(NETWORK);
      await driver.discoverFromCloud(creds, cloudTransport, 0);
      expect(cloudTransport.handlers).toBeNull(); // openWire() was never called
      await driver.disconnect();
    });

    it("§ live-confirmed fix — opens a short Cloud wire burst and merges a unitChanged event's richer controls (real case: both REST endpoints under-report a fixture's CCT control, but the live WebSocket correctly reports it, same as Cloud mode's own connect flow)", async () => {
      const { driver } = makeLocalDriver();
      await driver.connect();
      const structuralOnlyNetwork: CasambiNetwork = {
        units: [{ id: 45, name: "Ceiling", type: "Luminaire", groupId: 1 }], // no controls from fetchNetwork
        groups: [],
      };
      // fetchState ALSO under-reports it (dimmer only) — matching the real, live-confirmed case.
      const stateUnits: CasambiUnit[] = [{ id: 45, controls: [{ type: "Dimmer", value: 0 }] }];
      const cloudTransport = new FakeCasambiTransport(structuralOnlyNetwork, stateUnits);

      const discoverPromise = driver.discoverFromCloud(creds, cloudTransport, 20);
      // Wait for the wire to actually open before emitting — openWire() is awaited inside
      // discoverFromCloud, so this happens almost immediately, well before the 20ms burst ends.
      await vi.waitFor(() => expect(cloudTransport.handlers).not.toBeNull());
      cloudTransport.emit({
        method: "unitChanged",
        id: 45,
        dimLevel: 0,
        controls: [{ type: "Dimmer", value: 0 }, { type: "CCT", value: 4000, min: 2700, max: 6000 }],
      });
      await discoverPromise;

      const after = (await driver.discover()).find((d) => d.raw.unitId === 45)!;
      expect(after.capabilities).toEqual(["brightness", "color"]);
      await driver.disconnect();
    });

    it("throws when called on a Cloud-mode driver — it already discovers from its own live session", async () => {
      const transport = new FakeCasambiTransport(NETWORK);
      const driver = new CasambiProtocolDriver({ credentials: creds, transport });
      await driver.connect();
      await expect(driver.discoverFromCloud(creds)).rejects.toThrow(/only meaningful in Local mode/);
      await driver.disconnect();
    });
  });
});
