import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { KnxProtocolDriver, type KnxConnection, type KnxValue } from "./knx-driver.js";
import { decodeHeatCool, decodeHvacControllingMode, decodeHvacOperatingMode, decodeHvacSetpoints, decodeHvacStatus, encodeHeatCool, encodeHvacOperatingMode, encodeHvacSetpoints, stateFromValue, valueFromCommand } from "./knx-codec.js";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { temperatureCommandForSystemMode } from "./matter-bridge/clusters/thermostat-control-adapter.js";

/** A fake KNX bus: records group-writes and lets a test push status telegrams. */
class FakeKnxBus implements KnxConnection {
  readonly writes: Array<{ ga: string; value: KnxValue; dpt: string }> = [];
  private readonly observers = new Map<string, (v: KnxValue) => void>();
  async connect() {}
  async disconnect() {}
  async write(ga: string, value: KnxValue, dpt: string) {
    this.writes.push({ ga, value, dpt });
  }
  observe(ga: string, _dpt: string, handler: (v: KnxValue) => void) {
    this.observers.set(ga, handler);
    return () => {
      if (this.observers.get(ga) === handler) this.observers.delete(ga);
    };
  }
  /** Simulate a device reporting on its status group address. */
  push(ga: string, value: KnxValue) {
    this.observers.get(ga)?.(value);
  }
}

describe("KNX codec", () => {
  it("maps capabilities to DPT values and back", () => {
    expect(valueFromCommand({ capability: "onoff", action: "on" }, null)).toBe(true);
    expect(valueFromCommand({ capability: "brightness", action: "set", level: 40 }, null)).toBe(40);
    expect(valueFromCommand({ capability: "brightness", action: "off" }, null)).toBe(0);
    expect(valueFromCommand({ capability: "position", action: "open" }, null)).toBe(100);

    expect(stateFromValue("onoff", true)).toEqual({ kind: "onoff", on: true });
    expect(stateFromValue("brightness", 75)).toEqual({ kind: "brightness", on: true, level: 75 });
    expect(stateFromValue("sensor", 21.5, { unit: "°C", measure: "temperature" })).toEqual({
      kind: "sensor",
      value: 21.5,
      unit: "°C",
      measure: "temperature",
    });
  });

  it("maps lock (DPT1.xxx boolean, true = locked)", () => {
    expect(valueFromCommand({ capability: "lock", action: "lock" }, null)).toBe(true);
    expect(valueFromCommand({ capability: "lock", action: "unlock" }, null)).toBe(false);
    expect(stateFromValue("lock", true)).toEqual({ kind: "lock", locked: true, jammed: false });
  });

  it("maps a single-GA temperature (DPT9.001), reflecting the one real value as both fields", () => {
    expect(valueFromCommand({ capability: "temperature", targetC: 22.5 }, null)).toBe(22.5);
    expect(stateFromValue("temperature", 21)).toEqual({ kind: "temperature", ambientC: 21, targetC: 21, mode: "auto" });
  });

  it("round-trips RGB colour (DPT232.600)", () => {
    const value = valueFromCommand({ capability: "color", hue: 0, saturation: 100, level: 100 }, null, "DPT232.600");
    expect(value).toEqual({ red: 255, green: 0, blue: 0 });
    expect(stateFromValue("color", value!)).toEqual({
      kind: "color",
      on: true,
      level: 100,
      hue: 0,
      saturation: 100,
      kelvin: null,
    });
  });

  it("round-trips RGBW colour (DPT251.600), leaving the white channel unset", () => {
    const value = valueFromCommand({ capability: "color", hue: 120, saturation: 100, level: 100 }, null, "DPT251.600");
    expect(value).toEqual({ red: 0, green: 255, blue: 0, white: 0, mR: 1, mG: 1, mB: 1, mW: 0 });
  });

  it("maps tunable-white colour temperature (DPT7.600) as a plain Kelvin passthrough", () => {
    const value = valueFromCommand({ capability: "color", kelvin: 3000 }, null, "DPT7.600");
    expect(value).toBe(3000);
    expect(stateFromValue("color", value!)).toEqual({
      kind: "color",
      on: true,
      level: 100,
      hue: null,
      saturation: null,
      kelvin: 3000,
    });
  });
});

describe("KnxProtocolDriver (fake KNXnet/IP bus)", () => {
  // § Real production bug (live-reported): "No More Connections" from the KNXnet/IP gateway,
  // recurring roughly on reconcileDriverConnectivity()'s 60s retry cadence — a concurrent
  // connect() call while a previous attempt was still pending opened a SECOND real tunnel
  // connection against a gateway that only allows one, self-DoS-ing the driver's own slot.
  it("awaits the same in-flight attempt instead of opening a second real connection when called concurrently", async () => {
    let factoryCalls = 0;
    let resolveConnect!: () => void;
    const bus = new FakeKnxBus();
    const slowConnect = new Promise<void>((resolve) => { resolveConnect = resolve; });
    const originalConnect = bus.connect.bind(bus);
    bus.connect = async () => { await slowConnect; await originalConnect(); };

    const driver = new KnxProtocolDriver({
      host: "10.0.0.9",
      createConnection: async () => { factoryCalls += 1; return bus; },
    });

    const first = driver.connect();
    const second = driver.connect();
    resolveConnect();
    await Promise.all([first, second]);

    expect(factoryCalls).toBe(1);
    expect(driver.isConnected()).toBe(true);
  });

  it("group-writes commands and normalizes status telegrams from a separate GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const dev = "device-knx-blind" as DeviceId;
    // Cover: command GA 1/2/0, status GA 1/2/1, scaling DPT.
    await driver.bind({
      deviceId: dev,
      capability: "position",
      address: "1/2/0",
      config: { statusAddress: "1/2/1", dpt: "DPT5.001" },
    });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "position", action: "set", position: 60 });
    expect(bus.writes).toEqual([{ ga: "1/2/0", value: 60, dpt: "DPT5.001" }]);
    // Optimistic state recorded on command.
    expect(driver.getState(dev, "position")).toEqual({ kind: "position", position: 60, moving: false });

    // Actuator reports final position on the status GA → bubbles up.
    bus.push("1/2/1", 100);
    expect(events.at(-1)?.state).toEqual({ kind: "position", position: 100, moving: false });
  });

  it("group-writes a colour command using the binding's own DPT", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const dev = "device-knx-rgb" as DeviceId;
    await driver.bind({
      deviceId: dev,
      capability: "color",
      address: "1/5/0",
      config: { dpt: "DPT232.600" },
    });

    await driver.command(dev, { capability: "color", hue: 240, saturation: 100, level: 100 });
    expect(bus.writes).toEqual([{ ga: "1/5/0", value: { red: 0, green: 0, blue: 255 }, dpt: "DPT232.600" }]);
    expect(driver.getState(dev, "color")).toEqual({
      kind: "color",
      on: true,
      level: 100,
      hue: 240,
      saturation: 100,
      kelvin: null,
    });
  });

  it("getCapabilityConfig reports colorModes from the binding's own DPT (§ live-confirmed fix — this is the driver actually bound in production, not just the discovery-time driver)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const cct = "device-knx-cct" as DeviceId;
    await driver.bind({ deviceId: cct, capability: "color", address: "5/1/5", config: { dpt: "DPT7.600" } });
    expect(driver.getCapabilityConfig(cct, "color")).toEqual({ colorModes: { rgb: false, cct: true } });

    const rgb = "device-knx-rgb2" as DeviceId;
    await driver.bind({ deviceId: rgb, capability: "color", address: "1/5/0", config: { dpt: "DPT232.600" } });
    expect(driver.getCapabilityConfig(rgb, "color")).toEqual({ colorModes: { rgb: true, cct: false } });

    // Never fabricated for a capability this device isn't bound for, or a device with no binding at all.
    expect(driver.getCapabilityConfig(cct, "brightness")).toBeNull();
    expect(driver.getCapabilityConfig("nope" as DeviceId, "color")).toBeNull();
  });

  it("rejects a command for an unbound device", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    await expect(
      driver.command("nope" as DeviceId, { capability: "onoff", action: "on" }),
    ).rejects.toThrow(/not bound/);
  });

  it("unbind() unsubscribes the status GA observer — a later telegram no longer resurrects state (§ Driver Lifecycle Completion)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const dev = "device-knx-light" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "1/1/0" });
    expect(driver.getState(dev, "onoff")).toBeNull();
    bus.push("1/1/0", true);
    expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });

    await driver.unbind(dev);
    expect(driver.manages(dev)).toBe(false);
    expect(driver.getState(dev, "onoff")).toBeNull();

    // The fake's internal observer map is private, but the public contract proves it:
    // a telegram on the now-unbound GA must not resurrect any state or fire a listener.
    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    bus.push("1/1/0", false);
    expect(events).toEqual([]);
    expect(driver.getState(dev, "onoff")).toBeNull();

    // Idempotent — a second unbind is a safe no-op.
    await expect(driver.unbind(dev)).resolves.toBeUndefined();
  });
});

describe("§ Phase 3.3B — KNX HVAC Multi-GA Entity/Binding Architecture (runtime driver)", () => {
  function bindHvacDevice(driver: KnxProtocolDriver, dev: DeviceId, opts: { setpointGa: string; ambientGa: string; modeGa: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: opts.setpointGa,
      config: {
        statusAddress: opts.ambientGa,
        dpt: "DPT9.001",
        hvacRoles: { operatingMode: { address: opts.modeGa, dpt: "DPT20.102" } },
      },
    });
  }

  it("§ Phase 3.3B, superseded by 3.3C-1's real decode below — one HVAC entity's primary temperature binding AND its operatingMode role GA are both bound from one bind() call", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-a" as DeviceId;
    await bindHvacDevice(driver, dev, { setpointGa: "8/1/1", ambientGa: "8/1/2", modeGa: "8/1/3" });

    // Existing single-GA behavior is completely unchanged — ambient/target still flow
    // through stateFromValue exactly as before.
    bus.push("8/1/2", 21.5);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 21.5, targetC: 21.5, mode: "auto" });

    // The operatingMode role GA is independently observed and its raw value tracked.
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBeNull();
    bus.push("8/1/3", 1);
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBe(1);
    // § Phase 3.3C-1 — DPT 20.102 is now decoded and merged into the typed state, WITHOUT
    // disturbing mode/ambientC/targetC — see the dedicated DPT 20.102 describe block below
    // for the full decode/write/read-back/invalid-value test matrix.
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 21.5,
      targetC: 21.5,
      mode: "auto",
      operatingMode: "comfort",
    });
  });

  it("write operations target the CORRECT group address for a given semantic role, distinct from the primary writeGa", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-b" as DeviceId;
    await bindHvacDevice(driver, dev, { setpointGa: "9/1/1", ambientGa: "9/1/2", modeGa: "9/1/3" });

    await driver.writeHvacRole(dev, "temperature", "operatingMode", 2);
    expect(bus.writes).toEqual([{ ga: "9/1/3", value: 2, dpt: "DPT20.102" }]);

    // The primary setpoint command still writes to ITS OWN address, unaffected.
    await driver.command(dev, { capability: "temperature", targetC: 22 });
    expect(bus.writes).toContainEqual({ ga: "9/1/1", value: 22, dpt: "DPT9.001" });
  });

  it("writeHvacRole throws for an unbound role, exactly like command() throws for an unbound device", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-c" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "10/1/1" }); // no hvacRoles at all
    await expect(driver.writeHvacRole(dev, "temperature", "operatingMode", 1)).rejects.toThrow(/no "operatingMode" HVAC role/);
  });

  it("existing non-HVAC and single-GA KNX bindings are completely unaffected — getHvacRoleValue is null, writeHvacRole throws, exactly like an unbound role", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-plain-onoff" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "11/1/1" });
    expect(driver.getHvacRoleValue(dev, "onoff", "operatingMode")).toBeNull();
    await expect(driver.writeHvacRole(dev, "onoff", "operatingMode", 1)).rejects.toThrow();
    // The plain onoff binding itself works exactly as before.
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(bus.writes).toEqual([{ ga: "11/1/1", value: true, dpt: "DPT1.001" }]);
  });

  it("restart/reconnect re-establishes the operatingMode role's subscription, exactly like the primary status GA already does", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-restart" as DeviceId;
    await bindHvacDevice(driver, dev, { setpointGa: "12/1/1", ambientGa: "12/1/2", modeGa: "12/1/3" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    // Simulate a fresh bus connection on reconnect (a real restart persists bindings via
    // the installer-context config store and re-binds each one on driver startup — this
    // test isolates the DRIVER's own re-subscribe-on-connect behavior, which the existing
    // single-GA `observe()` path already relies on).
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("12/1/3", 3);
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBe(3);
  });

  it("two independent HVAC devices' operatingMode roles never cross-talk", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const devA = "device-hvac-multi-a" as DeviceId;
    const devB = "device-hvac-multi-b" as DeviceId;
    await bindHvacDevice(driver, devA, { setpointGa: "13/1/1", ambientGa: "13/1/2", modeGa: "13/1/3" });
    await bindHvacDevice(driver, devB, { setpointGa: "13/2/1", ambientGa: "13/2/2", modeGa: "13/2/3" });

    bus.push("13/1/3", 1);
    expect(driver.getHvacRoleValue(devA, "temperature", "operatingMode")).toBe(1);
    expect(driver.getHvacRoleValue(devB, "temperature", "operatingMode")).toBeNull();

    bus.push("13/2/3", 2);
    expect(driver.getHvacRoleValue(devA, "temperature", "operatingMode")).toBe(1);
    expect(driver.getHvacRoleValue(devB, "temperature", "operatingMode")).toBe(2);
  });

  it("unbind() unsubscribes the operatingMode role's observer too — a later telegram never resurrects it", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-unbind" as DeviceId;
    await bindHvacDevice(driver, dev, { setpointGa: "14/1/1", ambientGa: "14/1/2", modeGa: "14/1/3" });
    bus.push("14/1/3", 1);
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBe(1);

    await driver.unbind(dev);
    bus.push("14/1/3", 4);
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBeNull();
  });

  it("a malformed/missing hvacRoles config (e.g. from an older commissioning pass) binds normally with zero HVAC roles — backward compatible", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-hvac-malformed" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "15/1/1", config: { hvacRoles: "not-an-object" } });
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBeNull();
    await driver.command(dev, { capability: "temperature", targetC: 19 });
    expect(bus.writes).toEqual([{ ga: "15/1/1", value: 19, dpt: "DPT9.001" }]);
  });
});

describe("§ Phase 3.3C-1 — KNX DPT 20.102 (DPT_HVACMode) codec", () => {
  it("C — decodes all five canonical values", () => {
    expect(decodeHvacOperatingMode(0)).toBe("auto");
    expect(decodeHvacOperatingMode(1)).toBe("comfort");
    expect(decodeHvacOperatingMode(2)).toBe("standby");
    expect(decodeHvacOperatingMode(3)).toBe("economy");
    expect(decodeHvacOperatingMode(4)).toBe("building_protection");
  });

  it("D — reserved/invalid values (5-255, non-integer, negative) decode to null, never a fabricated valid mode", () => {
    expect(decodeHvacOperatingMode(5)).toBeNull();
    expect(decodeHvacOperatingMode(255)).toBeNull();
    expect(decodeHvacOperatingMode(6)).toBeNull();
    expect(decodeHvacOperatingMode(-1)).toBeNull();
    expect(decodeHvacOperatingMode(1.5)).toBeNull();
  });

  it("F — encodes each universal operatingMode value to the correct DPT 20.102 raw value", () => {
    expect(encodeHvacOperatingMode("auto")).toBe(0);
    expect(encodeHvacOperatingMode("comfort")).toBe(1);
    expect(encodeHvacOperatingMode("standby")).toBe(2);
    expect(encodeHvacOperatingMode("economy")).toBe(3);
    expect(encodeHvacOperatingMode("building_protection")).toBe(4);
  });

  it("encode/decode round-trip for every valid value", () => {
    for (const mode of ["auto", "comfort", "standby", "economy", "building_protection"] as const) {
      expect(decodeHvacOperatingMode(encodeHvacOperatingMode(mode))).toBe(mode);
    }
  });
});

describe("§ Phase 3.3C-1 — KNX DPT 20.102 (DPT_HVACMode) driver integration", () => {
  function bindHvac(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; mode: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: { statusAddress: gas.ambient, dpt: "DPT9.001", hvacRoles: { operatingMode: { address: gas.mode, dpt: "DPT20.102" } } },
    });
  }

  it("E — a feedback value updates operatingMode WITHOUT corrupting mode/ambientC/targetC", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-e" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "20/1/1", ambient: "20/1/2", mode: "20/1/3" });

    bus.push("20/1/2", 22); // primary ambient/target reading arrives first
    bus.push("20/1/3", 1); // DPT 20.102 = Comfort
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 22,
      targetC: 22,
      mode: "auto",
      operatingMode: "comfort",
    });

    // A later, different setpoint/ambient reading must not disturb operatingMode either.
    bus.push("20/1/2", 23);
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 23, targetC: 23, operatingMode: "comfort" });
  });

  it("D/E — an out-of-range feedback value (5-255) is ignored: operatingMode stays at its last valid value, never becomes a fabricated mode", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-invalid" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "21/1/1", ambient: "21/1/2", mode: "21/1/3" });

    bus.push("21/1/2", 20);
    bus.push("21/1/3", 2); // Standby — valid
    expect(driver.getState(dev, "temperature")).toMatchObject({ operatingMode: "standby" });

    bus.push("21/1/3", 42); // reserved/invalid
    expect(driver.getState(dev, "temperature")).toMatchObject({ operatingMode: "standby" }); // unchanged, not "auto", not fabricated
  });

  it("E — a mode telegram arriving BEFORE any primary temperature reading is held (not fabricated into a state with invented ambientC)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-early" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "22/1/1", ambient: "22/1/2", mode: "22/1/3" });

    bus.push("22/1/3", 3); // Economy — arrives before any ambient/target reading
    expect(driver.getState(dev, "temperature")).toBeNull(); // no fabricated ambientC/mode
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBe(3); // raw value still tracked

    bus.push("22/1/2", 18); // primary reading now arrives
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 18,
      targetC: 18,
      mode: "auto",
      operatingMode: "economy",
    });
  });

  it("F/G — a command's operatingMode field writes the CORRECT DPT 20.102 value to the operatingMode GA specifically, never the primary GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-write" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "23/1/1", ambient: "23/1/2", mode: "23/1/3" });

    await driver.command(dev, { capability: "temperature", operatingMode: "economy" });
    expect(bus.writes).toEqual([{ ga: "23/1/3", value: 3, dpt: "DPT20.102" }]);
  });

  it("§8 bidirectional semantics — the command does NOT optimistically set operatingMode; only real feedback does, and feedback can disagree with what was requested", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-bidi" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "24/1/1", ambient: "24/1/2", mode: "24/1/3" });
    bus.push("24/1/2", 21);

    await driver.command(dev, { capability: "temperature", operatingMode: "comfort" });
    // Not yet reflected — no feedback has arrived.
    const stateBeforeFeedback = driver.getState(dev, "temperature");
    expect(stateBeforeFeedback?.kind === "temperature" ? stateBeforeFeedback.operatingMode : "wrong-kind").toBeUndefined();

    bus.push("24/1/3", 2); // the real device actually settled on Standby, not the requested Comfort
    expect(driver.getState(dev, "temperature")).toMatchObject({ operatingMode: "standby" });
  });

  it("H — a command with no operatingMode binding fails safely using the existing unbound-role error convention", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-nobinding" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "25/1/1" }); // no hvacRoles at all
    await expect(driver.command(dev, { capability: "temperature", operatingMode: "comfort" })).rejects.toThrow(/no "operatingMode" HVAC role/);
    expect(bus.writes).toEqual([]); // never silently wrote anywhere else
  });

  it("G — a command carrying ONLY operatingMode never touches the primary setpoint GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-onlymode" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "26/1/1", ambient: "26/1/2", mode: "26/1/3" });
    await driver.command(dev, { capability: "temperature", operatingMode: "standby" });
    expect(bus.writes).toEqual([{ ga: "26/1/3", value: 2, dpt: "DPT20.102" }]);
    expect(bus.writes.some((w) => w.ga === "26/1/1")).toBe(false);
  });

  it("a command carrying BOTH operatingMode and targetC writes to BOTH GAs correctly", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-both" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "27/1/1", ambient: "27/1/2", mode: "27/1/3" });
    await driver.command(dev, { capability: "temperature", operatingMode: "comfort", targetC: 20 });
    expect(bus.writes).toContainEqual({ ga: "27/1/3", value: 1, dpt: "DPT20.102" });
    expect(bus.writes).toContainEqual({ ga: "27/1/1", value: 20, dpt: "DPT9.001" });
  });

  it("I — the operatingMode binding survives disconnect/reconnect exactly like the Phase 3.3B architecture requires", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-restart" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "28/1/1", ambient: "28/1/2", mode: "28/1/3" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("28/1/2", 19);
    bus2.push("28/1/3", 4);
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 19, operatingMode: "building_protection" });
  });

  it("J — a synthetic multi-GA HVAC entity (ambient + target + operatingMode) keeps all three GAs distinct, never collapsed into one binding", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-multi" as DeviceId;
    await bindHvac(driver, dev, { setpoint: "29/1/1", ambient: "29/1/2", mode: "29/1/3" });

    await driver.command(dev, { capability: "temperature", targetC: 24 });
    await driver.command(dev, { capability: "temperature", operatingMode: "auto" });
    bus.push("29/1/2", 23);

    expect(bus.writes).toContainEqual({ ga: "29/1/1", value: 24, dpt: "DPT9.001" });
    expect(bus.writes).toContainEqual({ ga: "29/1/3", value: 0, dpt: "DPT20.102" });
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 23 });
  });

  it("K — an existing single-GA temperature entity (no operatingMode binding) behaves exactly as before this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20102-single" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "30/1/1" });
    bus.push("30/1/1", 20);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 20, targetC: 20, mode: "auto" });
    await driver.command(dev, { capability: "temperature", targetC: 21 });
    expect(bus.writes).toEqual([{ ga: "30/1/1", value: 21, dpt: "DPT9.001" }]);
  });

  it("L — unrelated non-HVAC KNX bindings (onoff/brightness/position) are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const light = "device-20102-light" as DeviceId;
    const blind = "device-20102-blind" as DeviceId;
    await driver.bind({ deviceId: light, capability: "onoff", address: "31/1/1" });
    await driver.bind({ deviceId: blind, capability: "position", address: "31/2/1", config: { dpt: "DPT5.001" } });

    await driver.command(light, { capability: "onoff", action: "on" });
    await driver.command(blind, { capability: "position", action: "set", position: 40 });
    expect(bus.writes).toContainEqual({ ga: "31/1/1", value: true, dpt: "DPT1.001" });
    expect(bus.writes).toContainEqual({ ga: "31/2/1", value: 40, dpt: "DPT5.001" });
    expect(driver.getState(light, "temperature")).toBeNull();
    expect(driver.getState(blind, "temperature")).toBeNull();
  });
});

describe("§ Phase 3.3C-2 — KNX DPT 20.105 (DPT_HVACContrMode) codec", () => {
  it("C — decodes every canonical value, including the non-contiguous 20 = no_demand", () => {
    expect(decodeHvacControllingMode(0)).toBe("auto");
    expect(decodeHvacControllingMode(1)).toBe("heat");
    expect(decodeHvacControllingMode(2)).toBe("morning_warmup");
    expect(decodeHvacControllingMode(3)).toBe("cool");
    expect(decodeHvacControllingMode(4)).toBe("night_purge");
    expect(decodeHvacControllingMode(5)).toBe("precool");
    expect(decodeHvacControllingMode(6)).toBe("off");
    expect(decodeHvacControllingMode(7)).toBe("test");
    expect(decodeHvacControllingMode(8)).toBe("emergency_heat");
    expect(decodeHvacControllingMode(9)).toBe("fan_only");
    expect(decodeHvacControllingMode(10)).toBe("free_cool");
    expect(decodeHvacControllingMode(11)).toBe("ice");
    expect(decodeHvacControllingMode(12)).toBe("maximum_heating");
    expect(decodeHvacControllingMode(13)).toBe("economic_heat_cool");
    expect(decodeHvacControllingMode(14)).toBe("dehumidification");
    expect(decodeHvacControllingMode(15)).toBe("calibration");
    expect(decodeHvacControllingMode(16)).toBe("emergency_cool");
    expect(decodeHvacControllingMode(17)).toBe("emergency_steam");
    expect(decodeHvacControllingMode(20)).toBe("no_demand");
  });

  it("D — reserved/undocumented values (18, 19, 21-255), non-integers, and negatives decode to null, never a fabricated mode", () => {
    expect(decodeHvacControllingMode(18)).toBeNull();
    expect(decodeHvacControllingMode(19)).toBeNull();
    expect(decodeHvacControllingMode(21)).toBeNull();
    expect(decodeHvacControllingMode(255)).toBeNull();
    expect(decodeHvacControllingMode(-1)).toBeNull();
    expect(decodeHvacControllingMode(1.5)).toBeNull();
  });

  it("no encoder exists for DPT 20.105 — it is read/feedback-only per Phase 3.3C-2 scope, so there is structurally no write path", () => {
    expect((globalThis as Record<string, unknown>).encodeHvacControllingMode).toBeUndefined();
  });
});

describe("§ Phase 3.3C-2 — KNX DPT 20.105 (DPT_HVACContrMode) driver integration", () => {
  function bindHvacFull(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; opMode: string; contrMode: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: gas.opMode, dpt: "DPT20.102" },
          controllingModeExtended: { address: gas.contrMode, dpt: "DPT20.105" },
        },
      },
    });
  }

  it("A/B — recognizes and associates a controllingModeExtended feedback GA with the same temperature entity", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-assoc" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "40/1/1", ambient: "40/1/2", opMode: "40/1/3", contrMode: "40/1/4" });

    bus.push("40/1/2", 22);
    bus.push("40/1/4", 3); // DPT 20.105 = cool
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 22, controllingModeExtended: "cool" });
  });

  it("E/F — a controllingModeExtended feedback value merges in WITHOUT corrupting mode/ambientC/targetC/operatingMode", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-isolation" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "41/1/1", ambient: "41/1/2", opMode: "41/1/3", contrMode: "41/1/4" });

    bus.push("41/1/2", 24);
    bus.push("41/1/3", 1); // operatingMode = comfort
    bus.push("41/1/4", 8); // controllingModeExtended = emergency_heat
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 24,
      targetC: 24,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
    });

    // A later ambient reading must not disturb either HVAC-role field.
    bus.push("41/1/2", 25);
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 25, operatingMode: "comfort", controllingModeExtended: "emergency_heat" });
  });

  it("D — an out-of-range controllingModeExtended value (18/19/21-255) is ignored: field stays at its last valid value", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-invalid" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "42/1/1", ambient: "42/1/2", opMode: "42/1/3", contrMode: "42/1/4" });

    bus.push("42/1/2", 20);
    bus.push("42/1/4", 6); // off — valid
    expect(driver.getState(dev, "temperature")).toMatchObject({ controllingModeExtended: "off" });

    bus.push("42/1/4", 19); // reserved/invalid
    expect(driver.getState(dev, "temperature")).toMatchObject({ controllingModeExtended: "off" }); // unchanged
  });

  it("G — a synthetic 4-GA HVAC entity (ambient + target + operatingMode + controllingModeExtended) keeps all four GAs distinct and coexisting", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-multi" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "43/1/1", ambient: "43/1/2", opMode: "43/1/3", contrMode: "43/1/4" });

    await driver.command(dev, { capability: "temperature", targetC: 21 });
    await driver.command(dev, { capability: "temperature", operatingMode: "economy" });
    bus.push("43/1/2", 20);
    bus.push("43/1/3", 3); // real feedback confirming economy
    bus.push("43/1/4", 10); // free_cool

    expect(bus.writes).toContainEqual({ ga: "43/1/1", value: 21, dpt: "DPT9.001" });
    expect(bus.writes).toContainEqual({ ga: "43/1/3", value: 3, dpt: "DPT20.102" });
    expect(bus.writes.some((w) => w.ga === "43/1/4")).toBe(false); // never written — feedback-only
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 20, operatingMode: "economy", controllingModeExtended: "free_cool" });
  });

  it("I — the controllingModeExtended binding survives disconnect/reconnect", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-restart" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "44/1/1", ambient: "44/1/2", opMode: "44/1/3", contrMode: "44/1/4" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("44/1/2", 19);
    bus2.push("44/1/4", 11); // ice
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 19, controllingModeExtended: "ice" });
  });

  it("J — no SupremeOS command is accepted for controllingModeExtended: the CapabilityCommand schema has no such field, so a command carrying it is silently dropped, never written to any GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-nowrite" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "45/1/1", ambient: "45/1/2", opMode: "45/1/3", contrMode: "45/1/4" });

    // controllingModeExtended does not exist on TemperatureCapabilityCommand — this cast
    // simulates a malformed/foreign payload reaching the driver at a JS boundary (e.g. a
    // stale client). It must never be routed anywhere.
    await driver.command(dev, { capability: "temperature", targetC: 18, controllingModeExtended: "cool" } as unknown as Parameters<KnxProtocolDriver["command"]>[1]);
    expect(bus.writes).toEqual([{ ga: "45/1/1", value: 18, dpt: "DPT9.001" }]);
    expect(bus.writes.some((w) => w.ga === "45/1/4")).toBe(false);
  });

  it("K — an existing single-GA temperature entity and the DPT-20.102-only Phase 3.3C-1 entities are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-regress-single" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "46/1/1" });
    bus.push("46/1/1", 20);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 20, targetC: 20, mode: "auto" });

    const devOpOnly = "device-20105-regress-op" as DeviceId;
    await driver.bind({
      deviceId: devOpOnly,
      capability: "temperature",
      address: "46/2/1",
      config: { statusAddress: "46/2/2", dpt: "DPT9.001", hvacRoles: { operatingMode: { address: "46/2/3", dpt: "DPT20.102" } } },
    });
    bus.push("46/2/2", 21);
    bus.push("46/2/3", 1);
    expect(driver.getState(devOpOnly, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 21,
      targetC: 21,
      mode: "auto",
      operatingMode: "comfort",
    });
  });

  it("L — unrelated non-HVAC KNX bindings (onoff/position) are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const light = "device-20105-light" as DeviceId;
    const blind = "device-20105-blind" as DeviceId;
    await driver.bind({ deviceId: light, capability: "onoff", address: "47/1/1" });
    await driver.bind({ deviceId: blind, capability: "position", address: "47/2/1", config: { dpt: "DPT5.001" } });

    await driver.command(light, { capability: "onoff", action: "on" });
    await driver.command(blind, { capability: "position", action: "set", position: 40 });
    expect(bus.writes).toContainEqual({ ga: "47/1/1", value: true, dpt: "DPT1.001" });
    expect(bus.writes).toContainEqual({ ga: "47/2/1", value: 40, dpt: "DPT5.001" });
    expect(driver.getState(light, "temperature")).toBeNull();
    expect(driver.getState(blind, "temperature")).toBeNull();
  });

  // § Phase 3.3C-2 §12 — MANDATORY state-fidelity test. Reproduces the exact
  // three-step telegram-ordering scenario the spec calls out: after each single-field
  // update, every OTHER field (including the other HVAC-role field) must remain
  // byte-for-byte identical to its previous value. This is the regression guard for the
  // exact bug class fixed in Phase 3.3C-1 (stateFromValue() clobbering role overlays).
  it("§12 MANDATORY state-fidelity — ambient, then operatingMode, then controllingModeExtended, each step touching only its own field", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-20105-fidelity" as DeviceId;
    await bindHvacFull(driver, dev, { setpoint: "48/1/1", ambient: "48/1/2", opMode: "48/1/3", contrMode: "48/1/4" });

    // Establish the full initial state. This binding's single primary GA (§ knx-codec.ts
    // stateFromValue's DPT9.001 single-reading semantics — see the existing "reflecting
    // the one real value as both fields" codec test above) reflects one reading into both
    // ambientC/targetC; the fields this test isolates are the two independently-subscribed
    // HVAC-role fields plus `mode`, exactly as Phase 3.3C-1/3.3C-2 require.
    bus.push("48/1/2", 23);
    bus.push("48/1/3", 1); // comfort
    bus.push("48/1/4", 3); // cool
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 23,
      targetC: 23,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
    });

    // Step 1: ambient-only telegram — operatingMode/controllingModeExtended/mode untouched.
    bus.push("48/1/2", 26);
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
    });

    // Step 2: operatingMode-only telegram — ambientC/targetC/controllingModeExtended untouched.
    bus.push("48/1/3", 2); // standby
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "cool",
    });

    // Step 3: controllingModeExtended-only telegram — ambientC/targetC/operatingMode untouched.
    bus.push("48/1/4", 9); // fan_only
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
    });
  });
});

describe("§ Phase 3.3C-3 — KNX DPT 1.100 (DPT_Heat/Cool) codec", () => {
  it("C — decodes both canonical values", () => {
    expect(decodeHeatCool(0)).toBe("cool");
    expect(decodeHeatCool(1)).toBe("heat");
    expect(decodeHeatCool(false)).toBe("cool");
    expect(decodeHeatCool(true)).toBe("heat");
  });

  it("E — reserved/invalid values (anything but 0/1/false/true) decode to null, never a fabricated value", () => {
    expect(decodeHeatCool(2)).toBeNull();
    expect(decodeHeatCool(255)).toBeNull();
    expect(decodeHeatCool(-1)).toBeNull();
    expect(decodeHeatCool(0.5)).toBeNull();
  });

  it("D — encodes each universal heatCool value to the correct DPT 1.100 raw value", () => {
    expect(encodeHeatCool("cool")).toBe(0);
    expect(encodeHeatCool("heat")).toBe(1);
  });

  it("encode/decode round-trip for every valid value", () => {
    for (const v of ["heat", "cool"] as const) {
      expect(decodeHeatCool(encodeHeatCool(v))).toBe(v);
    }
  });
});

describe("§ Phase 3.3C-3 — KNX DPT 1.100 (DPT_Heat/Cool) driver integration", () => {
  function bindHvacHeatCool(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; heatCool: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: { heatCool: { address: gas.heatCool, dpt: "DPT1.100" } },
      },
    });
  }

  function bindHvacAllRoles(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; opMode: string; contrMode: string; heatCool: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: gas.opMode, dpt: "DPT20.102" },
          controllingModeExtended: { address: gas.contrMode, dpt: "DPT20.105" },
          heatCool: { address: gas.heatCool, dpt: "DPT1.100" },
        },
      },
    });
  }

  it("A — recognizes and associates a heatCool feedback GA with the same temperature entity", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-assoc" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "50/1/1", ambient: "50/1/2", heatCool: "50/1/3" });

    bus.push("50/1/2", 22);
    bus.push("50/1/3", 1); // DPT 1.100 = heat
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 22, heatCool: "heat" });
  });

  it("F/G/H/I — a heatCool feedback value merges in WITHOUT corrupting mode/ambientC/targetC/operatingMode/controllingModeExtended", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-isolation" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "51/1/1", ambient: "51/1/2", opMode: "51/1/3", contrMode: "51/1/4", heatCool: "51/1/5" });

    bus.push("51/1/2", 24);
    bus.push("51/1/3", 1); // operatingMode = comfort
    bus.push("51/1/4", 8); // controllingModeExtended = emergency_heat
    bus.push("51/1/5", 0); // heatCool = cool
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 24,
      targetC: 24,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
    });

    // A later ambient reading must not disturb any of the three HVAC-role fields.
    bus.push("51/1/2", 25);
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 25,
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
    });
  });

  it("E — an out-of-range heatCool value is ignored: field stays at its last valid value", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-invalid" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "52/1/1", ambient: "52/1/2", heatCool: "52/1/3" });

    bus.push("52/1/2", 20);
    bus.push("52/1/3", 1); // heat — valid
    expect(driver.getState(dev, "temperature")).toMatchObject({ heatCool: "heat" });

    bus.push("52/1/3", 7); // reserved/invalid
    expect(driver.getState(dev, "temperature")).toMatchObject({ heatCool: "heat" }); // unchanged
  });

  it("K — a synthetic 5-GA HVAC entity (ambient + target + operatingMode + controllingModeExtended + heatCool) keeps all five GAs distinct and coexisting", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-multi" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "53/1/1", ambient: "53/1/2", opMode: "53/1/3", contrMode: "53/1/4", heatCool: "53/1/5" });

    await driver.command(dev, { capability: "temperature", targetC: 21 });
    await driver.command(dev, { capability: "temperature", heatCool: "heat" });
    bus.push("53/1/2", 20);
    bus.push("53/1/3", 3); // real feedback confirming economy
    bus.push("53/1/4", 10); // free_cool
    bus.push("53/1/5", 1); // real feedback confirming heat

    expect(bus.writes).toContainEqual({ ga: "53/1/1", value: 21, dpt: "DPT9.001" });
    expect(bus.writes).toContainEqual({ ga: "53/1/5", value: 1, dpt: "DPT1.100" });
    expect(bus.writes.some((w) => w.ga === "53/1/3")).toBe(false); // never commanded in this test
    expect(bus.writes.some((w) => w.ga === "53/1/4")).toBe(false); // never written — feedback-only
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 20,
      controllingModeExtended: "free_cool",
      heatCool: "heat",
    });
  });

  it("L — a command's heatCool field writes the CORRECT DPT 1.100 value to the heatCool GA specifically, never the primary/operatingMode/controllingMode GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-write" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "54/1/1", ambient: "54/1/2", opMode: "54/1/3", contrMode: "54/1/4", heatCool: "54/1/5" });

    await driver.command(dev, { capability: "temperature", heatCool: "cool" });
    expect(bus.writes).toEqual([{ ga: "54/1/5", value: 0, dpt: "DPT1.100" }]);
  });

  it("N — the command does NOT optimistically set heatCool; only real feedback does, and feedback can disagree with what was requested", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-bidi" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "55/1/1", ambient: "55/1/2", heatCool: "55/1/3" });
    bus.push("55/1/2", 21);

    await driver.command(dev, { capability: "temperature", heatCool: "heat" });
    // Not yet reflected — no feedback has arrived.
    const stateBeforeFeedback = driver.getState(dev, "temperature");
    expect(stateBeforeFeedback?.kind === "temperature" ? stateBeforeFeedback.heatCool : "wrong-kind").toBeUndefined();

    bus.push("55/1/3", 0); // the real device actually settled on cool, not the requested heat
    expect(driver.getState(dev, "temperature")).toMatchObject({ heatCool: "cool" });
  });

  it("M — a command with no heatCool binding fails safely using the existing unbound-role error convention", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-nobinding" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "56/1/1" }); // no hvacRoles at all
    await expect(driver.command(dev, { capability: "temperature", heatCool: "heat" })).rejects.toThrow(/no "heatCool" HVAC role/);
    expect(bus.writes).toEqual([]); // never silently wrote anywhere else
  });

  it("G — a command carrying ONLY heatCool never touches the primary setpoint GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-onlyheatcool" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "57/1/1", ambient: "57/1/2", heatCool: "57/1/3" });
    await driver.command(dev, { capability: "temperature", heatCool: "cool" });
    expect(bus.writes).toEqual([{ ga: "57/1/3", value: 0, dpt: "DPT1.100" }]);
    expect(bus.writes.some((w) => w.ga === "57/1/1")).toBe(false);
  });

  it("O — the heatCool binding survives disconnect/reconnect", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-restart" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "58/1/1", ambient: "58/1/2", heatCool: "58/1/3" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("58/1/2", 19);
    bus2.push("58/1/3", 1); // heat
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 19, heatCool: "heat" });
  });

  it("P — an existing single-GA temperature entity (no heatCool binding) behaves exactly as before this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-single" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "59/1/1" });
    bus.push("59/1/1", 20);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 20, targetC: 20, mode: "auto" });
    await driver.command(dev, { capability: "temperature", targetC: 21 });
    expect(bus.writes).toEqual([{ ga: "59/1/1", value: 21, dpt: "DPT9.001" }]);
  });

  it("Q — unrelated non-HVAC KNX bindings (onoff/position) are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const light = "device-1100-light" as DeviceId;
    const blind = "device-1100-blind" as DeviceId;
    await driver.bind({ deviceId: light, capability: "onoff", address: "60/1/1" });
    await driver.bind({ deviceId: blind, capability: "position", address: "60/2/1", config: { dpt: "DPT5.001" } });

    await driver.command(light, { capability: "onoff", action: "on" });
    await driver.command(blind, { capability: "position", action: "set", position: 40 });
    expect(bus.writes).toContainEqual({ ga: "60/1/1", value: true, dpt: "DPT1.001" });
    expect(bus.writes).toContainEqual({ ga: "60/2/1", value: 40, dpt: "DPT5.001" });
    expect(driver.getState(light, "temperature")).toBeNull();
    expect(driver.getState(blind, "temperature")).toBeNull();
  });

  // § Phase 3.3C-3 §10/§R — MANDATORY multi-GA state-fidelity/update-order regression.
  // Establishes the full five-field state (ambient/target/mode/operatingMode/
  // controllingModeExtended/heatCool), then sends ambient, target(-bearing), operatingMode,
  // controllingModeExtended, and heatCool telegrams/commands ONE AT A TIME, asserting
  // every unrelated field stays byte-for-byte identical at each step (the exact bug class
  // Phase 3.3C-1 found in stateFromValue()'s fresh-object-per-telegram behavior).
  it("§10/§R MANDATORY state-fidelity — ambient, target, operatingMode, controllingModeExtended, heatCool, each step touching only its own field(s)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-1100-fidelity" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "61/1/1", ambient: "61/1/2", opMode: "61/1/3", contrMode: "61/1/4", heatCool: "61/1/5" });

    // Establish the full initial state: ambientC=23/targetC=24, mode=auto,
    // operatingMode=comfort, controllingModeExtended=cool, heatCool=cool.
    await driver.command(dev, { capability: "temperature", targetC: 24 });
    bus.push("61/1/2", 23);
    bus.push("61/1/3", 1); // comfort
    bus.push("61/1/4", 3); // cool (controlling mode)
    bus.push("61/1/5", 0); // cool (heat/cool)
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 23,
      targetC: 23, // § single-GA reflect semantics — see the 3.3C-2 fidelity test's own note
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
    });

    // Step 1: ambient-only telegram.
    bus.push("61/1/2", 26);
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
    });

    // Step 2: operatingMode-only telegram.
    bus.push("61/1/3", 2); // standby
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "cool",
      heatCool: "cool",
    });

    // Step 3: controllingModeExtended-only telegram.
    bus.push("61/1/4", 9); // fan_only
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
      heatCool: "cool",
    });

    // Step 4: heatCool-only telegram — the new field this phase adds.
    bus.push("61/1/5", 1); // heat
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
      heatCool: "heat",
    });
  });
});

describe("§ Phase 3.3C-4 — KNX DPT 22.101 (DPT_StatusRHCC) codec", () => {
  it("C — decodes a single-bit-set telegram exactly, every other represented field explicitly false", () => {
    expect(decodeHvacStatus(1)).toEqual({
      fault: true,
      ecoHeatingActive: false,
      flowTempLimitActive: false,
      returnTempLimitActive: false,
      heatingDisabled: false,
      ecoCoolingActive: false,
      coolingDisabled: false,
      dewPointAlarm: false,
      frostAlarm: false,
      overheatAlarm: false,
    });
  });

  it("D — every supported status field decodes from its own canonical bit, independently of all others", () => {
    const BIT: Record<string, number> = {
      fault: 0,
      ecoHeatingActive: 1,
      flowTempLimitActive: 2,
      returnTempLimitActive: 3,
      heatingDisabled: 7,
      ecoCoolingActive: 9,
      coolingDisabled: 11,
      dewPointAlarm: 12,
      frostAlarm: 13,
      overheatAlarm: 14,
    };
    for (const [field, bit] of Object.entries(BIT)) {
      const decoded = decodeHvacStatus(1 << bit);
      expect(decoded?.[field as keyof NonNullable<typeof decoded>]).toBe(true);
      for (const [otherField] of Object.entries(BIT)) {
        if (otherField === field) continue;
        expect(decoded?.[otherField as keyof NonNullable<typeof decoded>]).toBe(false);
      }
    }
  });

  it("E — multiple simultaneous status bits are all preserved independently, never collapsed to one flag", () => {
    // fault (bit 0) + coolingDisabled (bit 11) + frostAlarm (bit 13) simultaneously.
    const n = (1 << 0) | (1 << 11) | (1 << 13);
    expect(decodeHvacStatus(n)).toEqual({
      fault: true,
      ecoHeatingActive: false,
      flowTempLimitActive: false,
      returnTempLimitActive: false,
      heatingDisabled: false,
      ecoCoolingActive: false,
      coolingDisabled: true,
      dewPointAlarm: false,
      frostAlarm: true,
      overheatAlarm: false,
    });
  });

  it("bit 8 (HeatCoolMode) and bit 15 (reserved) are read but produce no extra fields — no field for either exists on HvacStatus", () => {
    const n = (1 << 8) | (1 << 15);
    expect(decodeHvacStatus(n)).toEqual({
      fault: false,
      ecoHeatingActive: false,
      flowTempLimitActive: false,
      returnTempLimitActive: false,
      heatingDisabled: false,
      ecoCoolingActive: false,
      coolingDisabled: false,
      dewPointAlarm: false,
      frostAlarm: false,
      overheatAlarm: false,
    });
  });

  it("F — reserved/invalid input (non-integer, negative, out-of-range) decodes to null, never a fabricated status", () => {
    expect(decodeHvacStatus(-1)).toBeNull();
    expect(decodeHvacStatus(0.5)).toBeNull();
    expect(decodeHvacStatus(0x10000)).toBeNull();
  });

  it("no encoder exists for DPT 22.101 — it is status/feedback-only per Phase 3.3C-4 scope", () => {
    expect((globalThis as Record<string, unknown>).encodeHvacStatus).toBeUndefined();
  });
});

describe("§ Phase 3.3C-4 — KNX DPT 22.101 (DPT_StatusRHCC) driver integration", () => {
  function bindHvacStatus(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; status: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: { status: { address: gas.status, dpt: "DPT22.101" } },
      },
    });
  }

  function bindHvacAllRoles(
    driver: KnxProtocolDriver,
    dev: DeviceId,
    gas: { setpoint: string; ambient: string; opMode: string; contrMode: string; heatCool: string; status: string },
  ) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: gas.opMode, dpt: "DPT20.102" },
          controllingModeExtended: { address: gas.contrMode, dpt: "DPT20.105" },
          heatCool: { address: gas.heatCool, dpt: "DPT1.100" },
          status: { address: gas.status, dpt: "DPT22.101" },
        },
      },
    });
  }

  it("A/B — recognizes and associates a DPT 22.101 status feedback GA with the same temperature entity", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-assoc" as DeviceId;
    await bindHvacStatus(driver, dev, { setpoint: "70/1/1", ambient: "70/1/2", status: "70/1/3" });

    bus.push("70/1/2", 22);
    bus.push("70/1/3", 1); // fault bit set
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 22, status: { fault: true } });
  });

  it("G/H/I/J/K — a status feedback value merges in WITHOUT corrupting ambientC/targetC/operatingMode/controllingModeExtended/heatCool", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-isolation" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "71/1/1", ambient: "71/1/2", opMode: "71/1/3", contrMode: "71/1/4", heatCool: "71/1/5", status: "71/1/6" });

    bus.push("71/1/2", 24);
    bus.push("71/1/3", 1); // operatingMode = comfort
    bus.push("71/1/4", 8); // controllingModeExtended = emergency_heat
    bus.push("71/1/5", 0); // heatCool = cool
    bus.push("71/1/6", 1 << 13); // status.frostAlarm = true
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 24,
      targetC: 24,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
      status: {
        fault: false,
        ecoHeatingActive: false,
        flowTempLimitActive: false,
        returnTempLimitActive: false,
        heatingDisabled: false,
        ecoCoolingActive: false,
        coolingDisabled: false,
        dewPointAlarm: false,
        frostAlarm: true,
        overheatAlarm: false,
      },
    });

    // A later ambient reading must not disturb status or any other HVAC-role field.
    bus.push("71/1/2", 25);
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 25,
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
      status: { frostAlarm: true },
    });
  });

  it("L — a NEW complete status telegram REPLACES the previous status snapshot wholesale, never merges stale true bits forward", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-replace" as DeviceId;
    await bindHvacStatus(driver, dev, { setpoint: "72/1/1", ambient: "72/1/2", status: "72/1/3" });

    bus.push("72/1/2", 20);
    bus.push("72/1/3", (1 << 0) | (1 << 13)); // fault=true, frostAlarm=true
    expect(driver.getState(dev, "temperature")).toMatchObject({ status: { fault: true, frostAlarm: true } });

    bus.push("72/1/3", 0); // brand-new complete snapshot: everything false
    const state = driver.getState(dev, "temperature");
    expect(state?.kind === "temperature" ? state.status : null).toEqual({
      fault: false,
      ecoHeatingActive: false,
      flowTempLimitActive: false,
      returnTempLimitActive: false,
      heatingDisabled: false,
      ecoCoolingActive: false,
      coolingDisabled: false,
      dewPointAlarm: false,
      frostAlarm: false,
      overheatAlarm: false,
    });
  });

  it("M — a synthetic 6-GA HVAC entity (ambient + target + operatingMode + controllingModeExtended + heatCool + status) keeps all six GAs distinct and coexisting", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-multi" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "73/1/1", ambient: "73/1/2", opMode: "73/1/3", contrMode: "73/1/4", heatCool: "73/1/5", status: "73/1/6" });

    await driver.command(dev, { capability: "temperature", targetC: 21 });
    await driver.command(dev, { capability: "temperature", heatCool: "heat" });
    bus.push("73/1/2", 20);
    bus.push("73/1/4", 10); // free_cool
    bus.push("73/1/5", 1); // real feedback confirming heat
    bus.push("73/1/6", 1 << 11); // coolingDisabled

    expect(bus.writes).toContainEqual({ ga: "73/1/1", value: 21, dpt: "DPT9.001" });
    expect(bus.writes).toContainEqual({ ga: "73/1/5", value: 1, dpt: "DPT1.100" });
    expect(bus.writes.some((w) => w.ga === "73/1/6")).toBe(false); // never written — feedback-only
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 20,
      controllingModeExtended: "free_cool",
      heatCool: "heat",
      status: { coolingDisabled: true },
    });
  });

  it("O — no write path exists for status: a foreign payload carrying it is silently dropped, never written to any GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-nowrite" as DeviceId;
    await bindHvacStatus(driver, dev, { setpoint: "74/1/1", ambient: "74/1/2", status: "74/1/3" });

    // `status` does not exist on TemperatureCapabilityCommand — this cast simulates a
    // malformed/foreign payload reaching the driver at a JS boundary.
    await driver.command(dev, { capability: "temperature", targetC: 18, status: { fault: true } } as unknown as Parameters<KnxProtocolDriver["command"]>[1]);
    expect(bus.writes).toEqual([{ ga: "74/1/1", value: 18, dpt: "DPT9.001" }]);
    expect(bus.writes.some((w) => w.ga === "74/1/3")).toBe(false);
  });

  it("N — the status binding survives disconnect/reconnect", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-restart" as DeviceId;
    await bindHvacStatus(driver, dev, { setpoint: "75/1/1", ambient: "75/1/2", status: "75/1/3" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("75/1/2", 19);
    bus2.push("75/1/3", 1 << 14); // overheatAlarm
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 19, status: { overheatAlarm: true } });
  });

  it("P — an existing single-GA temperature entity (no status binding) behaves exactly as before this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-single" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "76/1/1" });
    bus.push("76/1/1", 20);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 20, targetC: 20, mode: "auto" });
    await driver.command(dev, { capability: "temperature", targetC: 21 });
    expect(bus.writes).toEqual([{ ga: "76/1/1", value: 21, dpt: "DPT9.001" }]);
  });

  it("Q/R/S — existing single-role operatingMode/controllingModeExtended/heatCool bindings (no status role) are completely unaffected by this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const devOp = "device-22101-regress-op" as DeviceId;
    await driver.bind({
      deviceId: devOp,
      capability: "temperature",
      address: "77/1/1",
      config: { statusAddress: "77/1/2", dpt: "DPT9.001", hvacRoles: { operatingMode: { address: "77/1/3", dpt: "DPT20.102" } } },
    });
    bus.push("77/1/2", 21);
    bus.push("77/1/3", 1);
    expect(driver.getState(devOp, "temperature")).toEqual({ kind: "temperature", ambientC: 21, targetC: 21, mode: "auto", operatingMode: "comfort" });

    const devContr = "device-22101-regress-contr" as DeviceId;
    await driver.bind({
      deviceId: devContr,
      capability: "temperature",
      address: "78/1/1",
      config: { statusAddress: "78/1/2", dpt: "DPT9.001", hvacRoles: { controllingModeExtended: { address: "78/1/3", dpt: "DPT20.105" } } },
    });
    bus.push("78/1/2", 22);
    bus.push("78/1/3", 3);
    expect(driver.getState(devContr, "temperature")).toEqual({ kind: "temperature", ambientC: 22, targetC: 22, mode: "auto", controllingModeExtended: "cool" });

    const devHc = "device-22101-regress-hc" as DeviceId;
    await driver.bind({
      deviceId: devHc,
      capability: "temperature",
      address: "79/1/1",
      config: { statusAddress: "79/1/2", dpt: "DPT9.001", hvacRoles: { heatCool: { address: "79/1/3", dpt: "DPT1.100" } } },
    });
    bus.push("79/1/2", 23);
    bus.push("79/1/3", 1);
    expect(driver.getState(devHc, "temperature")).toEqual({ kind: "temperature", ambientC: 23, targetC: 23, mode: "auto", heatCool: "heat" });
  });

  it("T — unrelated non-HVAC KNX bindings (onoff/position) are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const light = "device-22101-light" as DeviceId;
    const blind = "device-22101-blind" as DeviceId;
    await driver.bind({ deviceId: light, capability: "onoff", address: "80/1/1" });
    await driver.bind({ deviceId: blind, capability: "position", address: "80/2/1", config: { dpt: "DPT5.001" } });

    await driver.command(light, { capability: "onoff", action: "on" });
    await driver.command(blind, { capability: "position", action: "set", position: 40 });
    expect(bus.writes).toContainEqual({ ga: "80/1/1", value: true, dpt: "DPT1.001" });
    expect(bus.writes).toContainEqual({ ga: "80/2/1", value: 40, dpt: "DPT5.001" });
    expect(driver.getState(light, "temperature")).toBeNull();
    expect(driver.getState(blind, "temperature")).toBeNull();
  });

  // § Phase 3.3C-4 §8 — MANDATORY multi-GA state-fidelity/update-order regression.
  // Establishes the full six-field state (ambient/target/mode/operatingMode/
  // controllingModeExtended/heatCool/status), then sends a status telegram, then ambient,
  // operatingMode, controllingModeExtended, and heatCool telegrams ONE AT A TIME,
  // asserting every unrelated field — INCLUDING status itself once set — stays
  // byte-for-byte identical at each step. Also covers §9/§10: a status→status telegram
  // changing multiple independent flags at once, replacing the whole snapshot.
  it("§8 MANDATORY state-fidelity — status, then ambient, operatingMode, controllingModeExtended, heatCool, each step touching only its own field(s)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-22101-fidelity" as DeviceId;
    await bindHvacAllRoles(driver, dev, { setpoint: "81/1/1", ambient: "81/1/2", opMode: "81/1/3", contrMode: "81/1/4", heatCool: "81/1/5", status: "81/1/6" });

    // Establish the full initial state: ambientC=23/targetC=24, mode=auto,
    // operatingMode=comfort, controllingModeExtended=cool, heatCool=cool.
    await driver.command(dev, { capability: "temperature", targetC: 24 });
    bus.push("81/1/2", 23);
    bus.push("81/1/3", 1); // comfort
    bus.push("81/1/4", 3); // cool (controlling mode)
    bus.push("81/1/5", 0); // cool (heat/cool)
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 23,
      targetC: 23, // § single-GA reflect semantics — see the 3.3C-2/3.3C-3 fidelity tests' own note
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
    });

    // Step 1: a status-only telegram — only `status` appears; nothing else changes.
    bus.push("81/1/6", 1 << 0); // fault
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 23,
      targetC: 23,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
      status: { fault: true, frostAlarm: false },
    });

    // Step 2: ambient-only telegram — status (and everything else) stays intact.
    bus.push("81/1/2", 26);
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 26,
      targetC: 26,
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
      status: { fault: true },
    });

    // Step 3: operatingMode-only telegram — status stays intact.
    bus.push("81/1/3", 2); // standby
    expect(driver.getState(dev, "temperature")).toMatchObject({
      operatingMode: "standby",
      controllingModeExtended: "cool",
      heatCool: "cool",
      status: { fault: true },
    });

    // Step 4: controllingModeExtended-only telegram — status stays intact.
    bus.push("81/1/4", 9); // fan_only
    expect(driver.getState(dev, "temperature")).toMatchObject({
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
      heatCool: "cool",
      status: { fault: true },
    });

    // Step 5: heatCool-only telegram — status stays intact.
    bus.push("81/1/5", 1); // heat
    expect(driver.getState(dev, "temperature")).toMatchObject({
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
      heatCool: "heat",
      status: { fault: true },
    });

    // Step 6: a NEW complete status telegram changing MULTIPLE independent flags at once,
    // replacing the previous snapshot wholesale (§9/§10) — every other HVAC field intact.
    bus.push("81/1/6", (1 << 11) | (1 << 13)); // coolingDisabled + frostAlarm; fault now false
    const finalState = driver.getState(dev, "temperature");
    expect(finalState).toMatchObject({
      ambientC: 26,
      targetC: 26,
      mode: "auto",
      operatingMode: "standby",
      controllingModeExtended: "fan_only",
      heatCool: "heat",
    });
    expect(finalState?.kind === "temperature" ? finalState.status : null).toEqual({
      fault: false,
      ecoHeatingActive: false,
      flowTempLimitActive: false,
      returnTempLimitActive: false,
      heatingDisabled: false,
      ecoCoolingActive: false,
      coolingDisabled: true,
      dewPointAlarm: false,
      frostAlarm: true,
      overheatAlarm: false,
    });
  });
});

describe("§ Phase 3.3C-5B — KNX DPT 222.100 (DPT_TempRoomSetpSetF16[3]) codec", () => {
  it("D — decodes all three fields exactly, no Building Protection field is ever produced", () => {
    expect(decodeHvacSetpoints({ comfort: 21, standby: 19, economy: 17 })).toEqual({
      comfortC: 21,
      standbyC: 19,
      economyC: 17,
    });
  });

  it("E — encode/decode round-trip for ordinary valid values", () => {
    const input = { comfortC: 21.5, standbyC: 19.2, economyC: 17.8 };
    expect(decodeHvacSetpoints(encodeHvacSetpoints(input))).toEqual(input);
  });

  it("F — negative values decode correctly", () => {
    expect(decodeHvacSetpoints({ comfort: -5, standby: -10, economy: -15 })).toEqual({
      comfortC: -5,
      standbyC: -10,
      economyC: -15,
    });
  });

  it("G — fractional temperatures decode correctly", () => {
    expect(decodeHvacSetpoints({ comfort: 21.02, standby: 19.98, economy: 17.46 })).toEqual({
      comfortC: 21.02,
      standbyC: 19.98,
      economyC: 17.46,
    });
  });

  it("H — normal HVAC values decode correctly", () => {
    expect(decodeHvacSetpoints({ comfort: 21, standby: 18, economy: 16 })).toEqual({
      comfortC: 21,
      standbyC: 18,
      economyC: 16,
    });
  });

  it("I — 7FFF-equivalent invalid comfort alone becomes null, standby/economy stay valid", () => {
    expect(decodeHvacSetpoints({ comfort: 670760.96, standby: 19, economy: 17 })).toEqual({
      comfortC: null,
      standbyC: 19,
      economyC: 17,
    });
  });

  it("J — 7FFF-equivalent invalid standby alone becomes null, comfort/economy stay valid", () => {
    expect(decodeHvacSetpoints({ comfort: 21, standby: 670760.96, economy: 17 })).toEqual({
      comfortC: 21,
      standbyC: null,
      economyC: 17,
    });
  });

  it("K — 7FFF-equivalent invalid economy alone becomes null, comfort/standby stay valid", () => {
    expect(decodeHvacSetpoints({ comfort: 21, standby: 19, economy: 670760.96 })).toEqual({
      comfortC: 21,
      standbyC: 19,
      economyC: null,
    });
  });

  it("L — multiple invalid fields simultaneously each become null independently, never collapsing the whole object", () => {
    expect(decodeHvacSetpoints({ comfort: 670760.96, standby: 20, economy: 670760.96 })).toEqual({
      comfortC: null,
      standbyC: 20,
      economyC: null,
    });
    expect(decodeHvacSetpoints({ comfort: 670760.96, standby: 670760.96, economy: 670760.96 })).toEqual({
      comfortC: null,
      standbyC: null,
      economyC: null,
    });
  });

  it("encode maps a null field back to the exact invalid sentinel value", () => {
    expect(encodeHvacSetpoints({ comfortC: null, standbyC: 19, economyC: null })).toEqual({
      comfort: 670760.96,
      standby: 19,
      economy: 670760.96,
    });
  });

  it("malformed/non-compound input decodes to null, never a fabricated partial object", () => {
    expect(decodeHvacSetpoints(21)).toBeNull();
    expect(decodeHvacSetpoints(true)).toBeNull();
    expect(decodeHvacSetpoints({ comfort: 21, standby: 19 } as unknown as Parameters<typeof decodeHvacSetpoints>[0])).toBeNull();
  });

  it("no SupremeOS command path reaches this encoder — codec-completeness only", () => {
    expect((globalThis as Record<string, unknown>).writeHvacSetpoints).toBeUndefined();
  });
});

describe("§ Phase 3.3C-5B — KNX DPT 222.100 (DPT_TempRoomSetpSetF16[3]) driver integration", () => {
  function bindHvacSetpoints(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; setpoints: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: { setpoints: { address: gas.setpoints, dpt: "DPT222.100" } },
      },
    });
  }

  function bindHvacAllRoles(
    driver: KnxProtocolDriver,
    dev: DeviceId,
    gas: { setpoint: string; ambient: string; opMode: string; contrMode: string; heatCool: string; status: string; setpoints: string },
  ) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: gas.opMode, dpt: "DPT20.102" },
          controllingModeExtended: { address: gas.contrMode, dpt: "DPT20.105" },
          heatCool: { address: gas.heatCool, dpt: "DPT1.100" },
          status: { address: gas.status, dpt: "DPT22.101" },
          setpoints: { address: gas.setpoints, dpt: "DPT222.100" },
        },
      },
    });
  }

  it("A/C — recognizes and associates a DPT 222.100 setpoints feedback GA with the same temperature entity", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-assoc" as DeviceId;
    await bindHvacSetpoints(driver, dev, { setpoint: "90/1/1", ambient: "90/1/2", setpoints: "90/1/3" });

    bus.push("90/1/2", 22);
    bus.push("90/1/3", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 22,
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });

  it("N/O/Q/R/S/T — a setpoints feedback value merges in WITHOUT corrupting ambientC/targetC/operatingMode/controllingModeExtended/heatCool/status", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-isolation" as DeviceId;
    await bindHvacAllRoles(driver, dev, {
      setpoint: "91/1/1", ambient: "91/1/2", opMode: "91/1/3", contrMode: "91/1/4", heatCool: "91/1/5", status: "91/1/6", setpoints: "91/1/7",
    });

    bus.push("91/1/2", 24);
    bus.push("91/1/3", 1); // operatingMode = comfort
    bus.push("91/1/4", 8); // controllingModeExtended = emergency_heat
    bus.push("91/1/5", 0); // heatCool = cool
    bus.push("91/1/6", 1 << 13); // status.frostAlarm = true
    bus.push("91/1/7", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 24,
      targetC: 24,
      mode: "auto",
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
      status: {
        fault: false,
        ecoHeatingActive: false,
        flowTempLimitActive: false,
        returnTempLimitActive: false,
        heatingDisabled: false,
        ecoCoolingActive: false,
        coolingDisabled: false,
        dewPointAlarm: false,
        frostAlarm: true,
        overheatAlarm: false,
      },
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // A later ambient reading must not disturb setpoints or any other HVAC-role field.
    bus.push("91/1/2", 25);
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 25,
      operatingMode: "comfort",
      controllingModeExtended: "emergency_heat",
      heatCool: "cool",
      status: { frostAlarm: true },
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });

  it("M — a NEW complete setpoints telegram REPLACES the previous snapshot wholesale; an invalid field in the new telegram becomes null, never the stale prior value", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-replace" as DeviceId;
    await bindHvacSetpoints(driver, dev, { setpoint: "92/1/1", ambient: "92/1/2", setpoints: "92/1/3" });

    bus.push("92/1/2", 20);
    bus.push("92/1/3", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toMatchObject({ setpoints: { comfortC: 21, standbyC: 19, economyC: 17 } });

    bus.push("92/1/3", { comfort: 22, standby: 20, economy: 670760.96 }); // new snapshot, economy now invalid
    const state = driver.getState(dev, "temperature");
    expect(state?.kind === "temperature" ? state.setpoints : null).toEqual({ comfortC: 22, standbyC: 20, economyC: null });
  });

  it("U — a synthetic 7-GA HVAC entity (ambient + target + operatingMode + controllingModeExtended + heatCool + status + setpoints) keeps all seven GAs distinct and coexisting", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-multi" as DeviceId;
    await bindHvacAllRoles(driver, dev, {
      setpoint: "93/1/1", ambient: "93/1/2", opMode: "93/1/3", contrMode: "93/1/4", heatCool: "93/1/5", status: "93/1/6", setpoints: "93/1/7",
    });

    await driver.command(dev, { capability: "temperature", targetC: 21 });
    await driver.command(dev, { capability: "temperature", heatCool: "heat" });
    bus.push("93/1/2", 20);
    bus.push("93/1/4", 10); // free_cool
    bus.push("93/1/5", 1); // real feedback confirming heat
    bus.push("93/1/6", 1 << 11); // coolingDisabled
    bus.push("93/1/7", { comfort: 21, standby: 19, economy: 17 });

    expect(bus.writes).toContainEqual({ ga: "93/1/1", value: 21, dpt: "DPT9.001" });
    expect(bus.writes).toContainEqual({ ga: "93/1/5", value: 1, dpt: "DPT1.100" });
    expect(bus.writes.some((w) => w.ga === "93/1/7")).toBe(false); // never written — feedback-only
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 20,
      controllingModeExtended: "free_cool",
      heatCool: "heat",
      status: { coolingDisabled: true },
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });

  it("W/X — no write path exists for setpoints: a foreign payload carrying it is silently dropped, never written to any GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-nowrite" as DeviceId;
    await bindHvacSetpoints(driver, dev, { setpoint: "94/1/1", ambient: "94/1/2", setpoints: "94/1/3" });

    // `setpoints` does not exist on TemperatureCapabilityCommand — this cast simulates a
    // malformed/foreign payload reaching the driver at a JS boundary.
    await driver.command(dev, {
      capability: "temperature",
      targetC: 18,
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    } as unknown as Parameters<KnxProtocolDriver["command"]>[1]);
    expect(bus.writes).toEqual([{ ga: "94/1/1", value: 18, dpt: "DPT9.001" }]);
    expect(bus.writes.some((w) => w.ga === "94/1/3")).toBe(false);
  });

  it("V — the setpoints binding survives disconnect/reconnect", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-restart" as DeviceId;
    await bindHvacSetpoints(driver, dev, { setpoint: "95/1/1", ambient: "95/1/2", setpoints: "95/1/3" });

    await driver.disconnect();
    const bus2 = new FakeKnxBus();
    (driver as unknown as { opts: { createConnection: () => Promise<FakeKnxBus> } }).opts.createConnection = async () => bus2;
    await driver.connect();

    bus2.push("95/1/2", 19);
    bus2.push("95/1/3", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toMatchObject({ ambientC: 19, setpoints: { comfortC: 21, standbyC: 19, economyC: 17 } });
  });

  it("AC — an existing single-GA temperature entity (no setpoints binding) behaves exactly as before this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-single" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "96/1/1" });
    bus.push("96/1/1", 20);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 20, targetC: 20, mode: "auto" });
    await driver.command(dev, { capability: "temperature", targetC: 21 });
    expect(bus.writes).toEqual([{ ga: "96/1/1", value: 21, dpt: "DPT9.001" }]);
  });

  it("Y/Z/AA/AB — existing single-role operatingMode/controllingModeExtended/heatCool/status bindings (no setpoints role) are completely unaffected by this phase", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();

    const devOp = "device-222100-regress-op" as DeviceId;
    await driver.bind({
      deviceId: devOp,
      capability: "temperature",
      address: "97/1/1",
      config: { statusAddress: "97/1/2", dpt: "DPT9.001", hvacRoles: { operatingMode: { address: "97/1/3", dpt: "DPT20.102" } } },
    });
    bus.push("97/1/2", 21);
    bus.push("97/1/3", 1);
    expect(driver.getState(devOp, "temperature")).toEqual({ kind: "temperature", ambientC: 21, targetC: 21, mode: "auto", operatingMode: "comfort" });

    const devContr = "device-222100-regress-contr" as DeviceId;
    await driver.bind({
      deviceId: devContr,
      capability: "temperature",
      address: "98/1/1",
      config: { statusAddress: "98/1/2", dpt: "DPT9.001", hvacRoles: { controllingModeExtended: { address: "98/1/3", dpt: "DPT20.105" } } },
    });
    bus.push("98/1/2", 22);
    bus.push("98/1/3", 3);
    expect(driver.getState(devContr, "temperature")).toEqual({ kind: "temperature", ambientC: 22, targetC: 22, mode: "auto", controllingModeExtended: "cool" });

    const devHc = "device-222100-regress-hc" as DeviceId;
    await driver.bind({
      deviceId: devHc,
      capability: "temperature",
      address: "99/1/1",
      config: { statusAddress: "99/1/2", dpt: "DPT9.001", hvacRoles: { heatCool: { address: "99/1/3", dpt: "DPT1.100" } } },
    });
    bus.push("99/1/2", 23);
    bus.push("99/1/3", 1);
    expect(driver.getState(devHc, "temperature")).toEqual({ kind: "temperature", ambientC: 23, targetC: 23, mode: "auto", heatCool: "heat" });

    const devStatus = "device-222100-regress-status" as DeviceId;
    await driver.bind({
      deviceId: devStatus,
      capability: "temperature",
      address: "100/1/1",
      config: { statusAddress: "100/1/2", dpt: "DPT9.001", hvacRoles: { status: { address: "100/1/3", dpt: "DPT22.101" } } },
    });
    bus.push("100/1/2", 24);
    bus.push("100/1/3", 1);
    const statusState = driver.getState(devStatus, "temperature");
    expect(statusState?.kind === "temperature" ? statusState.status?.fault : undefined).toBe(true);
  });

  it("AD — unrelated non-HVAC KNX bindings (onoff/position) are completely unaffected", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const light = "device-222100-light" as DeviceId;
    const blind = "device-222100-blind" as DeviceId;
    await driver.bind({ deviceId: light, capability: "onoff", address: "101/1/1" });
    await driver.bind({ deviceId: blind, capability: "position", address: "101/2/1", config: { dpt: "DPT5.001" } });

    await driver.command(light, { capability: "onoff", action: "on" });
    await driver.command(blind, { capability: "position", action: "set", position: 40 });
    expect(bus.writes).toContainEqual({ ga: "101/1/1", value: true, dpt: "DPT1.001" });
    expect(bus.writes).toContainEqual({ ga: "101/2/1", value: 40, dpt: "DPT5.001" });
    expect(driver.getState(light, "temperature")).toBeNull();
    expect(driver.getState(blind, "temperature")).toBeNull();
  });

  // § Phase 3.3C-5B §11 — MANDATORY update-order regression, exactly the sequence the
  // spec specifies: setpoints, then ambient, operatingMode, controllingModeExtended,
  // heatCool, status, then setpoints AGAIN — asserting every unrelated field survives
  // each step. Also covers the two extra orderings the spec calls out (ambient-then-
  // setpoints, status-then-setpoints).
  it("§11 MANDATORY update-order — setpoints, ambient, operatingMode, controllingModeExtended, heatCool, status, setpoints again", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-order" as DeviceId;
    await bindHvacAllRoles(driver, dev, {
      setpoint: "102/1/1", ambient: "102/1/2", opMode: "102/1/3", contrMode: "102/1/4", heatCool: "102/1/5", status: "102/1/6", setpoints: "102/1/7",
    });

    // Step 1: setpoints telegram FIRST — no primary reading exists yet, so no fabricated
    // ambientC/mode; the driver just remembers the decoded value (same discipline as the
    // Phase 3.3C-1 "role arrives before primary reading" test).
    bus.push("102/1/7", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toBeNull();

    // Step 2: ambient telegram — now the primary state exists, with setpoints merged in.
    bus.push("102/1/2", 23);
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 23,
      targetC: 23,
      mode: "auto",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // Step 3: operatingMode telegram — setpoints (and ambient) survive.
    bus.push("102/1/3", 1); // comfort
    expect(driver.getState(dev, "temperature")).toMatchObject({
      ambientC: 23,
      operatingMode: "comfort",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // Step 4: controllingModeExtended telegram — setpoints survive.
    bus.push("102/1/4", 3); // cool
    expect(driver.getState(dev, "temperature")).toMatchObject({
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // Step 5: heatCool telegram — setpoints survive.
    bus.push("102/1/5", 0); // cool
    expect(driver.getState(dev, "temperature")).toMatchObject({
      controllingModeExtended: "cool",
      heatCool: "cool",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // Step 6: status telegram — setpoints (and everything else) survive.
    bus.push("102/1/6", 1 << 0); // fault
    expect(driver.getState(dev, "temperature")).toMatchObject({
      heatCool: "cool",
      status: { fault: true },
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });

    // Step 7: setpoints telegram AGAIN, a new complete snapshot — replaces wholesale,
    // every other field (including status) stays intact.
    bus.push("102/1/7", { comfort: 22, standby: 20, economy: 670760.96 });
    const finalState = driver.getState(dev, "temperature");
    expect(finalState).toMatchObject({
      ambientC: 23,
      operatingMode: "comfort",
      controllingModeExtended: "cool",
      heatCool: "cool",
      status: { fault: true },
    });
    expect(finalState?.kind === "temperature" ? finalState.setpoints : null).toEqual({ comfortC: 22, standbyC: 20, economyC: null });
  });

  it("ambient-first-then-setpoints ordering: setpoints merges into the existing primary state without disturbing it", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-order-ambient-first" as DeviceId;
    await bindHvacSetpoints(driver, dev, { setpoint: "103/1/1", ambient: "103/1/2", setpoints: "103/1/3" });

    bus.push("103/1/2", 22);
    expect(driver.getState(dev, "temperature")).toEqual({ kind: "temperature", ambientC: 22, targetC: 22, mode: "auto" });

    bus.push("103/1/3", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 22,
      targetC: 22,
      mode: "auto",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });

  it("status-first-then-setpoints ordering: setpoints merges in without disturbing status", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-222100-order-status-first" as DeviceId;
    await driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: "104/1/1",
      config: {
        statusAddress: "104/1/2",
        dpt: "DPT9.001",
        hvacRoles: {
          status: { address: "104/1/3", dpt: "DPT22.101" },
          setpoints: { address: "104/1/4", dpt: "DPT222.100" },
        },
      },
    });

    bus.push("104/1/2", 20);
    bus.push("104/1/3", 1 << 14); // overheatAlarm
    expect(driver.getState(dev, "temperature")).toMatchObject({ status: { overheatAlarm: true } });

    bus.push("104/1/4", { comfort: 21, standby: 19, economy: 17 });
    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 20,
      targetC: 20,
      mode: "auto",
      status: {
        fault: false,
        ecoHeatingActive: false,
        flowTempLimitActive: false,
        returnTempLimitActive: false,
        heatingDisabled: false,
        ecoCoolingActive: false,
        coolingDisabled: false,
        dewPointAlarm: false,
        frostAlarm: false,
        overheatAlarm: true,
      },
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
    });
  });
});

describe("§ Phase 3.3D-FIX — mode-only/advanced-only temperature commands are rejected, not silently swallowed", () => {
  function bindHvacRoles(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; opMode: string; heatCool: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: gas.opMode, dpt: "DPT20.102" },
          heatCool: { address: gas.heatCool, dpt: "DPT1.100" },
        },
      },
    });
  }

  it("A — a mode-only command is rejected with a descriptive error, never silently swallowed", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-mode-only" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "110/1/1", ambient: "110/1/2", opMode: "110/1/3", heatCool: "110/1/4" });
    bus.push("110/1/2", 21); // establish a cached ambient/target the old bug would have re-sent

    await expect(driver.command(dev, { capability: "temperature", mode: "heat" })).rejects.toThrow(
      /no writable payload/,
    );
    expect(bus.writes).toEqual([]); // NO redundant primary-GA write, NO write anywhere
  });

  it("B — an advanced-only command is rejected with a descriptive error, never silently swallowed", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-advanced-only" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "111/1/1", ambient: "111/1/2", opMode: "111/1/3", heatCool: "111/1/4" });
    bus.push("111/1/2", 21);

    await expect(driver.command(dev, { capability: "temperature", advanced: { fanSpeed: "high" } })).rejects.toThrow(
      /no writable payload/,
    );
    expect(bus.writes).toEqual([]);
  });

  it("C — mode combined with targetC still writes targetC exactly as before (existing valid combination preserved)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-mode-plus-target" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "112/1/1", ambient: "112/1/2", opMode: "112/1/3", heatCool: "112/1/4" });

    await driver.command(dev, { capability: "temperature", mode: "heat", targetC: 22 });
    expect(bus.writes).toEqual([{ ga: "112/1/1", value: 22, dpt: "DPT9.001" }]);
  });

  it("D — advanced combined with targetC still writes targetC exactly as before (existing valid combination preserved)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-advanced-plus-target" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "113/1/1", ambient: "113/1/2", opMode: "113/1/3", heatCool: "113/1/4" });

    await driver.command(dev, { capability: "temperature", advanced: { fanSpeed: "low" }, targetC: 19 });
    expect(bus.writes).toEqual([{ ga: "113/1/1", value: 19, dpt: "DPT9.001" }]);
  });

  it("E — operatingMode-only still routes to hvacRoles.operatingMode, unaffected by this fix", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-operatingmode-only" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "114/1/1", ambient: "114/1/2", opMode: "114/1/3", heatCool: "114/1/4" });

    await driver.command(dev, { capability: "temperature", operatingMode: "comfort" });
    expect(bus.writes).toEqual([{ ga: "114/1/3", value: 1, dpt: "DPT20.102" }]);
  });

  it("F — heatCool-only still routes to hvacRoles.heatCool, unaffected by this fix", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-heatcool-only" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "115/1/1", ambient: "115/1/2", opMode: "115/1/3", heatCool: "115/1/4" });

    await driver.command(dev, { capability: "temperature", heatCool: "cool" });
    expect(bus.writes).toEqual([{ ga: "115/1/4", value: 0, dpt: "DPT1.100" }]);
  });

  it("mode-only combined with a real operatingMode write no longer also fires a redundant primary-GA write (bonus regression of the same fix)", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-mode-plus-operatingmode" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "116/1/1", ambient: "116/1/2", opMode: "116/1/3", heatCool: "116/1/4" });
    bus.push("116/1/2", 21);

    await driver.command(dev, { capability: "temperature", mode: "heat", operatingMode: "comfort" });
    expect(bus.writes).toEqual([{ ga: "116/1/3", value: 1, dpt: "DPT20.102" }]); // only the real operatingMode write
    expect(bus.writes.some((w) => w.ga === "116/1/1")).toBe(false); // no redundant primary-GA write
  });

  it("targetLowC/targetHighC-only commands remain unaffected by this fix", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-dual-setpoint" as DeviceId;
    await bindHvacRoles(driver, dev, { setpoint: "117/1/1", ambient: "117/1/2", opMode: "117/1/3", heatCool: "117/1/4" });

    await driver.command(dev, { capability: "temperature", targetLowC: 18, targetHighC: 24 });
    expect(bus.writes).toHaveLength(1);
    expect(bus.writes[0]?.ga).toBe("117/1/1");
  });
});

describe("§ Phase 3.3D-FIX — duplicate HVAC GA assignment regression", () => {
  // § Documented CURRENT behavior (not redesigned — see the Phase 3.3D-FIX spec's "if
  // current behavior is acceptable, preserve it"): `FakeKnxBus.observe()` keeps exactly
  // ONE handler per GA in a `Map`, so registering a second subscription on an
  // already-used GA OVERWRITES the first — deterministic last-registered-wins, not a
  // fan-out to multiple handlers. `KnxProtocolDriver.observe()` always registers the
  // PRIMARY GA first, then each `hvacRoles` entry in the order `Object.entries()` yields
  // (i.e. the order the roles appear in `config.hvacRoles`), so for a shared GA the LAST
  // role declared in that object — or the primary GA if no role shares its address —
  // is the one that actually receives every telegram on it. This is real, load-bearing
  // determinism (not an assumption): it follows directly from `Map.set()`'s
  // last-write-wins semantics plus `Object.entries()`'s insertion-order guarantee.
  it("A — primary GA equal to the operatingMode role GA: the operatingMode role (registered after the primary) deterministically wins; no primary state is ever fabricated from it", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-dup-primary-opmode" as DeviceId;
    // The primary write/status GA and the operatingMode role GA are THE SAME address —
    // a malformed/unusual persisted config, but not structurally prevented.
    await driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: "118/1/1",
      config: { dpt: "DPT9.001", hvacRoles: { operatingMode: { address: "118/1/1", dpt: "DPT20.102" } } },
    });

    bus.push("118/1/1", 1);
    // The operatingMode subscriber (registered after the primary) owns this GA and
    // correctly declines to fabricate a primary reading — no ambientC/mode is invented.
    expect(driver.getState(dev, "temperature")).toBeNull();
    expect(driver.getHvacRoleValue(dev, "temperature", "operatingMode")).toBe(1);
  });

  it("B — status role GA equal to setpoints role GA: the setpoints role (registered after status) deterministically wins; status is never fabricated from it, and the primary state is never corrupted", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-dup-status-setpoints" as DeviceId;
    await driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: "119/1/1",
      config: {
        statusAddress: "119/1/2",
        dpt: "DPT9.001",
        hvacRoles: {
          status: { address: "119/1/3", dpt: "DPT22.101" },
          setpoints: { address: "119/1/3", dpt: "DPT222.100" }, // SAME address as status
        },
      },
    });
    bus.push("119/1/2", 20);
    bus.push("119/1/3", { comfort: 21, standby: 19, economy: 17 });

    const state = driver.getState(dev, "temperature");
    expect(state).toEqual({
      kind: "temperature",
      ambientC: 20,
      targetC: 20,
      mode: "auto",
      setpoints: { comfortC: 21, standbyC: 19, economyC: 17 },
      // "status" is absent — its subscriber never received a telegram on this shared GA.
    });
  });

  it("C — two auxiliary roles (operatingMode and heatCool) sharing the same GA: heatCool (registered after operatingMode) deterministically wins; operatingMode is never fabricated, primary state never corrupted", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-fix-dup-two-aux-roles" as DeviceId;
    await driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: "120/1/1",
      config: {
        statusAddress: "120/1/2",
        dpt: "DPT9.001",
        hvacRoles: {
          operatingMode: { address: "120/1/3", dpt: "DPT20.102" },
          heatCool: { address: "120/1/3", dpt: "DPT1.100" }, // SAME address as operatingMode
        },
      },
    });
    bus.push("120/1/2", 22);
    bus.push("120/1/3", 1); // valid for BOTH decoders — but only ONE subscriber ever sees it

    expect(driver.getState(dev, "temperature")).toEqual({
      kind: "temperature",
      ambientC: 22,
      targetC: 22,
      mode: "auto",
      heatCool: "heat",
      // "operatingMode" is absent — its subscriber was overwritten before ever firing.
    });
  });
});

describe("§ Phase 3.4B — Matter SystemMode Heat/Cool commands route through the real KNX heatCool role", () => {
  function bindHvacHeatCool(driver: KnxProtocolDriver, dev: DeviceId, gas: { setpoint: string; ambient: string; heatCool: string }) {
    return driver.bind({
      deviceId: dev,
      capability: "temperature",
      address: gas.setpoint,
      config: {
        statusAddress: gas.ambient,
        dpt: "DPT9.001",
        hvacRoles: { heatCool: { address: gas.heatCool, dpt: "DPT1.100" } },
      },
    });
  }

  it("3 — a Matter SystemMode.Heat command, unmodified, reaches the existing KNX heatCool role GA with the correct DPT 1.100 value", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-heat" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "130/1/1", ambient: "130/1/2", heatCool: "130/1/3" });

    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Heat)!;
    await driver.command(dev, command);
    expect(bus.writes).toEqual([{ ga: "130/1/3", value: 1, dpt: "DPT1.100" }]);
  });

  it("3 — a Matter SystemMode.Cool command, unmodified, reaches the existing KNX heatCool role GA with the correct DPT 1.100 value", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-cool" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "131/1/1", ambient: "131/1/2", heatCool: "131/1/3" });

    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Cool)!;
    await driver.command(dev, command);
    expect(bus.writes).toEqual([{ ga: "131/1/3", value: 0, dpt: "DPT1.100" }]);
  });

  it("4 — a Matter Heat/Cool command against a device with no heatCool role bound fails descriptively — no fabricated fallback GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-heat-nobinding" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "temperature", address: "132/1/1" }); // no hvacRoles at all

    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Heat)!;
    await expect(driver.command(dev, command)).rejects.toThrow(/no "heatCool" HVAC role/);
    expect(bus.writes).toEqual([]);
  });

  it("5 — a Matter Heat/Cool command never writes the primary temperature GA, only the heatCool role GA", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-heat-no-primary-write" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "133/1/1", ambient: "133/1/2", heatCool: "133/1/3" });
    bus.push("133/1/2", 21); // establish a cached ambient/target — proves it's never redundantly re-sent

    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Heat)!;
    await driver.command(dev, command);
    expect(bus.writes.some((w) => w.ga === "133/1/1")).toBe(false); // primary GA never touched
    expect(bus.writes).toEqual([{ ga: "133/1/3", value: 1, dpt: "DPT1.100" }]);
  });

  it("Off/FanOnly Matter commands, unmodified, still fail via the existing 3.3D-FIX rejection — not silently swallowed, no invented KNX mapping", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-off" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "134/1/1", ambient: "134/1/2", heatCool: "134/1/3" });

    const offCommand = temperatureCommandForSystemMode(Thermostat.SystemMode.Off)!;
    await expect(driver.command(dev, offCommand)).rejects.toThrow(/no writable payload/);

    const fanOnlyCommand = temperatureCommandForSystemMode(Thermostat.SystemMode.FanOnly)!;
    await expect(driver.command(dev, fanOnlyCommand)).rejects.toThrow(/no writable payload/);
    expect(bus.writes).toEqual([]);
  });

  it("state authority: feedback disagreeing with the requested Matter mode wins — no optimistic heatCool state", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    const dev = "device-matter-heat-confirm" as DeviceId;
    await bindHvacHeatCool(driver, dev, { setpoint: "135/1/1", ambient: "135/1/2", heatCool: "135/1/3" });
    bus.push("135/1/2", 21);

    const command = temperatureCommandForSystemMode(Thermostat.SystemMode.Heat)!;
    await driver.command(dev, command);
    // Not yet reflected — no real feedback has arrived.
    const before = driver.getState(dev, "temperature");
    expect(before?.kind === "temperature" ? before.heatCool : "wrong-kind").toBeUndefined();

    bus.push("135/1/3", 0); // the real device actually settled on cool, not the requested heat
    expect(driver.getState(dev, "temperature")).toMatchObject({ heatCool: "cool" });
  });
});
