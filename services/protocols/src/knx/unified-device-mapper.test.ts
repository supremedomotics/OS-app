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
});
