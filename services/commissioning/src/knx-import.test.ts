import { describe, expect, it } from "vitest";
import { classifyCircuit, groupIntoDevices, inferCapability, normalizeDpt, parseKnxGroupExport } from "./knx-import.js";

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

  it("infers color for RGB/RGBW DPTs and tunable-white colour-temperature", () => {
    expect(inferCapability("232.600", "Living Room Cove RGB")).toBe("color");
    expect(inferCapability("251.600", "Media Wall RGBWW")).toBe("color");
    expect(inferCapability("7.600", "Kitchen Spot Colour Temperature")).toBe("color");
    // No DPT at all: fall back to the name for RGBWW/tunable-white fixtures.
    expect(inferCapability(null, "Study Downlight Tunable White")).toBe("color");
    // Main Group disambiguates a bare 5.001 as brightness vs. cover position.
    expect(inferCapability("5.001", "Dining Hanging", "Lighting")).toBe("brightness");
    expect(inferCapability("5.001", "Master Bedroom Sheer Curtains", "Curtain")).toBe("position");
  });

  it("classifies the circuit type from a device's inferred bindings", () => {
    expect(classifyCircuit([{ capability: "onoff", address: "1/1/1" }])).toBe("onoff");
    expect(classifyCircuit([{ capability: "brightness", address: "1/1/2" }])).toBe("dimmable");
    expect(
      classifyCircuit([
        { capability: "onoff", address: "1/1/1" },
        { capability: "brightness", address: "1/1/2" },
        { capability: "color", address: "1/1/3" },
      ]),
    ).toBe("tunable_white");
    expect(classifyCircuit([{ capability: "color", address: "1/1/4" }])).toBe("rgbww");
    expect(classifyCircuit([{ capability: "position", address: "2/1/1" }])).toBe("cover");
    expect(classifyCircuit([{ capability: "temperature", address: "3/1/1" }])).toBe("climate");
    expect(classifyCircuit([{ capability: "sensor", address: "4/1/1" }])).toBe("other");
  });

  it("groups a tunable-white fixture's switch/dim/colour-temp GAs into one device", () => {
    const gas = parseKnxGroupExport(`<x>
      <GroupAddress Name="Study Downlight - Switch" Address="1/3/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Study Downlight - Brightness" Address="1/3/2" DPTs="DPST-5-1" />
      <GroupAddress Name="Study Downlight - Colour Temperature" Address="1/3/3" DPTs="DPST-7-600" />
    </x>`);
    const devices = groupIntoDevices(gas, ["Study"]);
    const downlight = devices.find((d) => d.name.includes("Downlight"));
    expect(downlight?.room).toBe("Study");
    expect(new Set(downlight?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness", "color"]));
    expect(classifyCircuit(downlight!.bindings)).toBe("tunable_white");
  });

  it("parses the ETS XML group-address export", () => {
    const xml = `<GroupAddress-Export>
      <GroupAddress Name="Living Room Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Living Room Ceiling - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
      <GroupAddress Name="Lounge Blinds - Position" Address="2/1/1" DPTs="DPST-5-1" />
    </GroupAddress-Export>`;
    const gas = parseKnxGroupExport(xml);
    expect(gas).toHaveLength(3);
    expect(gas[0]).toEqual({
      address: "1/1/1",
      name: "Living Room Ceiling - Switch",
      dpt: "1.001",
      mainGroup: null,
      middleGroup: null,
    });
  });

  it("captures the ETS Main/Middle Group names from nested <GroupRange> in an XML export", () => {
    const xml = `<GroupAddress-Export>
      <GroupRange Name="Lighting">
        <GroupRange Name="Switching">
          <GroupAddress Name="Living Spot-1" Address="1/1/1" DPTs="DPST-1-1" />
        </GroupRange>
        <GroupRange Name="Relative Dimming">
          <GroupAddress Name="Living Spot-1" Address="1/2/1" DPTs="DPST-3-7" />
        </GroupRange>
      </GroupRange>
      <GroupRange Name="Curtain">
        <GroupRange Name="Switching Feedback">
          <GroupAddress Name="Master Bedroom Main Curtain" Address="2/1/1" DPTs="DPST-1-1" />
        </GroupRange>
      </GroupRange>
    </GroupAddress-Export>`;
    const gas = parseKnxGroupExport(xml);
    expect(gas.find((g) => g.address === "1/1/1")).toMatchObject({ mainGroup: "Lighting", middleGroup: "Switching" });
    expect(gas.find((g) => g.address === "1/2/1")).toMatchObject({ mainGroup: "Lighting", middleGroup: "Relative Dimming" });
    expect(gas.find((g) => g.address === "2/1/1")).toMatchObject({ mainGroup: "Curtain", middleGroup: "Switching Feedback" });
  });

  it("detects Main/Middle group CSV columns", () => {
    const csv = [
      `"Main";"Middle";"Group name";"Address";"DatapointType"`,
      `"Lighting";"Switching";"Living Spot-1";"1/1/1";"DPST-1-1"`,
    ].join("\n");
    const gas = parseKnxGroupExport(csv);
    expect(gas[0]).toMatchObject({ mainGroup: "Lighting", middleGroup: "Switching" });
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
