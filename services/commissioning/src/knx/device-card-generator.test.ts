import { describe, expect, it } from "vitest";
import { parseGaExport } from "./ga-export-parser.js";
import { recognizeDevices } from "./device-recognition-engine.js";
import { generateDeviceCard } from "./device-card-generator.js";

describe("device card generator", () => {
  it("gives a dimmable light a toggle + brightness slider, never a colour control it doesn't have", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Spot - Switch" Address="1/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Spot - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
    </x>`);
    const [device] = recognizeDevices(model).devices;
    const card = generateDeviceCard(device!);
    expect(card.icon).toBe("lightbulb");
    expect(card.controls.map((c) => c.kind).sort()).toEqual(["brightness_slider", "toggle"]);
    expect(card.controls.some((c) => c.kind === "color_wheel")).toBe(false);
  });

  it("gives a curtain open/close/stop + position slider", () => {
    const model = parseGaExport(`<x><GroupAddress Name="Curtain - Position" Address="2/1/1" DPTs="DPST-5-1" /></x>`);
    const [device] = recognizeDevices(model).devices;
    const card = generateDeviceCard(device!);
    expect(card.icon).toBe("curtains");
    expect(card.controls.map((c) => c.kind).sort()).toEqual(["open_close_stop", "position_slider"]);
  });

  it("gives a door lock a lock toggle and Lock/Unlock quick actions", () => {
    const model = parseGaExport(`<x><GroupAddress Name="Front Door Lock" Address="3/1/1" DPTs="DPST-1-1" /></x>`);
    const [device] = recognizeDevices(model).devices;
    const card = generateDeviceCard(device!);
    expect(card.icon).toBe("lock");
    expect(card.controls).toEqual([{ kind: "lock_toggle", capability: "lock" }]);
    expect(card.quickActions).toEqual(["Lock", "Unlock"]);
  });
});
