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
});
