import { describe, expect, it } from "vitest";
import { isFullyBindable, planBindings } from "./binding-engine.js";
import { mapUnifiedDevices } from "./unified-device-mapper.js";

function kitchenLightWithGa() {
  return mapUnifiedDevices({
    ets: [
      { id: "1/1/1", name: "Kitchen Light SW" },
      { id: "1/1/2", name: "Kitchen Light STATUS" },
    ],
  })[0]!;
}

describe("planBindings", () => {
  it("binds a device with a real ETS group address for write and a second for feedback", () => {
    const plans = planBindings(kitchenLightWithGa());
    expect(plans).toHaveLength(1); // onoff only — no dim signal in this fixture
    expect(plans[0]).toMatchObject({ capability: "onoff", address: "1/1/1", bindable: true });
    expect(plans[0]?.config.statusAddress).toBe("1/1/2");
    expect(isFullyBindable(plans)).toBe(true);
  });

  it("marks a KNX-IoT-only device as not bindable, never fabricating a group address", () => {
    const device = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.42", linkFormat: '</dev>;title="Kitchen Light"' }],
    })[0]!;
    const plans = planBindings(device);
    expect(plans.every((p) => p.bindable === false && p.address === null)).toBe(true);
    expect(isFullyBindable(plans)).toBe(false);
  });

  it("reports no plans (and not bindable) for a device with zero detected capabilities", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/9", name: "Xyzzy Foo" }] })[0]!;
    expect(planBindings(device)).toEqual([]);
    expect(isFullyBindable([])).toBe(false);
  });

  it("binds each capability of a merged multi-capability device to ITS OWN group address — not the first one found on the whole device (§ real production defect, showroomtest-2.csv.xml)", () => {
    const device = mapUnifiedDevices({
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
    })[0]!;

    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);

    const onoff = plans.find((p) => p.capability === "onoff")!;
    expect(onoff.address).toBe("5/3/0");
    expect(onoff.config.statusAddress).toBe("5/3/1");

    const brightness = plans.find((p) => p.capability === "brightness")!;
    expect(brightness.address).toBe("5/3/3");
    expect(brightness.config.statusAddress).toBe("5/3/4");
    expect(brightness.config.stepAddress).toBe("5/3/2");

    const color = plans.find((p) => p.capability === "color")!;
    expect(color.address).toBe("5/3/5");
    expect(color.config.statusAddress).toBe("5/3/6");
    expect(color.config.stepAddress).toBe("5/3/7");

    // Every capability got a DIFFERENT write address — the bug this test guards
    // against bound all three to whichever address came first (5/3/0).
    expect(new Set([onoff.address, brightness.address, color.address]).size).toBe(3);
  });
});
