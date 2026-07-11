import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { KnxProtocolDriver, type KnxConnection, type KnxValue } from "./knx-driver.js";
import { stateFromValue, valueFromCommand } from "./knx-codec.js";

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

  it("rejects a command for an unbound device", async () => {
    const bus = new FakeKnxBus();
    const driver = new KnxProtocolDriver({ host: "10.0.0.9", createConnection: async () => bus });
    await driver.connect();
    await expect(
      driver.command("nope" as DeviceId, { capability: "onoff", action: "on" }),
    ).rejects.toThrow(/not bound/);
  });
});
