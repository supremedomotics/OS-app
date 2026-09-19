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

  it("§ Phase 3.3B — threads a temperature binding's hvacRoles into config.hvacRoles, keyed by semantic role", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Living Room AC - Setpoint" Address="3/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Living Room AC - Current Temperature" Address="3/1/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Living Room AC - Mode" Address="3/1/3" DPTs="DPST-20-102" />
    </x>`);
    const [device] = recognizeDevices(model, ["Living Room"]).devices;
    const entity = generateEntities(device!);
    const tempBinding = entity.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.config).toEqual({
      dpt: "DPT9.001",
      statusAddress: "3/1/2",
      hvacRoles: { operatingMode: { address: "3/1/3", dpt: "DPT20.102" } },
    });
  });

  it("§ Phase 3.3B — a single-GA temperature binding (no HVAC roles) carries no hvacRoles key at all", () => {
    const model = parseGaExport(`<x><GroupAddress Name="Bathroom Floor Setpoint" Address="4/2/1" DPTs="DPST-9-1" /></x>`);
    const [device] = recognizeDevices(model).devices;
    const entity = generateEntities(device!);
    expect(entity.bindings[0]?.config).not.toHaveProperty("hvacRoles");
  });
});
