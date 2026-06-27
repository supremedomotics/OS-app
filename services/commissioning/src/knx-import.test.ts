import { describe, expect, it } from "vitest";
import { groupIntoDevices, inferCapability, normalizeDpt, parseKnxGroupExport } from "./knx-import.js";

describe("KNX group-address import", () => {
  it("normalizes ETS datapoint type strings", () => {
    expect(normalizeDpt("DPST-1-1")).toBe("1.001");
    expect(normalizeDpt("DPST-5-1")).toBe("5.001");
    expect(normalizeDpt("DPT-9")).toBe("9");
    expect(normalizeDpt("1.001")).toBe("1.001");
    expect(normalizeDpt(null)).toBeNull();
  });

  it("infers capabilities from DPT, disambiguating % by name", () => {
    expect(inferCapability("1.001", "Living Room Ceiling Switch")).toBe("onoff");
    expect(inferCapability("3.007", "Living Room Ceiling Dimming")).toBe("brightness");
    expect(inferCapability("5.001", "Living Room Ceiling Brightness")).toBe("brightness");
    expect(inferCapability("5.001", "Lounge Blinds Position")).toBe("position");
    expect(inferCapability("1.008", "Lounge Blinds Move")).toBe("position");
    expect(inferCapability("9.001", "Bedroom Temperature")).toBe("temperature");
    expect(inferCapability("1.001", "Front Door Lock")).toBe("lock");
  });

  it("parses the ETS XML group-address export", () => {
    const xml = `<GroupAddress-Export>
      <GroupAddress Name="Living Room Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Living Room Ceiling - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
      <GroupAddress Name="Lounge Blinds - Position" Address="2/1/1" DPTs="DPST-5-1" />
    </GroupAddress-Export>`;
    const gas = parseKnxGroupExport(xml);
    expect(gas).toHaveLength(3);
    expect(gas[0]).toEqual({ address: "1/1/1", name: "Living Room Ceiling - Switch", dpt: "1.001" });
  });

  it("parses the ETS CSV export (semicolon, with header)", () => {
    const csv = [
      `"Group name";"Address";"DatapointType"`,
      `"Living Room Ceiling - Switch";"1/1/1";"DPST-1-1"`,
      `"Living Room Ceiling - Brightness";"1/1/2";"DPST-5-1"`,
    ].join("\n");
    const gas = parseKnxGroupExport(csv);
    expect(gas).toHaveLength(2);
    expect(gas[1]?.address).toBe("1/1/2");
    expect(gas[1]?.dpt).toBe("5.001");
  });

  it("groups addresses into devices with capabilities + room", () => {
    const gas = parseKnxGroupExport(`<x>
      <GroupAddress Name="Living Room Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Living Room Ceiling - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
      <GroupAddress Name="Living Room Ceiling - Status" Address="1/1/3" DPTs="DPST-1-1" />
      <GroupAddress Name="Lounge Blinds - Position" Address="2/1/1" DPTs="DPST-5-1" />
      <GroupAddress Name="Bedroom Heating - Setpoint" Address="3/1/1" DPTs="DPST-9-1" />
    </x>`);
    const devices = groupIntoDevices(gas, ["Living Room", "Lounge", "Bedroom"]);

    const ceiling = devices.find((d) => d.name.includes("Ceiling"));
    expect(ceiling?.room).toBe("Living Room");
    // onoff + brightness, deduped despite the extra Status (1-bit) address.
    expect(new Set(ceiling?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness"]));

    const blinds = devices.find((d) => d.name.includes("Blinds"));
    expect(blinds?.room).toBe("Lounge");
    expect(blinds?.bindings[0]?.capability).toBe("position");

    const heating = devices.find((d) => d.name.includes("Heating"));
    expect(heating?.bindings[0]?.capability).toBe("temperature");
  });
});
