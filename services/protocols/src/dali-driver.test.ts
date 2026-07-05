import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { DaliProtocolDriver, type DaliBus, type DaliUnitInfo } from "./dali-driver.js";
import {
  arcPowerFromPercent,
  commandToDali,
  daliAddressByte,
  parseDaliAddress,
  percentFromArcPower,
  type DaliAddress,
} from "./dali-codec.js";

/** A fake DALI bus: records arc/colour writes, answers level queries, lists units. */
class FakeDaliBus implements DaliBus {
  readonly arc: Array<{ addr: DaliAddress; level: number }> = [];
  readonly colour: Array<{ addr: DaliAddress; mireds: number }> = [];
  level = 0;
  connected = false;
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async setArcPower(addr: DaliAddress, level: number) {
    this.arc.push({ addr, level });
    this.level = level;
  }
  async setColourTemperature(addr: DaliAddress, mireds: number) {
    this.colour.push({ addr, mireds });
  }
  async queryActualLevel() {
    return this.level;
  }
  async scan(): Promise<DaliUnitInfo[]> {
    return [
      { shortAddress: 3, deviceType: 6 }, // LED → onoff + brightness
      { shortAddress: 7, deviceType: 8 }, // colour → + color
    ];
  }
}

describe("DALI codec (IEC 62386)", () => {
  it("encodes address bytes per IEC 62386-102", () => {
    // Short address 5, DAPC (selector 0) → (5<<1)|0 = 0x0A; command (selector 1) → 0x0B.
    expect(daliAddressByte({ kind: "short", value: 5 }, 0)).toBe(0x0a);
    expect(daliAddressByte({ kind: "short", value: 5 }, 1)).toBe(0x0b);
    // Group 2 → 0x80 | (2<<1) | selector.
    expect(daliAddressByte({ kind: "group", value: 2 }, 0)).toBe(0x84);
    // Broadcast → 0xFE DAPC, 0xFF command.
    expect(daliAddressByte({ kind: "broadcast", value: 0 }, 0)).toBe(0xfe);
    expect(daliAddressByte({ kind: "broadcast", value: 0 }, 1)).toBe(0xff);
  });

  it("maps the logarithmic dimming curve endpoints (254 ↔ 100%, 1 ↔ 0.1%)", () => {
    expect(arcPowerFromPercent(100)).toBe(254);
    expect(arcPowerFromPercent(0)).toBe(0);
    expect(percentFromArcPower(254)).toBe(100);
    expect(percentFromArcPower(0)).toBe(0);
    // Linear option is a straight scale.
    expect(arcPowerFromPercent(50, "linear")).toBe(127);
  });

  it("parses addresses and maps commands to operations", () => {
    expect(parseDaliAddress("group:4")).toEqual({ kind: "group", value: 4 });
    expect(parseDaliAddress("9")).toEqual({ kind: "short", value: 9 });
    expect(commandToDali({ capability: "onoff", action: "off" }, null)).toEqual({ op: "off" });
    expect(commandToDali({ capability: "color", kelvin: 4000 }, null)).toEqual({ op: "colourTemp", mireds: 250 });
  });
});

describe("DaliProtocolDriver (fake bus)", () => {
  it("drives arc power for brightness and polls actual level back", async () => {
    const bus = new FakeDaliBus();
    const driver = new DaliProtocolDriver({ createBus: async () => bus, pollMs: 1_000_000 });
    await driver.connect();
    expect(bus.connected).toBe(true);

    const dev = "device-dali-track" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "short:3" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "brightness", action: "set", level: 100 });
    expect(bus.arc.at(-1)).toEqual({ addr: { kind: "short", value: 3 }, level: 254 });
    expect(driver.getState(dev, "brightness")).toEqual({ kind: "brightness", on: true, level: 100 });

    // Someone dims the unit on the wall; a poll reads the new actual level.
    bus.level = 0;
    await driver.poll();
    expect(events.at(-1)?.state).toEqual({ kind: "brightness", on: false, level: 0 });
  });

  it("sends DT8 colour temperature for a color command", async () => {
    const bus = new FakeDaliBus();
    const driver = new DaliProtocolDriver({ createBus: async () => bus });
    await driver.connect();
    const dev = "device-dali-tw" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "color", address: "short:7" });

    await driver.command(dev, { capability: "color", kelvin: 2700 });
    expect(bus.colour.at(-1)?.mireds).toBe(Math.round(1_000_000 / 2700));
    const state = driver.getState(dev, "color");
    expect(state?.kind).toBe("color");
    // mireds is an integer, so the kelvin round-trip is within a few K.
    expect(Math.abs((state as { kelvin: number }).kelvin - 2700)).toBeLessThanOrEqual(5);
  });

  it("discovers commissioned units and maps device types to capabilities", async () => {
    const bus = new FakeDaliBus();
    const driver = new DaliProtocolDriver({ createBus: async () => bus });
    await driver.connect();
    const found = await driver.discover();
    expect(found.map((d) => d.backendId)).toEqual(["short:3", "short:7"]);
    expect(found[0]?.capabilities).toEqual(["onoff", "brightness"]);
    expect(found[1]?.capabilities).toEqual(["onoff", "brightness", "color"]);
  });
});
