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
} from "./casambi-transport.js";
import type { CasambiUnit } from "./casambi-codec.js";

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
