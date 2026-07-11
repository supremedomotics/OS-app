import { describe, expect, it } from "vitest";
import { parseGaExport } from "./ga-export-parser.js";
import { recognizeDevices } from "./device-recognition-engine.js";
import { generateEntities } from "./entity-generator.js";

describe("entity generator", () => {
  it("carries the DPT (with the driver's DPT-prefixed convention) and statusAddress into binding config", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Hall Light - Switch" Address="6/1/2" DPTs="DPST-1-1" />
      <GroupAddress Name="Hall Light - Switch Feedback" Address="6/1/1" DPTs="DPST-1-1" />
    </x>`);
    const [device] = recognizeDevices(model).devices;
    const entity = generateEntities(device!);
    expect(entity.bindings).toEqual([
      { capability: "onoff", address: "6/1/2", config: { dpt: "DPT1.001", statusAddress: "6/1/1" } },
    ]);
  });

  it("labels a sensor binding's measure/unit from its recognized role", () => {
    const model = parseGaExport(`<x><GroupAddress Name="Main Meter - Power" Address="4/1/1" DPTs="14.056" /></x>`);
    const [device] = recognizeDevices(model).devices;
    const entity = generateEntities(device!);
    expect(entity.bindings[0]?.config).toMatchObject({ dpt: "DPT14.056", measure: "power", unit: "W" });
  });
});
