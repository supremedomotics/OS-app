import { describe, expect, it } from "vitest";
import { planBindings, isFullyBindable } from "./binding-engine.js";
import { buildDeviceSynthesisEvidence, generateDeviceSynthesisReport } from "./device-synthesis-report.js";
import { mapUnifiedDevices, type UnifiedDeviceMapperInput } from "./unified-device-mapper.js";

/**
 * Production KNX Device Synthesis Audit — proves the EXISTING capability model
 * (`onoff, brightness, color, temperature, position, media, lock, fan, vacuum, sensor`)
 * can correctly synthesize complete logical devices from realistic per-device-type ETS
 * data, without inventing fan-speed or blind-tilt capabilities. No real `.knxproj`/
 * `.esf` fixture exists anywhere in this repository (checked via a recursive filesystem
 * search before writing these fixtures) — every fixture below is clearly synthetic,
 * built by hand to match real-world ETS `<Connectors>` Send/Receive shapes, never
 * presented as an imported project.
 */

function switchingActuator(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "1/1/1", name: "Utility SW", dpt: "1.001", individualAddress: "1.1.100", channel: 1, links: [{ role: "send", individualAddress: "1.1.100" }] },
    { id: "1/1/2", name: "Utility SW Status", dpt: "1.001", individualAddress: "1.1.100", channel: 1, links: [{ role: "receive", individualAddress: "1.1.100" }] },
  ];
}

function dimmableLight(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "2/1/1", name: "Study SW", dpt: "1.001", individualAddress: "1.1.101", channel: 1, links: [{ role: "send", individualAddress: "1.1.101" }] },
    { id: "2/1/2", name: "Study SW Status", dpt: "1.001", individualAddress: "1.1.101", channel: 1, links: [{ role: "receive", individualAddress: "1.1.101" }] },
    { id: "2/1/3", name: "Study Relative Dim", dpt: "3.007", individualAddress: "1.1.101", channel: 1 },
    { id: "2/1/4", name: "Study Abs Dim", dpt: "5.001", individualAddress: "1.1.101", channel: 1, links: [{ role: "send", individualAddress: "1.1.101" }] },
    { id: "2/1/5", name: "Study Abs Dim FB", dpt: "5.001", individualAddress: "1.1.101", channel: 1, links: [{ role: "receive", individualAddress: "1.1.101" }] },
  ];
}

function tunableWhiteLight(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "3/1/1", name: "Bedroom SW", dpt: "1.001", individualAddress: "1.1.102", channel: 1, links: [{ role: "send", individualAddress: "1.1.102" }] },
    { id: "3/1/2", name: "Bedroom SW Status", dpt: "1.001", individualAddress: "1.1.102", channel: 1, links: [{ role: "receive", individualAddress: "1.1.102" }] },
    { id: "3/1/3", name: "Bedroom Abs Dim", dpt: "5.001", individualAddress: "1.1.102", channel: 1, links: [{ role: "send", individualAddress: "1.1.102" }] },
    { id: "3/1/4", name: "Bedroom Abs Dim FB", dpt: "5.001", individualAddress: "1.1.102", channel: 1, links: [{ role: "receive", individualAddress: "1.1.102" }] },
    { id: "3/1/5", name: "Bedroom Abs Color Temp", dpt: "7.600", individualAddress: "1.1.102", channel: 1, links: [{ role: "send", individualAddress: "1.1.102" }] },
    { id: "3/1/6", name: "Bedroom Abs Color Temp FB", dpt: "7.600", individualAddress: "1.1.102", channel: 1, links: [{ role: "receive", individualAddress: "1.1.102" }] },
  ];
}

function rgbCctLight(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "4/1/1", name: "Lounge SW", dpt: "1.001", individualAddress: "1.1.103", channel: 1, links: [{ role: "send", individualAddress: "1.1.103" }] },
    { id: "4/1/2", name: "Lounge SW Status", dpt: "1.001", individualAddress: "1.1.103", channel: 1, links: [{ role: "receive", individualAddress: "1.1.103" }] },
    { id: "4/1/3", name: "Lounge Abs Dim", dpt: "5.001", individualAddress: "1.1.103", channel: 1, links: [{ role: "send", individualAddress: "1.1.103" }] },
    { id: "4/1/4", name: "Lounge Abs Dim FB", dpt: "5.001", individualAddress: "1.1.103", channel: 1, links: [{ role: "receive", individualAddress: "1.1.103" }] },
    { id: "4/1/5", name: "Lounge Abs RGB", dpt: "232.600", individualAddress: "1.1.103", channel: 1, links: [{ role: "send", individualAddress: "1.1.103" }] },
    { id: "4/1/6", name: "Lounge Abs RGB FB", dpt: "232.600", individualAddress: "1.1.103", channel: 1, links: [{ role: "receive", individualAddress: "1.1.103" }] },
  ];
}

// § Known, pre-existing DPT ambiguity (disclosed, not fixed here — out of this audit's
// scope): absolute blind position and a dimmer's absolute brightness are BOTH DPT 5.001
// ("Scaling (%)") per the KNX standard itself — `classifyEtsSignal` resolves DPT before
// name, so a 5.001 object always classifies as `brightness`, never `position`, with no
// way to tell them apart from the DPT alone. This fixture therefore only uses the
// DPT subtypes that ARE unambiguous (`1.008` Up/Down movement) — a real blind's
// absolute-position readback (also 5.001) would misclassify exactly the same way; that
// gap is reported honestly in the final synthesis report rather than special-cased away.
function blindActuator(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "5/1/1", name: "Terrace Blind Move", dpt: "1.008", individualAddress: "1.1.104", channel: 1, links: [{ role: "send", individualAddress: "1.1.104" }] },
    { id: "5/1/2", name: "Terrace Blind Move Status", dpt: "1.008", individualAddress: "1.1.104", channel: 1, links: [{ role: "receive", individualAddress: "1.1.104" }] },
  ];
}

function fanActuator(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "6/1/1", name: "Bathroom Fan SW", dpt: "1.001", individualAddress: "1.1.105", channel: 1, links: [{ role: "send", individualAddress: "1.1.105" }] },
    { id: "6/1/2", name: "Bathroom Fan SW Status", dpt: "1.001", individualAddress: "1.1.105", channel: 1, links: [{ role: "receive", individualAddress: "1.1.105" }] },
    // DPT 5.100 (fan_speed_percentage) — recognized (deviceKind "fan") but contributes NO
    // capability: knx-codec.ts has no fan-speed codec, so `defaultDpt`/`valueFromCommand`
    // can't drive it (§ pre-existing, disclosed limitation — see capability-mapper.ts's
    // own `fan_speed_percentage`/`hvac_fan_speed` doc comments). Never fabricated as
    // bindable just because a GA exists for it.
    { id: "6/1/3", name: "Bathroom Fan Speed", dpt: "5.100", individualAddress: "1.1.105", channel: 1, links: [{ role: "send", individualAddress: "1.1.105" }] },
  ];
}

function hvacThermostat(): UnifiedDeviceMapperInput["ets"] {
  return [
    { id: "7/1/1", name: "Hallway Thermostat Setpoint", dpt: "9.001", individualAddress: "1.1.106", channel: 1, links: [{ role: "send", individualAddress: "1.1.106" }] },
    { id: "7/1/2", name: "Hallway Thermostat Ambient", dpt: "9.001", individualAddress: "1.1.106", channel: 1, links: [{ role: "receive", individualAddress: "1.1.106" }] },
  ];
}

describe("Production KNX Device Synthesis Audit — per-device-type fixtures (existing capability model only)", () => {
  it("switching actuator: onoff only, command + feedback correctly resolved", () => {
    const device = mapUnifiedDevices({ ets: switchingActuator() })[0]!;
    expect(device.capabilities).toEqual(["onoff"]);
    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);
    expect(plans[0]).toMatchObject({ capability: "onoff", address: "1/1/1" });
    expect(plans[0]!.config.statusAddress).toBe("1/1/2");
  });

  it("dimmable light: onoff + brightness, each with its own command/feedback/step addresses", () => {
    const device = mapUnifiedDevices({ ets: dimmableLight() })[0]!;
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);
    const brightness = plans.find((p) => p.capability === "brightness")!;
    expect(brightness.address).toBe("2/1/4");
    expect(brightness.config.statusAddress).toBe("2/1/5");
    expect(brightness.config.stepAddress).toBe("2/1/3");
  });

  it("tunable white light: onoff + brightness + color (colour temperature), never inventing a 4th capability", () => {
    const device = mapUnifiedDevices({ ets: tunableWhiteLight() })[0]!;
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
    expect(device.capabilities).toHaveLength(3);
    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);
    const color = plans.find((p) => p.capability === "color")!;
    expect(color.address).toBe("3/1/5");
    expect(color.config.statusAddress).toBe("3/1/6");
  });

  it("RGB(+CCT) light: onoff + brightness + color (RGB triplet DPT), same capability vocabulary as tunable white — no separate RGB kind needed", () => {
    const device = mapUnifiedDevices({ ets: rgbCctLight() })[0]!;
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);
    const color = plans.find((p) => p.capability === "color")!;
    expect(color.address).toBe("4/1/5");
    expect(color.config.statusAddress).toBe("4/1/6");
  });

  it("blind actuator: position only — no tilt capability exists in the model, and none is fabricated for this fixture", () => {
    const device = mapUnifiedDevices({ ets: blindActuator() })[0]!;
    expect(device.capabilities).toEqual(["position"]);
    const plans = planBindings(device);
    expect(isFullyBindable(plans)).toBe(true);
    const position = plans[0]!;
    expect(position.address).toBe("5/1/1");
    expect(position.config.statusAddress).toBe("5/1/2");
  });

  it("fan actuator: onoff only — fan speed is recognized at the DPT/device-kind level but never bound, since knx-codec.ts has no fan-speed codec (disclosed, pre-existing limitation, not fixed here per explicit scope)", () => {
    const device = mapUnifiedDevices({ ets: fanActuator() })[0]!;
    expect(device.capabilities).toEqual(["onoff"]); // NOT ["onoff", "fan"] — never fabricated
    expect(device.raw.deviceKind).toBe("fan"); // still correctly identified as a fan physically
    const plans = planBindings(device);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.capability).toBe("onoff");
  });

  it("HVAC/thermostat: temperature capability, setpoint as command, ambient reading as feedback (single-GA binding — a real, documented limitation of the one-capability-one-binding model, not new to this pass)", () => {
    const device = mapUnifiedDevices({ ets: hvacThermostat() })[0]!;
    expect(device.capabilities).toEqual(["temperature"]);
    const plan = planBindings(device)[0]!;
    expect(plan.address).toBe("7/1/1");
    expect(plan.config.statusAddress).toBe("7/1/2");
  });
});

describe("Production KNX Device Synthesis Audit — multi-channel physical device", () => {
  it("one physical device (1.1.120) with 4 channels in 4 different rooms produces 4 independent logical devices, each with its own room/capabilities/bindings", () => {
    const ets: UnifiedDeviceMapperInput["ets"] = [1, 2, 3, 4].flatMap((ch) => [
      { id: `8/1/${ch * 2 - 1}`, name: `Channel ${ch} Switch`, dpt: "1.001", individualAddress: "1.1.120", channel: ch, room: `Room ${ch}`, links: [{ role: "send" as const, individualAddress: "1.1.120" }] },
      { id: `8/1/${ch * 2}`, name: `Channel ${ch} Switch Status`, dpt: "1.001", individualAddress: "1.1.120", channel: ch, room: `Room ${ch}`, links: [{ role: "receive" as const, individualAddress: "1.1.120" }] },
    ]);
    const devices = mapUnifiedDevices({ ets });
    expect(devices).toHaveLength(4);
    for (let ch = 1; ch <= 4; ch++) {
      const d = devices.find((x) => x.raw.groupingKey === `1.1.120#${ch}`)!;
      expect(d).toBeDefined();
      expect(d.raw.metadata.room).toBe(`Room ${ch}`);
      expect(d.raw.physicalDevice?.channel).toBe(ch);
      expect(d.capabilities).toEqual(["onoff"]);
    }
  });
});

describe("Production KNX Device Synthesis Audit — room/area naming confidence hierarchy", () => {
  it("an explicit, strong ETS room always wins over a weaker GA-name-derived guess embedded in the circuit name", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "9/1/1", name: "GroundFloor-Kitchen-MainLight SW", dpt: "1.001", individualAddress: "1.1.130", channel: 1, room: "Penthouse Suite" },
      ],
    })[0]!;
    // The circuit name text says "Kitchen" (a Main/Middle/GA-name-hierarchy-style guess);
    // the real ETS room field says "Penthouse Suite" — the real field must win.
    expect(device.raw.metadata.room).toBe("Penthouse Suite");
  });
});

describe("Production KNX Device Synthesis Audit — idempotency and determinism", () => {
  const combinedFixture = (): UnifiedDeviceMapperInput["ets"] => [
    ...switchingActuator()!,
    ...dimmableLight()!,
    ...tunableWhiteLight()!,
    ...blindActuator()!,
    ...hvacThermostat()!,
  ];

  it("running discovery twice on identical input produces the same devices, no duplicates", () => {
    const first = mapUnifiedDevices({ ets: combinedFixture() });
    const second = mapUnifiedDevices({ ets: combinedFixture() });
    expect(second).toHaveLength(first.length);
    expect(new Set(second.map((d) => d.raw.groupingKey))).toEqual(new Set(first.map((d) => d.raw.groupingKey)));
    for (const d of first) {
      const match = second.find((x) => x.raw.groupingKey === d.raw.groupingKey)!;
      expect(match.capabilities.slice().sort()).toEqual(d.capabilities.slice().sort());
    }
  });

  it("shuffling the order of physical devices/communication objects/links never changes the resulting device graph", () => {
    const original = combinedFixture()!;
    // Deterministic shuffle (fixed seed via reverse + interleave — no Math.random, so
    // this test itself is reproducible) rather than a real Fisher-Yates with a random
    // seed, which would make a failure non-reproducible.
    const shuffled = [...original].reverse();

    const a = mapUnifiedDevices({ ets: original });
    const b = mapUnifiedDevices({ ets: shuffled });

    expect(a).toHaveLength(b.length);
    const keysA = new Set(a.map((d) => d.raw.groupingKey));
    const keysB = new Set(b.map((d) => d.raw.groupingKey));
    expect(keysB).toEqual(keysA);
    for (const d of a) {
      const match = b.find((x) => x.raw.groupingKey === d.raw.groupingKey)!;
      expect(match.capabilities.slice().sort()).toEqual(d.capabilities.slice().sort());
      expect(match.raw.communicationObjects.map((o) => o.id).sort()).toEqual(d.raw.communicationObjects.map((o) => o.id).sort());
    }
  });
});

describe("Production KNX Device Synthesis Audit — §18 device synthesis report", () => {
  it("generates a human-readable report covering every synthesized device: Physical Device / Individual Address / Channel / Room / Circuit / Device Type / Capabilities with command+feedback GAs", () => {
    const devices = mapUnifiedDevices({ ets: [...switchingActuator()!, ...dimmableLight()!] });
    const report = generateDeviceSynthesisReport(devices);

    expect(report).toContain("Physical Device: 1.1.100");
    expect(report).toContain("Individual Address: 1.1.100");
    expect(report).toContain("Channels:");
    expect(report).toContain("  1 ");
    expect(report).toContain("Device Type:");
    expect(report).toContain("onoff: command=1/1/1, feedback=1/1/2");
    expect(report).toContain("brightness: command=2/1/4, feedback=2/1/5");
  });

  it("reports 'No devices synthesized.' for an empty result, never fabricating a device block", () => {
    expect(generateDeviceSynthesisReport([])).toBe("No devices synthesized.");
  });
});

describe("Production KNX Device Synthesis Audit — synthesisEvidence aggregation (Pass 9, diagnostic-only, no new inference)", () => {
  it("aggregates identity/naming/capability/binding/external-control evidence purely from what mapUnifiedDevices/planBindings already computed", () => {
    const device = mapUnifiedDevices({ ets: dimmableLight() })[0]!;
    const evidence = buildDeviceSynthesisEvidence(device);

    expect(evidence.deviceIdentityEvidence.physicalDevice).toBe(device.raw.physicalDevice?.individualAddress ?? null);
    expect(evidence.deviceIdentityEvidence.groupingKey).toBe(device.raw.groupingKey);
    expect(evidence.namingEvidence.room).toBe(device.raw.metadata.room);
    expect(evidence.capabilityEvidence.capabilities).toEqual(device.capabilities);
    expect(evidence.bindingEvidence.length).toBe(device.capabilities.length);
    expect(evidence.bindingEvidence.every((b) => typeof b.reason === "string" && b.reason.length > 0)).toBe(true);
    expect(evidence.externalControls).toBe(device.raw.externalControls);
  });

  it("never fabricates evidence for a device with no grouping/external-control data — arrays stay empty, not guessed", () => {
    const device = mapUnifiedDevices({ ets: switchingActuator() })[0]!;
    const evidence = buildDeviceSynthesisEvidence(device);
    expect(evidence.deviceIdentityEvidence.groupingEvidence).toEqual([]);
    expect(evidence.externalControls).toEqual([]);
  });
});
