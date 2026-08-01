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
import type { CasambiUdpSocketLike } from "./local-transport/index.js";
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

/** A real event-emitting fake UDP socket for Local-mode driver tests — see `local-transport/
 * udp-engine.test.ts` for the same pattern used directly against `CasambiUdpEngine`. */
class FakeUdpSocket implements CasambiUdpSocketLike {
  sent: string[] = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  bind(): void {
    queueMicrotask(() => this.emit("listening"));
  }
  send(msg: string, _port: number, _address: string, callback?: (error: Error | null) => void): void {
    this.sent.push(msg);
    callback?.(null);
  }
  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  receive(raw: string): void {
    this.emit("message", Buffer.from(raw, "ascii"), { address: "192.168.1.90", port: 5100 });
  }
}

describe("CasambiProtocolDriver (Local Gateway, fake UDP socket)", () => {
  function makeLocalDriver() {
    const socket = new FakeUdpSocket();
    const driver = new CasambiProtocolDriver({
      connectionMode: "local",
      local: { gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100, netId: 0, udpSocketFactory: () => socket },
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
    expect(socket.sent).toEqual(["0.72.4.20.ff.1.5\r\n"]);
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

    it("udp diagnostics are null in Cloud mode — no fabricated UDP detail for a transport that doesn't exist", async () => {
      const transport = new FakeCasambiTransport(NETWORK);
      const driver = new CasambiProtocolDriver({ credentials: creds, transport });
      await driver.connect();
      expect(driver.getCasambiDiagnostics().udp).toBeNull();
      await driver.disconnect();
    });
  });
});
