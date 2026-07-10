import { describe, expect, it } from "vitest";
import {
  generateKnxDevices,
  groupIntToTriplet,
  normalizeDpt,
  parseEtsGroupAddresses,
} from "./knx-ets.js";

describe("KNX ETS — DPT + address normalization", () => {
  it("normalizes the DPT spellings ETS emits", () => {
    expect(normalizeDpt("DPST-1-1")).toBe("DPT1.001");
    expect(normalizeDpt("DPT-5")).toBe("DPT5.000");
    expect(normalizeDpt("9.001")).toBe("DPT9.001");
    expect(normalizeDpt("DPT1.001")).toBe("DPT1.001");
    expect(normalizeDpt("")).toBeNull();
  });

  it("converts integer group addresses to 3-level form", () => {
    expect(groupIntToTriplet((1 << 11) | (1 << 8) | 3)).toBe("1/1/3");
  });
});

describe("KNX ETS — parsing", () => {
  it("parses a CSV group-address export", () => {
    const csv = [
      '"Group name";"Address";"DatapointType"',
      '"Living Room Ceiling - Switch";"1/1/1";"DPST-1-1"',
      '"Living Room Ceiling - Dimming Value";"1/2/1";"DPST-5-1"',
      '"Living Room Ceiling - Status";"1/3/1";"DPST-1-1"',
      '"Main Group";"1/-/-";""',
    ].join("\n");
    const gas = parseEtsGroupAddresses(csv);
    expect(gas).toHaveLength(3);
    expect(gas[0]).toEqual({ name: "Living Room Ceiling - Switch", address: "1/1/1", dpt: "DPT1.001" });
  });

  it("parses an XML group-address export with integer addresses", () => {
    const xml = `<GroupAddress-Export xmlns="http://knx.org/xml/ga-export/01">
      <GroupRange Name="Lighting">
        <GroupAddress Name="Kitchen Spots - Switch" Address="${(1 << 11) | (1 << 8) | 5}" DPTs="DPST-1-1" />
      </GroupRange>
    </GroupAddress-Export>`;
    const gas = parseEtsGroupAddresses(xml);
    expect(gas).toEqual([{ name: "Kitchen Spots - Switch", address: "1/1/5", dpt: "DPT1.001" }]);
  });
});

describe("KNX ETS — automatic device generation", () => {
  it("folds switch/dimming/status addresses into one dimmable device", () => {
    const gas = parseEtsGroupAddresses(
      [
        '"Group name";"Address";"DatapointType"',
        '"Living Room Ceiling - Switch";"1/1/1";"DPST-1-1"',
        '"Living Room Ceiling - Dimming Value";"1/2/1";"DPST-5-1"',
        '"Living Room Ceiling - Status";"1/3/1";"DPST-1-1"',
      ].join("\n"),
    );
    const [device] = generateKnxDevices(gas);
    expect(device.name).toBe("Living Room Ceiling");
    expect(device.capabilities.sort()).toEqual(["brightness", "onoff"]);
    const onoff = device.bindings.find((b) => b.capability === "onoff");
    expect(onoff).toMatchObject({ address: "1/1/1", config: { dpt: "DPT1.001", statusAddress: "1/3/1" } });
    expect(device.bindings.find((b) => b.capability === "brightness")).toMatchObject({ address: "1/2/1" });
  });

  it("maps a blind's DPT5 value to position, not brightness", () => {
    const gas = parseEtsGroupAddresses(
      [
        '"Group name";"Address";"DatapointType"',
        '"Bedroom Blind - Position";"2/1/1";"DPST-5-1"',
      ].join("\n"),
    );
    const [device] = generateKnxDevices(gas);
    expect(device.capabilities).toEqual(["position"]);
    expect(device.bindings[0]).toMatchObject({ capability: "position", address: "2/1/1", config: { dpt: "DPT5.001" } });
  });

  it("maps a DPT9 float to a temperature sensor with unit", () => {
    const gas = parseEtsGroupAddresses(
      ['"Group name";"Address";"DatapointType"', '"Hallway Temperature";"3/1/1";"DPST-9-1"'].join("\n"),
    );
    const [device] = generateKnxDevices(gas);
    expect(device.bindings[0]).toMatchObject({ capability: "sensor", config: { dpt: "DPT9.001", measure: "temperature", unit: "°C" } });
  });
});
