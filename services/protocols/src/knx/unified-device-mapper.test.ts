import { groupByCircuitName } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { mapUnifiedDevices } from "./unified-device-mapper.js";
import { parseFunctionalBlocks } from "./functional-block-parser.js";

describe("mapUnifiedDevices", () => {
  it("returns nothing when no source contributed any signal — never fabricates a device", () => {
    expect(mapUnifiedDevices({})).toEqual([]);
  });

  it("runs the full pipeline example from the spec: KNX IoT + ETS + grouping → one canonical device", () => {
    const { blocks } = parseFunctionalBlocks(
      '</fb/1/sw>;rt="urn:knx:fb.onoff";if="if.a";title="Kitchen Light",' +
      '</fb/1/dim>;rt="urn:knx:fb.dim";if="if.a";title="Kitchen Light Dim"',
    );

    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.42", linkFormat: '</dev>;title="Kitchen Light"', functionalBlocks: blocks }],
      ets: [
        { id: "10.0.0.42", name: "Kitchen Light SW", room: "Kitchen" },
      ],
    });

    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.suggestedName).toBe("Kitchen Light");
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
    expect(device.raw.metadata.room).toBe("Kitchen");
    expect(device.raw.deviceKind).toBe("light");
    expect(device.raw.mergeExplanation.some((e) => e.includes("← knx_iot"))).toBe(true);
    expect(device.raw.mergeExplanation.some((e) => e.includes("← ets"))).toBe(true);
  });

  it("clusters ETS-only circuit signals by name even with no KNX IoT device present", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Kitchen Light SW" },
        { id: "1/1/2", name: "Kitchen Light STATUS" },
        { id: "1/1/3", name: "Kitchen Light DIM" },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.raw.groupingKey).toBe("kitchen light");
  });

  it("clusters a real ETS group-address export (showroomtest-2.csv.xml) into ONE Tunable White circuit, not five", () => {
    // The exact 8 communication objects from the real project that reproduced the
    // production bug: 5 devices instead of 1, with the color-temperature objects
    // showing "no capability detected". DPTs are the real DPST values, normalized the
    // same way `ga-export-parser.ts` normalizes them ("DPST-1-1" → "1.001", etc.).
    const devices = mapUnifiedDevices({
      ets: [
        { id: "5/3/0", name: "Conference Hanging SW", dpt: "1.001" },
        { id: "5/3/1", name: "Conference Hanging SW Status", dpt: "1.001" },
        { id: "5/3/2", name: "Conference Hanging Dimm", dpt: "3.007" },
        { id: "5/3/3", name: "Conference Hanging Abs Dim", dpt: "5.001" },
        { id: "5/3/4", name: "Conference Hanging Abs Dim FB", dpt: "5.001" },
        { id: "5/3/5", name: "Conference Hanging Abs Col", dpt: "7.600" },
        { id: "5/3/6", name: "Conference Hanging Abs Col FB", dpt: "7.600" },
        { id: "5/3/7", name: "Conference Hanging Relative Color", dpt: "3.007" },
      ],
    });

    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.raw.communicationObjects).toHaveLength(8);
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
    expect(device.raw.deviceKind).not.toBe("unknown");
  });

  it("still splits into separate circuits without KNX vocabulary (regression proof the fix is additive, not a default-behavior change)", () => {
    const clusters = groupByCircuitName([
      { id: "5/3/0", name: "Conference Hanging SW" },
      { id: "5/3/2", name: "Conference Hanging Dimm" },
      { id: "5/3/5", name: "Conference Hanging Abs Col" },
      { id: "5/3/7", name: "Conference Hanging Relative Color" },
    ]);
    expect(clusters).toHaveLength(4);
  });

  it("never duplicates a device across sources for the same circuit name", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "1/1/1", linkFormat: '</dev>;title="Kitchen Light"' }],
      ets: [{ id: "1/1/1", name: "Kitchen Light" }],
    });
    expect(devices).toHaveLength(1);
  });

  it("user overrides win over every other metadata source", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Kitchen Light", room: "Kitchen" }],
      userOverrides: { "kitchen light": { deviceName: "Chef's Light", room: "Chef's Kitchen" } },
    });
    expect(devices[0]?.suggestedName).toBe("Chef's Light");
    expect(devices[0]?.raw.metadata.room).toBe("Chef's Kitchen");
    expect(devices[0]?.raw.mergeExplanation.some((e) => e.includes('"Chef\'s Light" ← user'))).toBe(true);
  });

  it("Group Address Schema Engine: Schema 2's mid-string operation words merge correctly, which bare grouping could not do", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1", name: "Lighting - Switching - Living DL-1" },
        { id: "2", name: "Lighting - Dimming - Living DL-1" },
      ],
      schemaId: "circuit-operation-name",
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.raw.groupingKey).toBe("living dl-1");
    expect(devices[0]?.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
  });

  it("Schema 1's extracted room fills in when no per-signal room was given explicitly", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1", name: "Ground Floor - Living Room - Main Ceiling Light" }],
      schemaId: "floor-room-device",
    });
    expect(devices[0]?.raw.metadata.room).toBe("Living Room");
  });

  it("an explicit per-signal room still wins over the schema's extracted one", () => {
    const devices = mapUnifiedDevices({
      ets: [{ id: "1", name: "Ground Floor - Living Room - Main Ceiling Light", room: "Override Room" }],
      schemaId: "floor-room-device",
    });
    expect(devices[0]?.raw.metadata.room).toBe("Override Room");
  });
});
