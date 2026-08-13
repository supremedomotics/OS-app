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

  // § Binding Evidence Hierarchy (Pass 11.4) — the real Nirma-project finding: a
  // capability can legitimately carry MORE than one "primary"-role write candidate
  // (its own local circuit command plus one or more fanned-in shared/central GAs that
  // also happen to carry a real SEND relationship to this device). `own[0]`/`.find()`
  // picked whichever candidate happened to be first in the caller's ETS-export-order
  // array; these tests prove primary/step selection is now order-independent, ranks a
  // local object over a fanned-in shared one, and only falls back to a shared object
  // when no local alternative exists — never a hardcoded GA-name/project rule.
  describe("primary/step selection is deterministic and evidence-ranked, not array-order-dependent (Pass 11.4)", () => {
    function threeLocalCandidatesFixture() {
      // "1/0/1" and "1/0/2" are both genuinely local (each references only this one
      // device — no multi-device links array), so id order alone must break the tie
      // deterministically. "1/0/0" is a real shared/central GA (2+ distinct devices in
      // its links) and must never outrank either local one, regardless of its id.
      return {
        ets: [
          { id: "1/0/2", name: "Local Switch B", dpt: "1.001", individualAddress: "1.1.1", channel: 1 },
          { id: "1/0/1", name: "Local Switch A", dpt: "1.001", individualAddress: "1.1.1", channel: 1 },
          {
            id: "1/0/0",
            name: "All On",
            dpt: "1.001",
            individualAddress: "1.1.1",
            channel: 1,
            links: [
              { role: "send" as const, individualAddress: "1.1.1" },
              { role: "receive" as const, individualAddress: "1.1.2" },
            ],
          },
        ],
      };
    }

    it("multiple LOCAL primary candidates: the lowest GA id wins, deterministically, regardless of input array order", () => {
      const forward = mapUnifiedDevices(threeLocalCandidatesFixture())[0]!;
      const reversed = mapUnifiedDevices({ ets: [...threeLocalCandidatesFixture().ets].reverse() })[0]!;
      const forwardOnoff = planBindings(forward).find((p) => p.capability === "onoff")!;
      const reversedOnoff = planBindings(reversed).find((p) => p.capability === "onoff")!;
      expect(forwardOnoff.address).toBe("1/0/1"); // lower id among the two LOCAL candidates
      expect(reversedOnoff.address).toBe("1/0/1");
      // extraCommandAddresses preserves evidence-ranked order (remaining local
      // candidates before shared ones), not alphabetical.
      expect(forwardOnoff.config.extraCommandAddresses).toEqual(["1/0/2", "1/0/0"]);
      expect(reversedOnoff.config.extraCommandAddresses).toEqual(["1/0/2", "1/0/0"]);
    });

    it("multiple SHARED candidates and zero local ones: still falls back to a shared primary deterministically (never fabricated, never order-dependent)", () => {
      const fixture = {
        ets: [
          {
            id: "2/0/9",
            name: "Central Scene B",
            dpt: "1.001",
            individualAddress: "1.1.5",
            channel: 1,
            links: [
              { role: "send" as const, individualAddress: "1.1.5" },
              { role: "receive" as const, individualAddress: "1.1.6" },
            ],
          },
          {
            id: "2/0/3",
            name: "Central Scene A",
            dpt: "1.001",
            individualAddress: "1.1.5",
            channel: 1,
            links: [
              { role: "send" as const, individualAddress: "1.1.5" },
              { role: "receive" as const, individualAddress: "1.1.7" },
            ],
          },
        ],
      };
      const forward = mapUnifiedDevices(fixture)[0]!;
      const reversed = mapUnifiedDevices({ ets: [...fixture.ets].reverse() })[0]!;
      const forwardOnoff = planBindings(forward).find((p) => p.capability === "onoff")!;
      const reversedOnoff = planBindings(reversed).find((p) => p.capability === "onoff")!;
      expect(forwardOnoff.address).toBe("2/0/3"); // lower id among the two SHARED candidates — no local alternative exists
      expect(reversedOnoff.address).toBe("2/0/3");
      expect(forwardOnoff.config.extraCommandAddresses).toEqual(["2/0/9"]);
    });

    it("step/nudge selection (relative dimming) is order-independent too — the same evidence hierarchy applies, not just primary/status", () => {
      const fixture = {
        ets: [
          { id: "3/0/1", name: "Local Dim SW", dpt: "1.001", individualAddress: "1.1.9", channel: 1 },
          { id: "3/0/2", name: "Local Dim Abs", dpt: "5.001", individualAddress: "1.1.9", channel: 1 },
          { id: "3/0/3", name: "Local Relative Dim", dpt: "3.007", individualAddress: "1.1.9", channel: 1 },
          {
            // A fanned-in shared step object referencing a different physical device
            // too — same DPT category, but must never outrank the device's own local
            // step object just because of array position.
            id: "3/0/4",
            name: "Central Relative Dim",
            dpt: "3.007",
            individualAddress: "1.1.9",
            channel: 1,
            links: [
              { role: "send" as const, individualAddress: "1.1.9" },
              { role: "receive" as const, individualAddress: "1.1.10" },
            ],
          },
        ],
      };
      const forward = mapUnifiedDevices(fixture)[0]!;
      const reversed = mapUnifiedDevices({ ets: [...fixture.ets].reverse() })[0]!;
      const forwardBrightness = planBindings(forward).find((p) => p.capability === "brightness")!;
      const reversedBrightness = planBindings(reversed).find((p) => p.capability === "brightness")!;
      expect(forwardBrightness.config.stepAddress).toBe("3/0/3"); // local step object, not the fanned-in shared one
      expect(reversedBrightness.config.stepAddress).toBe("3/0/3");
    });

    it("a DPT-incompatible candidate is filtered out upstream (per-signal capability tagging) and never wins primary — no capability-mismatched binding is ever produced", () => {
      // "3/0/9" is a genuine binary switch (DPT 1.001, onoff) on the SAME physical
      // device/channel as a brightness object — it must never be considered for the
      // brightness capability's primary slot just because it's local and low-id.
      const device = mapUnifiedDevices({
        ets: [
          { id: "3/0/9", name: "Local Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
          { id: "4/0/5", name: "Local Abs Dim", dpt: "5.001", individualAddress: "1.1.20", channel: 1 },
        ],
      })[0]!;
      const brightness = planBindings(device).find((p) => p.capability === "brightness")!;
      expect(brightness.address).toBe("4/0/5");
      expect(brightness.address).not.toBe("3/0/9");
    });
  });
});
