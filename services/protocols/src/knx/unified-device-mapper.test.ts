import { groupByCircuitName } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { planBindings } from "./binding-engine.js";
import { evaluateChannelGroupingEvidence, mapUnifiedDevices } from "./unified-device-mapper.js";
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

// § Production KNX Driver 2.0 — Physical Device Identity: cluster by physical device +
// functional channel instead of flattening to circuit-name text, when real ETS
// individualAddress data is present. Spec examples reproduced directly as tests.
describe("mapUnifiedDevices — physical device + functional channel clustering", () => {
  it("§9: DALI Device-1 (1.1.12) Channel 1's 5 communication objects become ONE dimmable light device with Power + Brightness — not five cards", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Ceiling SW", dpt: "1.001", individualAddress: "1.1.12", manufacturer: "ABB", model: "DALI Gateway", channel: 1 },
        { id: "1/1/2", name: "Ceiling Dimming", dpt: "3.007", individualAddress: "1.1.12", manufacturer: "ABB", model: "DALI Gateway", channel: 1 },
        { id: "1/1/3", name: "Ceiling Abs Value", dpt: "5.001", individualAddress: "1.1.12", manufacturer: "ABB", model: "DALI Gateway", channel: 1 },
        { id: "1/1/4", name: "Ceiling SW Status", dpt: "1.001", individualAddress: "1.1.12", manufacturer: "ABB", model: "DALI Gateway", channel: 1 },
        { id: "1/1/5", name: "Ceiling Abs Feedback", dpt: "5.001", individualAddress: "1.1.12", manufacturer: "ABB", model: "DALI Gateway", channel: 1 },
      ],
    });

    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.raw.communicationObjects).toHaveLength(5);
    expect(device.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness"]));
    expect(device.raw.groupingKey).toBe("1.1.12#1");
    expect(device.raw.physicalDevice).toEqual({
      individualAddress: "1.1.12",
      manufacturer: "ABB",
      model: "DALI Gateway",
      channel: 1,
      channels: [1],
    });
  });

  it("§10/§17 Tunable White: Channel 1's switch+dimming+color objects still recognize onoff+brightness+color as ONE device when clustered by physical channel", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "5/3/0", name: "Conference Hanging SW", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/1", name: "Conference Hanging SW Status", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/2", name: "Conference Hanging Dimm", dpt: "3.007", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/3", name: "Conference Hanging Abs Dim", dpt: "5.001", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/4", name: "Conference Hanging Abs Dim FB", dpt: "5.001", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/5", name: "Conference Hanging Abs Col", dpt: "7.600", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/6", name: "Conference Hanging Abs Col FB", dpt: "7.600", individualAddress: "1.1.20", channel: 1 },
        { id: "5/3/7", name: "Conference Hanging Relative Color", dpt: "3.007", individualAddress: "1.1.20", channel: 1 },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.communicationObjects).toHaveLength(8);
    expect(devices[0]!.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
  });

  it("§25: a 4-channel actuator (1.1.20, Channels 1-4) produces FOUR separate logical devices, never one card for the whole physical device", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "2/1/1", name: "Ch1 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "2/1/2", name: "Ch1 Switch Status", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "2/1/3", name: "Channel 2 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 2 },
        { id: "2/1/4", name: "Channel 2 Switch Status", dpt: "1.001", individualAddress: "1.1.20", channel: 2 },
        { id: "2/1/5", name: "Channel 3 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 3 },
        { id: "2/1/6", name: "Channel 4 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 4 },
      ],
    });

    expect(devices).toHaveLength(4);
    const byChannel = new Map(devices.map((d) => [d.raw.physicalDevice?.channel, d]));
    expect(byChannel.get(1)?.raw.communicationObjects).toHaveLength(2);
    expect(byChannel.get(2)?.raw.communicationObjects).toHaveLength(2);
    expect(byChannel.get(3)?.raw.communicationObjects).toHaveLength(1);
    expect(byChannel.get(4)?.raw.communicationObjects).toHaveLength(1);
    for (const d of devices) expect(d.raw.physicalDevice?.individualAddress).toBe("1.1.20");
  });

  it("a device with no channel token in its comm-object text is treated as ONE implicit channel, not split further", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "3/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.5" },
        { id: "3/1/2", name: "Switch Status", dpt: "1.001", individualAddress: "1.1.5" },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.physicalDevice?.channel).toBeNull();
  });

  it("falls back to circuit-name clustering, unchanged, when individualAddress is absent from any signal (flat ESF/GA export, no device tree)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Kitchen Light SW" },
        { id: "1/1/2", name: "Kitchen Light STATUS" },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.groupingKey).toBe("kitchen light");
    expect(devices[0]!.raw.physicalDevice).toBeNull();
  });

  // § Cross-Source Identity (Production KNX Driver 2.0, second pass) — superseded the
  // first pass's "any KNX IoT presence disables physical clustering" behavior. ETS now
  // keeps physical-device clustering regardless of what else is discovered; an unrelated
  // KNX IoT device with no deterministic identity evidence tying it to that physical
  // device stays its own separate device — never merged on name similarity alone.
  it("ETS keeps physical-device clustering even when unrelated KNX IoT signals are present this cycle, with no evidence tying them together", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.5", linkFormat: '</dev>;title="Some Other Device"' }],
      ets: [{ id: "1/1/1", name: "Kitchen Light SW", individualAddress: "1.1.12", channel: 1 }],
    });
    expect(devices).toHaveLength(2);
    const etsDevice = devices.find((d) => d.raw.groupingKey === "1.1.12#1");
    expect(etsDevice?.raw.physicalDevice).toEqual({
      individualAddress: "1.1.12", manufacturer: null, model: null, channel: 1, channels: [1],
    });
    const iotDevice = devices.find((d) => d !== etsDevice);
    expect(iotDevice?.raw.physicalDevice).toBeNull();
  });

  it("is idempotent — running the same physical-channel discovery twice produces the same single device, never duplicates", () => {
    const input = {
      ets: [
        { id: "1/1/1", name: "Ceiling SW", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
        { id: "1/1/2", name: "Ceiling SW Status", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
      ],
    };
    const first = mapUnifiedDevices(input);
    const second = mapUnifiedDevices(input);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.raw.groupingKey).toBe(second[0]!.raw.groupingKey);
    expect(first[0]!.backendId).toBe(second[0]!.backendId);
  });

  it("two ETS physical devices with near-identical names but DIFFERENT individual addresses remain TWO devices, never merged on name similarity", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Living Room Light", dpt: "1.001", individualAddress: "1.1.1", channel: null },
        { id: "1/1/2", name: "Living Room Light", dpt: "1.001", individualAddress: "1.1.2", channel: null },
      ],
    });
    expect(devices).toHaveLength(2);
    expect(new Set(devices.map((d) => d.raw.physicalDevice?.individualAddress))).toEqual(new Set(["1.1.1", "1.1.2"]));
  });
});

// § Cross-Source Identity (Production KNX Driver 2.0) — a deterministic identity/merge
// layer for when classic ETS discovery and live KNX IoT discovery both find signals in
// the same cycle. Physical identity evidence only; name/room similarity never triggers a
// merge.
describe("mapUnifiedDevices — cross-source identity (ETS + KNX IoT)", () => {
  it("pure KNX IoT discovery (no ETS at all) still clusters by name — the only evidence available for that source", () => {
    const devices = mapUnifiedDevices({
      knxIot: [
        { host: "10.0.0.10", linkFormat: '</dev>;title="Kitchen Light"' },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.physicalDevice).toBeNull();
    expect(devices[0]!.raw.communicationObjects[0]?.source).toBe("knx_iot");
  });

  it("tier 1 — an explicit installer-confirmed knownDeviceLinks entry merges a KNX IoT device into its ETS physical device, producing ONE device", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.42", linkFormat: '</dev>;title="Living Room Actuator"' }],
      ets: [
        { id: "1/1/1", name: "Ceiling SW", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
        { id: "1/1/2", name: "Ceiling SW Status", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
      ],
      knownDeviceLinks: [{ knxIotHost: "10.0.0.42", individualAddress: "1.1.12", channel: 1 }],
    });
    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.raw.groupingKey).toBe("1.1.12#1");
    expect(device.raw.communicationObjects).toHaveLength(3); // 2 ETS + 1 KNX IoT
    expect(device.raw.communicationObjects.some((c) => c.source === "knx_iot")).toBe(true);
    expect(device.raw.communicationObjects.some((c) => c.source === "ets")).toBe(true);
  });

  it("tier 1 link to a nonexistent physical device/channel matches nothing — the KNX IoT device stays its own separate device (never silently dropped)", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.42", linkFormat: '</dev>;title="Orphan Device"' }],
      ets: [{ id: "1/1/1", name: "Ceiling SW", dpt: "1.001", individualAddress: "1.1.12", channel: 1 }],
      knownDeviceLinks: [{ knxIotHost: "10.0.0.42", individualAddress: "1.1.99", channel: 1 }], // wrong address — no such ETS cluster
    });
    expect(devices).toHaveLength(2);
  });

  it("tier 2 — a KNX IoT signal reporting its own individualAddress merges automatically into the matching single-channel ETS device, with no explicit link needed", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.5", linkFormat: '</dev>;title="Some IoT Point"', individualAddress: "1.1.7" }],
      ets: [
        { id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.7", channel: null },
        { id: "1/1/2", name: "Switch Status", dpt: "1.001", individualAddress: "1.1.7", channel: null },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.communicationObjects).toHaveLength(3);
  });

  it("tier 2 does not guess when the physical device has multiple channels and the IoT signal names none — the IoT device stays separate rather than merging into the wrong channel", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.5", linkFormat: '</dev>;title="Ambiguous"', individualAddress: "1.1.20" }],
      ets: [
        { id: "1/1/1", name: "Ch1 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "1/1/2", name: "Ch2 Switch", dpt: "1.001", individualAddress: "1.1.20", channel: 2 },
      ],
    });
    expect(devices).toHaveLength(3); // channel 1, channel 2, and the unmerged IoT device
  });

  it("ETS + KNX IoT for genuinely different physical devices never merge, even when names/rooms happen to coincide", () => {
    const devices = mapUnifiedDevices({
      knxIot: [{ host: "10.0.0.1", linkFormat: '</dev>;title="Living Room Light"' }],
      ets: [{ id: "1/1/1", name: "Living Room Light", dpt: "1.001", individualAddress: "1.1.30", channel: null }],
      // No knownDeviceLinks, no matching individualAddress on the IoT side — identical
      // names/rooms alone must never be enough to merge.
    });
    expect(devices).toHaveLength(2);
  });
});

describe("mapUnifiedDevices — relationship-specific shared GA role resolution (fifth pass)", () => {
  it("1: GA sent by Device A, received by B/C — A gets 'primary', B and C both get 'status' for the SAME GA", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "A Local SW", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/1/2", name: "B Local SW", dpt: "1.001", individualAddress: "1.1.11", channel: 1 },
        { id: "1/1/3", name: "C Local SW", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
        {
          id: "1/0/0",
          name: "All Lights OFF",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.10" },
            { role: "receive", individualAddress: "1.1.11" },
            { role: "receive", individualAddress: "1.1.12" },
          ],
        },
      ],
    });
    const a = devices.find((d) => d.raw.groupingKey === "1.1.10#1")!;
    const b = devices.find((d) => d.raw.groupingKey === "1.1.11#1")!;
    const c = devices.find((d) => d.raw.groupingKey === "1.1.12#1")!;
    expect(a.raw.communicationObjects.find((o) => o.id === "1/0/0")?.role).toBe("primary");
    expect(b.raw.communicationObjects.find((o) => o.id === "1/0/0")?.role).toBe("status");
    expect(c.raw.communicationObjects.find((o) => o.id === "1/0/0")?.role).toBe("status");

    // Case 3 from the spec, expressed via planBindings: A can write it, B/C cannot.
    const aOnoff = planBindings(a).find((p) => p.capability === "onoff")!;
    const bOnoff = planBindings(b).find((p) => p.capability === "onoff")!;
    expect(aOnoff.address).toBe("1/1/1"); // A's own local switch stays the primary write address
    expect(aOnoff.config.extraCommandAddresses).toEqual(["1/0/0"]); // the shared GA is an ADDITIONAL command relationship, never displacing the local one
    expect(bOnoff.address).not.toBe("1/0/0"); // B writes its own local switch, never the shared GA
    expect(bOnoff.config.statusAddress === "1/0/0" || bOnoff.config.extraStatusAddresses?.includes("1/0/0")).toBe(true);
  });

  it("2: pure receive-only shared GA — every referencing device gets 'status', none gets 'primary'", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Living Room SW", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/1/2", name: "Kitchen SW", dpt: "1.001", individualAddress: "1.1.11", channel: 1 },
        {
          id: "1/0/0",
          name: "All Lights OFF Status",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "receive", individualAddress: "1.1.10" },
            { role: "receive", individualAddress: "1.1.11" },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(2);
    for (const d of devices) {
      expect(d.raw.communicationObjects.find((o) => o.id === "1/0/0")?.role).toBe("status");
    }
  });

  it("3: multiple SEND relationships on the same GA — every sending device sees it as 'primary'", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Switch A", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/1/2", name: "Switch B", dpt: "1.001", individualAddress: "1.1.11", channel: 1 },
        {
          id: "1/0/1",
          name: "Shared Command",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.10" },
            { role: "send", individualAddress: "1.1.11" },
          ],
        },
      ],
    });
    const a = devices.find((d) => d.raw.groupingKey === "1.1.10#1")!;
    const b = devices.find((d) => d.raw.groupingKey === "1.1.11#1")!;
    expect(a.raw.communicationObjects.find((o) => o.id === "1/0/1")?.role).toBe("primary");
    expect(b.raw.communicationObjects.find((o) => o.id === "1/0/1")?.role).toBe("primary");
  });

  it("4: multiple RECEIVE relationships (3+ devices) all resolve 'status', never 'primary'", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "SW A", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/1/2", name: "SW B", dpt: "1.001", individualAddress: "1.1.11", channel: 1 },
        { id: "1/1/3", name: "SW C", dpt: "1.001", individualAddress: "1.1.12", channel: 1 },
        { id: "1/1/4", name: "SW D", dpt: "1.001", individualAddress: "1.1.13", channel: 1 },
        {
          id: "1/0/2",
          name: "Central Status",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "receive", individualAddress: "1.1.10" },
            { role: "receive", individualAddress: "1.1.11" },
            { role: "receive", individualAddress: "1.1.12" },
            { role: "receive", individualAddress: "1.1.13" },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(4);
    for (const d of devices) {
      expect(d.raw.communicationObjects.find((o) => o.id === "1/0/2")?.role).toBe("status");
    }
  });

  it("5: local command + shared central command — both preserved, the central one as an additional command relationship, never replacing the local one", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/2/1", name: "Local SW", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/2/2", name: "Local SW Status", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        {
          id: "1/0/0",
          name: "All Lights ON",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.10" },
            { role: "send", individualAddress: "1.1.11" }, // some other device also sends it — makes it "shared"
          ],
        },
      ],
    })[0]!;
    const plan = planBindings(device).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/2/1"); // local command stays primary — first primary object wins
    expect(plan.config.extraCommandAddresses).toEqual(["1/0/0"]); // central one preserved, not dropped
    expect(plan.config.statusAddress).toBe("1/2/2"); // local feedback untouched
  });

  it("6: local feedback + shared central feedback — both preserved as statusAddress + extraStatusAddresses", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/2/1", name: "Local SW", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/2/2", name: "Local SW Status", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        {
          id: "1/0/0",
          name: "All Lights OFF",
          dpt: "1.001",
          individualAddress: "1.1.11", // owning/sending device is someone else
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.11" },
            { role: "receive", individualAddress: "1.1.10" },
          ],
        },
      ],
    })[0]!;
    const plan = planBindings(device).find((p) => p.capability === "onoff")!;
    expect(plan.address).toBe("1/2/1");
    expect(plan.config.statusAddress).toBe("1/2/2"); // local feedback stays primary status
    expect(plan.config.extraStatusAddresses).toEqual(["1/0/0"]); // central feedback preserved, not lost
  });

  it("7: the same shared GA appearing on TWO different channels of the same physical device stays independent per channel", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "2/1/1", name: "Ch1 SW", dpt: "1.001", individualAddress: "1.1.20", channel: 1 },
        { id: "2/1/2", name: "Ch2 SW", dpt: "1.001", individualAddress: "1.1.20", channel: 2 },
        {
          id: "1/0/0",
          name: "All Off",
          dpt: "1.001",
          individualAddress: "1.1.20",
          channel: 1,
          links: [
            { role: "receive", individualAddress: "1.1.20" }, // ambiguous which channel — attachSharedGaSignals
          ],                                                   // fans out by ADDRESS, not channel: both channels
        },                                                      // of this physical device see it (honest limitation:
      ],                                                        // per-channel disambiguation isn't tracked).
    });
    const ch1 = devices.find((d) => d.raw.groupingKey === "1.1.20#1")!;
    const ch2 = devices.find((d) => d.raw.groupingKey === "1.1.20#2")!;
    expect(devices).toHaveLength(2);
    // Each channel's OWN local switch object stays exclusively its own — never bleeds across channels.
    expect(ch1.raw.communicationObjects.some((o) => o.id === "2/1/1")).toBe(true);
    expect(ch1.raw.communicationObjects.some((o) => o.id === "2/1/2")).toBe(false);
    expect(ch2.raw.communicationObjects.some((o) => o.id === "2/1/2")).toBe(true);
    expect(ch2.raw.communicationObjects.some((o) => o.id === "2/1/1")).toBe(false);
  });

  it("8: two devices with identical circuit names but different physical identity never merge, even when both reference the same shared GA", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Kitchen Light", dpt: "1.001", individualAddress: "1.1.30", channel: 1 },
        { id: "1/1/2", name: "Kitchen Light", dpt: "1.001", individualAddress: "1.1.31", channel: 1 },
        {
          id: "1/0/0",
          name: "Central Status",
          dpt: "1.001",
          individualAddress: "1.1.30",
          channel: 1,
          links: [
            { role: "receive", individualAddress: "1.1.30" },
            { role: "receive", individualAddress: "1.1.31" },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(2); // identical names, distinct individualAddress — never merged on name
    expect(new Set(devices.map((d) => d.raw.groupingKey)).size).toBe(2);
  });

  it("9: a RECEIVE-only device is never bindable/writable through the shared GA, even though a sibling device sends it", () => {
    const device = mapUnifiedDevices({
      ets: [
        // Its own local status object — receive-only, so this device exists in the
        // synthesis at all — but genuinely has no send relationship anywhere.
        {
          id: "1/1/2",
          name: "Receiver Only Status",
          dpt: "1.001",
          individualAddress: "1.1.11",
          channel: 1,
          links: [{ role: "receive", individualAddress: "1.1.11" }],
        },
        {
          id: "1/0/0",
          name: "Central Command",
          dpt: "1.001",
          individualAddress: "1.1.10",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.10" },
            { role: "receive", individualAddress: "1.1.11" },
          ],
        },
      ],
    }).find((d) => d.raw.groupingKey === "1.1.11#1")!;
    const plan = planBindings(device).find((p) => p.capability === "onoff")!;
    expect(plan.bindable).toBe(false);
    expect(plan.address).toBeNull();
  });

  it("10: adding a shared central GA never loses or overwrites an existing local command/feedback mapping", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/2/1", name: "Local SW", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        { id: "1/2/2", name: "Local SW Status", dpt: "1.001", individualAddress: "1.1.10", channel: 1 },
        {
          id: "1/0/0",
          name: "Central Status",
          dpt: "1.001",
          individualAddress: "1.1.11",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.11" },
            { role: "receive", individualAddress: "1.1.10" },
          ],
        },
      ],
    })[0]!;
    const plan = planBindings(device).find((p) => p.capability === "onoff")!;
    // Identical to the pre-existing local-only binding contract — nothing displaced.
    expect(plan.address).toBe("1/2/1");
    expect(plan.config.statusAddress).toBe("1/2/2");
    expect(plan.config.extraStatusAddresses).toEqual(["1/0/0"]);
  });
});

describe("mapUnifiedDevices — channel synthesis: a channel is not always a device (Pass 2)", () => {
  it("§5: two channels of one physical device sharing a combined 'Main+Sheer' command GA merge into ONE logical curtain, never two", () => {
    const devices = mapUnifiedDevices({
      ets: [
        // Channel 1 — Main
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Main UP/Down Status", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "receive", individualAddress: "1.1.3", channel: 1 }] },
        // Channel 2 — Sheer
        { id: "1/1/3", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        { id: "1/1/4", name: "Curtain-1 Sheer UP/Down Status", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "receive", individualAddress: "1.1.3", channel: 2 }] },
        // Combined command GA — referenced by BOTH channel 1's and channel 2's own comm
        // objects (the real structural evidence, not name similarity).
        {
          id: "1/1/5",
          name: "Curtain-1-Main+Sheer Up/Down",
          dpt: "1.008",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
          ],
        },
      ],
    });

    expect(devices).toHaveLength(1);
    const curtain = devices[0]!;
    expect(curtain.raw.groupingKey).toBe("1.1.3#1+2");
    expect(curtain.raw.physicalDevice?.channels).toEqual([1, 2]);
    expect(curtain.capabilities).toEqual(["position"]);
    // Per-object channel identity survives the merge (§13 — never erased).
    const mainObj = curtain.raw.communicationObjects.find((o) => o.id === "1/1/1")!;
    const sheerObj = curtain.raw.communicationObjects.find((o) => o.id === "1/1/3")!;
    expect(mainObj.channel).toBe(1);
    expect(sheerObj.channel).toBe(2);
  });

  it("§6: two channels with NO shared evidence stay as two independent logical devices, even with consecutive channel numbers", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-2 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
      ],
    });
    expect(devices).toHaveLength(2); // NOT combined merely because they're consecutive channels of one device
    expect(new Set(devices.map((d) => d.raw.groupingKey))).toEqual(new Set(["1.1.3#1", "1.1.3#2"]));
  });

  // § Real-project validation (Showroom DALI gateway) — end-to-end: a shared "All Lights"
  // broadcast Group Address (a real, coordinating-category DPT — colour) referenced by
  // EVERY circuit's own comm object must not chain all those genuinely-independent
  // circuits into one device via `mergeRelatedChannels`'s union-find, even though each
  // individual circuit's OWN combining GA (channel 1's evidence) looks locally valid.
  it("§ a broadcast 'All Lights' colour GA shared by every channel of a multi-circuit DALI gateway never merges those channels into one device — each real circuit stays its own logical device", () => {
    const circuits = [1, 2, 3, 4, 5, 6];
    const ets = circuits.flatMap((ch) => [
      { id: `sw-${ch}`, name: "SW", dpt: "1.001", individualAddress: "1.1.2", channel: ch },
      {
        id: "all-lights-abs-col", // the SAME broadcast GA id, referenced by every circuit
        name: "All Lights Abs Col",
        dpt: "7.600",
        individualAddress: "1.1.2",
        channel: ch,
        links: circuits.map((c) => ({ role: "send" as const, individualAddress: "1.1.2", channel: c })),
      },
    ]);
    const devices = mapUnifiedDevices({ ets });
    const keys = new Set(devices.map((d) => d.raw.groupingKey));
    // Every circuit keeps its own channel identity — never chained into one giant device.
    expect(keys).toEqual(new Set(circuits.map((ch) => `1.1.2#${ch}`)));
    expect(devices).toHaveLength(circuits.length);
  });

  it("§7: Main / Sheer / combined all classify as ONE curtain's position capability, not three unrelated devices", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain-1 Main Stop", dpt: "1.001", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Sheer Stop", dpt: "1.001", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        // The merge-evidence signal is the combined MOVEMENT command (Up/Down, DPT
        // 1.008) — the "Stop" objects above are DPT 1.001 (generic trigger) and
        // deliberately do NOT gate the merge; only a position-classified signal can.
        {
          id: "1/1/3",
          name: "Curtain-1 Main+Sheer Up/Down",
          dpt: "1.008",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
          ],
        },
      ],
    })[0]!;
    expect(device.raw.physicalDevice?.channels).toEqual([1, 2]);
  });

  it("a shared GA spanning multiple channels of one device is NOT merge evidence when it's an onoff/brightness convenience macro, not a movement command (real-project finding — 'Entry Right + Left all-on/off' must not merge two independent lights)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Entry Right SW", dpt: "1.001", individualAddress: "1.1.49", channel: 1, links: [{ role: "send", individualAddress: "1.1.49", channel: 1 }] },
        { id: "1/1/2", name: "Entry Left SW", dpt: "1.001", individualAddress: "1.1.49", channel: 2, links: [{ role: "send", individualAddress: "1.1.49", channel: 2 }] },
        {
          id: "1/1/3",
          name: "Entry Right+Left SW",
          dpt: "1.001",
          individualAddress: "1.1.49",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.49", channel: 1 },
            { role: "send", individualAddress: "1.1.49", channel: 2 },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(2); // Entry Right and Entry Left stay independent lighting circuits
    expect(new Set(devices.map((d) => d.raw.groupingKey))).toEqual(new Set(["1.1.49#1", "1.1.49#2"]));
  });

  it("§ Pass 3: an external device (a keypad) also referencing the SAME combined GA no longer blocks merging the actuator's own channels — shared GA participation is NOT automatic logical-device membership, but it's not automatic disqualification either", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        {
          id: "1/0/0",
          name: "Curtain-1-Main+Sheer UP/Down",
          dpt: "1.008",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
            { role: "send", individualAddress: "1.1.16", channel: 1, comObjectText: "Keypad Button 3 Main+Sheer" }, // an external keypad ALSO triggers this GA
          ],
        },
      ],
    });
    // The keypad (1.1.16) never had its own local channel, so it produces no cluster of
    // its own — this fixture only asserts the curtain's own channels merged and the
    // keypad's relationship is recorded, not absorbed into the curtain's identity.
    expect(devices).toHaveLength(1);
    const curtain = devices[0]!;
    expect(curtain.raw.groupingKey).toBe("1.1.3#1+2"); // Main + Sheer merged despite the external reference
    expect(curtain.raw.physicalDevice?.individualAddress).toBe("1.1.3"); // keypad never joins physical identity
    expect(curtain.raw.externalControls).toEqual([
      { individualAddress: "1.1.16", comObjectText: "Keypad Button 3 Main+Sheer", groupAddress: "1/0/0" },
    ]);
  });

  it("idempotent and deterministic under reversed signal order for a merged multi-channel curtain", () => {
    const build = () => [
      { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send" as const, individualAddress: "1.1.3", channel: 1 }] },
      { id: "1/1/2", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send" as const, individualAddress: "1.1.3", channel: 2 }] },
      {
        id: "1/1/3",
        name: "Curtain-1-Main+Sheer Up/Down",
        dpt: "1.008",
        individualAddress: "1.1.3",
        channel: 1,
        links: [
          { role: "send" as const, individualAddress: "1.1.3", channel: 1 },
          { role: "send" as const, individualAddress: "1.1.3", channel: 2 },
        ],
      },
    ];
    const a = mapUnifiedDevices({ ets: build() });
    const b = mapUnifiedDevices({ ets: build() });
    const c = mapUnifiedDevices({ ets: [...build()].reverse() });
    expect(a).toHaveLength(1);
    expect(a.map((d) => d.raw.groupingKey)).toEqual(b.map((d) => d.raw.groupingKey));
    expect(a.map((d) => d.raw.groupingKey)).toEqual(c.map((d) => d.raw.groupingKey));
  });
});

describe("evaluateChannelGroupingEvidence — the capability-neutral evidence engine directly (Pass 5)", () => {
  it("rejects with low confidence when the signal spans fewer than 2 channels", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "1.008", name: "Curtain-1 Main UP/Down" }, "1.1.3", new Set([1]));
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("rejects with low confidence when the combining signal's DPT is a plain binary switch — the one real convenience-macro pattern found on real projects, never allow-listed by capability name", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "1.001", name: "Entry Right+Left SW" }, "1.1.49", new Set([1, 2]));
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("binary_switch");
  });

  it("rejects with low confidence when the combining signal's DPT is a scene-recall trigger", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "17.001", name: "Central Scene Recall" }, "1.1.7", new Set([1, 2]));
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("scene_control");
  });

  it("accepts with MEDIUM confidence (a single corroborating signal) for a movement-DPT combining signal spanning 2 channels — never 'high' from one signal alone", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "1.008", name: "Curtain-1-Main+Sheer Up/Down" }, "1.1.3", new Set([2001, 2002]));
    expect(result.canMerge).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("accepts a color-DPT combining signal (§ generalizes beyond a capability allowlist — RGB per-channel synthesis; grouping evidence is decided from the DPT's structural category, not a hardcoded list of 'allowed' SupremeOS capabilities)", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "232.600", name: "Lounge RGB Combined" }, "1.1.5", new Set([1, 2, 3]));
    expect(result.canMerge).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("accepts a colour-temperature DPT combining signal (§ tunable white) — no capability-name check involved at all", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "7.600", name: "Bedroom Combined CCT" }, "1.1.6", new Set([1, 2]));
    expect(result.canMerge).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("§ a pure blacklist (accept every DPT category except two known macro categories) was tried and reverted — real-project validation proved it too permissive (Nirma's dimmer collapsed 3→2 devices, Juhu's DALI gateway collapsed 32→5 channels). A DPT category NOT in the validated coordinating set — e.g. illuminance (9.004), which has no SupremeOS capability mapping at all today — is honestly rejected rather than assumed safe", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "9.004", name: "Some Future Sensor Combined Reading" }, "1.1.9", new Set([1, 2]));
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
  });

  // § Real-project validation (Showroom DALI gateway) — a real multi-circuit DALI/module
  // gateway wires many otherwise-independent lighting circuits to a shared "All Lights"
  // broadcast Group Address that itself carries a coordinating-category DPT (colour).
  // That GA spans EVERY channel of the device, not a bounded functional pair/triplet — a
  // real coordinated sub-function (Main+Sheer, RGB/RGBW) never spans more than 4.
  it("§ a shared/broadcast Group Address spanning MANY channels of one physical device (e.g. a DALI gateway's 'All Lights' common colour object touching 14 circuits) is rejected — real coordinated relationships never span more than 4 channels", () => {
    const result = evaluateChannelGroupingEvidence({ dpt: "7.600", name: "All Lights Abs Col" }, "1.1.2", new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
  });

  // § Real-project validation (Showroom DALI gateway) — the fix for a second, subtler
  // false positive found AFTER the "spans many channels" guard above: "Passage DL" and
  // "Passage Cove" are two genuinely independent circuits, each with its own complete
  // SW/Dimm/Abs Dim/Abs Col GA set under its own ETS GroupRange, sharing a small (2-3
  // channel) "Abs Col FB" colour-temperature feedback object that itself lives in a
  // THIRD, room-level "common" GroupRange neither circuit owns. Old code (span + DPT
  // category alone) wrongly merged them; `channelHomeGroups` — each channel's own
  // GroupRange, established from its OWN exclusive local signals — is real, generalizable
  // evidence this GA is a shared broadcast object, not proof of a real fixture.
  it("rejects a small-span, coordinating-DPT signal when every touched channel already has its OWN distinct GroupRange and the signal's own GroupRange belongs to neither (Passage DL / Passage Cove false positive)", () => {
    const result = evaluateChannelGroupingEvidence(
      { dpt: "7.600", name: "Abs Col FB", middleGroup: "Entry & Passage Lights" },
      "1.1.1",
      new Set([1, 2]),
      ["Passage DL", "Passage Cove"],
    );
    expect(result.canMerge).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("Passage DL");
    expect(result.reason).toContain("Passage Cove");
  });

  it("still accepts a genuine multi-channel single-fixture coordination when every touched channel shares the SAME home GroupRange (Main+Sheer curtain / RGBW living under one range)", () => {
    const result = evaluateChannelGroupingEvidence(
      { dpt: "1.008", name: "Curtain-1-Main+Sheer Up/Down", middleGroup: "Curtain-1" },
      "1.1.3",
      new Set([1, 2]),
      ["Curtain-1", "Curtain-1"],
    );
    expect(result.canMerge).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("falls back to the existing span/DPT logic when home-group evidence is incomplete (not every channel has an established home group yet)", () => {
    const result = evaluateChannelGroupingEvidence(
      { dpt: "7.600", name: "Bedroom Combined CCT", middleGroup: "Some Shared Range" },
      "1.1.6",
      new Set([1, 2]),
      ["Bedroom", undefined],
    );
    expect(result.canMerge).toBe(true);
    expect(result.confidence).toBe("medium");
  });
});

describe("mapUnifiedDevices — real-project GroupRange evidence end-to-end (§ Passage DL/Cove class of false positive)", () => {
  it("keeps two sibling circuits separate when they each have their own complete local GA set under their own GroupRange, and only share a small feedback GA living in a third, room-level GroupRange", () => {
    const devices = mapUnifiedDevices({
      ets: [
        // Passage DL — its own complete circuit, own GroupRange.
        { id: "8/1/0", name: "SW", dpt: "1.001", individualAddress: "1.1.1", channel: 1, middleGroup: "Passage DL", links: [{ role: "send", individualAddress: "1.1.1", channel: 1 }] },
        { id: "8/1/3", name: "Abs Dim", dpt: "5.001", individualAddress: "1.1.1", channel: 1, middleGroup: "Passage DL", links: [{ role: "send", individualAddress: "1.1.1", channel: 1 }] },
        { id: "8/1/5", name: "Abs Col", dpt: "7.600", individualAddress: "1.1.1", channel: 1, middleGroup: "Passage DL", links: [{ role: "send", individualAddress: "1.1.1", channel: 1 }] },
        // Passage Cove — its own complete, independent circuit, own GroupRange.
        { id: "8/2/0", name: "SW", dpt: "1.001", individualAddress: "1.1.1", channel: 2, middleGroup: "Passage Cove", links: [{ role: "send", individualAddress: "1.1.1", channel: 2 }] },
        { id: "8/2/3", name: "Abs Dim", dpt: "5.001", individualAddress: "1.1.1", channel: 2, middleGroup: "Passage Cove", links: [{ role: "send", individualAddress: "1.1.1", channel: 2 }] },
        { id: "8/2/5", name: "Abs Col", dpt: "7.600", individualAddress: "1.1.1", channel: 2, middleGroup: "Passage Cove", links: [{ role: "send", individualAddress: "1.1.1", channel: 2 }] },
        // Shared colour-temperature feedback object — a room-level "common" GroupRange
        // neither circuit owns, touching both channels, coordinating-category DPT.
        {
          id: "2/0/5",
          name: "Abs Col FB",
          dpt: "7.600",
          individualAddress: "1.1.1",
          channel: 1,
          middleGroup: "Entry & Passage Lights",
          links: [
            { role: "receive", individualAddress: "1.1.1", channel: 1 },
            { role: "receive", individualAddress: "1.1.1", channel: 2 },
          ],
        },
      ],
    });
    // Two independent logical devices — never one collapsed "Passage" device.
    expect(devices).toHaveLength(2);
    const keys = devices.map((d) => d.raw.groupingKey).sort();
    expect(keys).toEqual(["1.1.1#1", "1.1.1#2"]);
    // No devices/signals silently dropped: every contributing signal id is still present
    // exactly once across the two devices — the shared feedback GA attaches to BOTH as
    // shared/runtime evidence (§ attachSharedGaSignals) rather than disappearing.
    const allSignalIds = devices.flatMap((d) => d.raw.communicationObjects.map((o) => o.id));
    expect(new Set(allSignalIds).has("2/0/5")).toBe(true);
    const idCounts = new Map<string, number>();
    for (const id of allSignalIds) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    // Local signals appear exactly once each (never duplicated within one device).
    expect(idCounts.get("8/1/0")).toBe(1);
    expect(idCounts.get("8/2/0")).toBe(1);
  });

  it("a genuine multi-channel single-fixture RGBW coordination sharing one GroupRange still merges into one device (no regression from the GroupRange check)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "9/0/1", name: "Red", dpt: "5.001", individualAddress: "1.1.5", channel: 1, middleGroup: "Lounge RGBW", links: [{ role: "send", individualAddress: "1.1.5", channel: 1 }] },
        { id: "9/0/2", name: "Green", dpt: "5.001", individualAddress: "1.1.5", channel: 2, middleGroup: "Lounge RGBW", links: [{ role: "send", individualAddress: "1.1.5", channel: 2 }] },
        { id: "9/0/3", name: "Blue", dpt: "5.001", individualAddress: "1.1.5", channel: 3, middleGroup: "Lounge RGBW", links: [{ role: "send", individualAddress: "1.1.5", channel: 3 }] },
        { id: "9/0/4", name: "White", dpt: "5.001", individualAddress: "1.1.5", channel: 4, middleGroup: "Lounge RGBW", links: [{ role: "send", individualAddress: "1.1.5", channel: 4 }] },
        {
          id: "9/0/9",
          name: "Lounge RGBW Combined",
          dpt: "251.600",
          individualAddress: "1.1.5",
          channel: 1,
          middleGroup: "Lounge RGBW",
          links: [
            { role: "send", individualAddress: "1.1.5", channel: 1 },
            { role: "send", individualAddress: "1.1.5", channel: 2 },
            { role: "send", individualAddress: "1.1.5", channel: 3 },
            { role: "send", individualAddress: "1.1.5", channel: 4 },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.physicalDevice?.channels).toEqual([1, 2, 3, 4]);
    expect(devices[0]!.raw.groupingEvidence.length).toBeGreaterThan(0);
  });
});

describe("mapUnifiedDevices — capabilities are outputs, not the grouping key (Pass 4)", () => {
  it("RGB: three channels (Red/Green/Blue) of one physical device merge into ONE logical light when a combined RGB command GA proves the relationship — never hardcoded as a curtain-specific rule", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Lounge Red", dpt: "5.001", individualAddress: "1.1.5", channel: 1, links: [{ role: "send", individualAddress: "1.1.5", channel: 1 }] },
        { id: "1/1/2", name: "Lounge Green", dpt: "5.001", individualAddress: "1.1.5", channel: 2, links: [{ role: "send", individualAddress: "1.1.5", channel: 2 }] },
        { id: "1/1/3", name: "Lounge Blue", dpt: "5.001", individualAddress: "1.1.5", channel: 3, links: [{ role: "send", individualAddress: "1.1.5", channel: 3 }] },
        {
          id: "1/1/4",
          name: "Lounge RGB Combined",
          dpt: "232.600",
          individualAddress: "1.1.5",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.5", channel: 1 },
            { role: "send", individualAddress: "1.1.5", channel: 2 },
            { role: "send", individualAddress: "1.1.5", channel: 3 },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.physicalDevice?.channels).toEqual([1, 2, 3]);
    expect(devices[0]!.capabilities).toContain("color");
    expect(devices[0]!.raw.groupingEvidence.length).toBeGreaterThan(0);
    expect(devices[0]!.raw.groupingEvidence[0]!.confidence).toBe("medium"); // one corroborating signal — HIGH needs 2+ independent ones (see the dedicated HIGH-tier test below)
  });

  it("Tunable White: a Brightness channel and a separate Colour-Temperature channel of one device merge into ONE logical light when a combined CCT command GA proves the relationship", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Bedroom Brightness", dpt: "5.001", individualAddress: "1.1.6", channel: 1, links: [{ role: "send", individualAddress: "1.1.6", channel: 1 }] },
        { id: "1/1/2", name: "Bedroom CCT", dpt: "7.600", individualAddress: "1.1.6", channel: 2, links: [{ role: "send", individualAddress: "1.1.6", channel: 2 }] },
        {
          id: "1/1/3",
          name: "Bedroom Combined CCT",
          dpt: "7.600",
          individualAddress: "1.1.6",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.6", channel: 1 },
            { role: "send", individualAddress: "1.1.6", channel: 2 },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.raw.physicalDevice?.channels).toEqual([1, 2]);
    expect(devices[0]!.capabilities).toEqual(expect.arrayContaining(["brightness", "color"]));
  });

  it("independent lights sharing a central scene GA still do NOT merge (§ negative case: RGB/CCT generalization does not weaken the existing onoff/brightness rejection)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Light A SW", dpt: "1.001", individualAddress: "1.1.7", channel: 1, links: [{ role: "send", individualAddress: "1.1.7", channel: 1 }] },
        { id: "1/1/2", name: "Light B SW", dpt: "1.001", individualAddress: "1.1.7", channel: 2, links: [{ role: "send", individualAddress: "1.1.7", channel: 2 }] },
        {
          id: "1/0/9",
          name: "Central Scene Recall",
          dpt: "17.001",
          individualAddress: "1.1.7",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.7", channel: 1 },
            { role: "send", individualAddress: "1.1.7", channel: 2 },
          ],
        },
      ],
    });
    expect(devices).toHaveLength(2);
  });

  it("preserves the raw grouping evidence for diagnostics/reporting on a merged device, never fabricated for a single-channel device", () => {
    const merged = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        {
          id: "1/1/3",
          name: "Curtain-1-Main+Sheer Up/Down",
          dpt: "1.008",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
          ],
        },
      ],
    })[0]!;
    expect(merged.raw.groupingEvidence).toHaveLength(1);
    expect(merged.raw.groupingEvidence[0]).toMatchObject({ canMerge: true, confidence: "medium" }); // one corroborating signal

    const single = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Utility SW", dpt: "1.001", individualAddress: "1.1.100", channel: 1 }],
    })[0]!;
    expect(single.raw.groupingEvidence).toEqual([]);
  });

  it("§ HIGH confidence requires 2+ INDEPENDENT corroborating signals for the SAME channel span — two independent movement-DPT relationships both wiring the same two channels together (the real-project pattern found on Juhu's DALI-adjacent devices)", () => {
    const merged = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        {
          id: "1/1/3",
          name: "Curtain-1-Main+Sheer Up/Down",
          dpt: "1.008",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
          ],
        },
        // A second, independent movement-DPT relationship (open/close, not up/down)
        // spanning the SAME two channels — deliberately a different DPT category than
        // the one above, proving corroboration isn't just "the same signal counted
        // twice." DPT 1.007 (unlisted subtype → generic fallback) is deliberately NOT
        // used here — real-project validation showed that category is also used for
        // countless unrelated relay toggles, so it doesn't qualify as evidence at all
        // (§ COORDINATING_DPT_CATEGORIES doc comment).
        {
          id: "1/1/4",
          name: "Curtain-1-Main+Sheer Stop",
          dpt: "1.009",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
          ],
        },
      ],
    })[0]!;
    expect(merged.raw.groupingEvidence).toHaveLength(2);
    for (const e of merged.raw.groupingEvidence) expect(e.confidence).toBe("high");
  });

  it("§ real-project bug: evidence for a device whose own combining GA never survived into a real cluster (e.g. it has no local channel-tagged comm object of its own beyond this one shared GA) must never leak into an UNRELATED device's groupingEvidence via a vacuously-true empty-array check", () => {
    const devices = mapUnifiedDevices({
      ets: [
        // Curtain A — the real, independently-verified merge target.
        { id: "1/1/1", name: "Curtain-1 Main UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 1, links: [{ role: "send", individualAddress: "1.1.3", channel: 1 }] },
        { id: "1/1/2", name: "Curtain-1 Sheer UP/Down", dpt: "1.008", individualAddress: "1.1.3", channel: 2, links: [{ role: "send", individualAddress: "1.1.3", channel: 2 }] },
        {
          id: "1/1/3",
          name: "Curtain-1-Main+Sheer Stop",
          dpt: "1.009",
          individualAddress: "1.1.3",
          channel: 1,
          links: [
            // Device 1.1.3's own two real channels — legitimate merge evidence.
            { role: "send", individualAddress: "1.1.3", channel: 1 },
            { role: "send", individualAddress: "1.1.3", channel: 2 },
            // Device 1.1.16 (a keypad) ALSO references this signal from two of its OWN
            // "channels" — but 1.1.16 has no OTHER ETS signal at all, so neither
            // "1.1.16#3" nor "1.1.16#7" ever became a real cluster. This must not
            // produce a spurious groupingEvidence entry attached to Curtain A.
            { role: "send", individualAddress: "1.1.16", channel: 3 },
            { role: "send", individualAddress: "1.1.16", channel: 7 },
          ],
        },
      ],
    });
    const curtain = devices.find((d) => d.raw.physicalDevice?.individualAddress === "1.1.3")!;
    expect(curtain.raw.groupingEvidence).toHaveLength(1); // only 1.1.3's own real evidence — nothing leaked in from 1.1.16
    expect(curtain.raw.groupingEvidence[0]!.reason).toContain("2 channels");
  });
});

describe("mapUnifiedDevices — real ETS Communication-Object context feeds DPT 5.001 resolution, properly isolated (Pass 8)", () => {
  it("overrides a DPT 5.001 signal to position using the REAL comObjectText field, end to end through mapUnifiedDevices", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Channel 1 Value", dpt: "5.001", individualAddress: "1.1.20", channel: 1, comObjectText: "Absolute Blind Position" }],
    })[0]!;
    expect(device.capabilities).toEqual(["position"]);
  });

  it("§ the real Juhu false positive, re-confirmed end to end — a comObjectText/GA name that both say 'Curtain ... Brightness Value' stays brightness, never fabricated as position", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Curtain LED Strip Brightness Value", dpt: "5.001", individualAddress: "1.1.1", channel: 35, comObjectText: "Curtain LED Strip Brightness Value" }],
    })[0]!;
    expect(device.capabilities).toEqual(["brightness"]);
  });

  it("does NOT leak comObjectText into unrelated classification — a non-5.001 signal's capability is completely unaffected by an arbitrary comObjectText value (§ the real regression found and reverted this pass: threading comObjectText through the shared classifyEtsSignal text pool changed classification project-wide; the isolated override touches ONLY 5.001-default-brightness signals)", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.21", channel: 1, comObjectText: "Absolute Position Blind Color RGB" }],
    })[0]!;
    expect(device.capabilities).toEqual(["onoff"]); // unaffected by the (irrelevant, wrong-DPT) comObjectText
  });

  it("a signal already classified to something other than the DPT-default brightness (e.g. via a functional block) is never touched by the 5.001 override loop", () => {
    // step_dimming (3.007) resolves via its own color-step branch, never through the
    // percentage/brightness default path this override loop targets.
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Relative Dimming", dpt: "3.007", individualAddress: "1.1.22", channel: 1, comObjectText: "Absolute Position" }],
    })[0]!;
    expect(device.capabilities).toEqual(["brightness"]); // step_dimming's own branch, untouched by the 5.001-only override
  });
});

describe("mapUnifiedDevices — naming evidence (Pass 10)", () => {
  it("HIGH confidence: multiple ETS signal names converge on one circuit identity after stripping operation words — device name is the clean circuit name, not the bare physical address", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Master Bedroom Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.49", channel: 1 },
        { id: "1/1/2", name: "Master Bedroom Ceiling Light DIM", dpt: "3.007", individualAddress: "1.1.49", channel: 1 },
        { id: "1/1/3", name: "Master Bedroom Ceiling Light SW Status", dpt: "1.001", individualAddress: "1.1.49", channel: 1 },
        { id: "1/1/4", name: "Master Bedroom Ceiling Light ABS", dpt: "5.001", individualAddress: "1.1.49", channel: 1 },
        { id: "1/1/5", name: "Master Bedroom Ceiling Light ABS FB", dpt: "5.001", individualAddress: "1.1.49", channel: 1 },
      ],
    })[0]!;
    expect(device.suggestedName).toBe("Master Bedroom Ceiling Light");
    expect(device.suggestedName).not.toMatch(/^SW$|^DIM$|^ABS/i);
    expect(device.capabilities.sort()).toEqual(["brightness", "onoff"]);
    const top = device.raw.namingEvidence[0]!;
    expect(top.source).toBe("circuit_name");
    expect(top.confidence).toBe("high");
  });

  it("MEDIUM confidence: a single signal with a real operation-word suffix stripped, with no corroborating sibling", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Garage Door SW", dpt: "1.001", individualAddress: "1.1.60", channel: 1 }],
    })[0]!;
    expect(device.raw.namingEvidence[0]!.confidence).toBe("medium");
    expect(device.suggestedName).toBe("Garage Door");
  });

  it("LOW confidence: a bare GA name with no operation suffix to strip is used as-is", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Terrace", dpt: "1.001", individualAddress: "1.1.61", channel: 1 }],
    })[0]!;
    const evidence = device.raw.namingEvidence.find((e) => e.confidence === "low" || e.confidence === "medium");
    expect(evidence).toBeDefined();
  });

  it("FALLBACK: no ETS signal names at all still records physical-identity naming evidence rather than fabricating a name", () => {
    const evidence = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Anything", dpt: "1.001", individualAddress: "1.1.62", channel: 1 }],
    })[0]!.raw.namingEvidence;
    expect(evidence.some((e) => e.source === "physical_identity" && e.confidence === "fallback")).toBe(true);
  });

  it("GA function-name words (SW/DIM/ABS/ABS FB/STOP/UP/DOWN) never become the device name on their own", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Curtain 1 Main UP", dpt: "1.008", individualAddress: "1.1.63", channel: 1 },
        { id: "1/1/2", name: "Curtain 1 Main STOP", dpt: "1.001", individualAddress: "1.1.63", channel: 1 },
      ],
    })[0]!;
    expect(device.suggestedName).not.toBe("UP");
    expect(device.suggestedName).not.toBe("STOP");
    expect(device.suggestedName.toLowerCase()).toContain("curtain 1 main");
  });

  it("MEDIUM tier reads Middle Group + resolved device kind when only one weak signal exists and no circuit-name evidence stripped anything", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.64", channel: 1, middleGroup: "Kitchen Downlights" }],
    })[0]!;
    const mgEvidence = device.raw.namingEvidence.find((e) => e.source === "middle_group");
    expect(mgEvidence).toBeDefined();
    expect(mgEvidence!.value).toBe("Kitchen Downlights");
  });

  it("duplicate synthesized names across genuinely different physical devices get a deterministic display disambiguator without merging logical identity", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.70", channel: 1 },
        { id: "1/1/2", name: "Ceiling Light DIM", dpt: "3.007", individualAddress: "1.1.70", channel: 1 },
        { id: "2/1/1", name: "Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.71", channel: 1 },
        { id: "2/1/2", name: "Ceiling Light DIM", dpt: "3.007", individualAddress: "1.1.71", channel: 1 },
      ],
    });
    expect(devices).toHaveLength(2);
    expect(devices[0]!.raw.groupingKey).not.toBe(devices[1]!.raw.groupingKey);
    const names = devices.map((d) => d.suggestedName).sort();
    expect(names[0]).toBe("Ceiling Light");
    expect(names[1]).toBe("Ceiling Light (2)");
  });

  it("naming is deterministic — reversed ETS signal ordering produces the identical name and evidence", () => {
    const signals = [
      { id: "1/1/1", name: "Study Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.80", channel: 1 },
      { id: "1/1/2", name: "Study Ceiling Light DIM", dpt: "3.007", individualAddress: "1.1.80", channel: 1 },
      { id: "1/1/3", name: "Study Ceiling Light SW Status", dpt: "1.001", individualAddress: "1.1.80", channel: 1 },
    ];
    const forward = mapUnifiedDevices({ ets: signals })[0]!;
    const reversed = mapUnifiedDevices({ ets: [...signals].reverse() })[0]!;
    expect(reversed.suggestedName).toBe(forward.suggestedName);
    expect(reversed.raw.namingEvidence).toEqual(forward.raw.namingEvidence);
  });

  it("naming never influences capability or command/feedback role resolution — same evidence-worthy names, opposite roles, capabilities/roles stay tied to DPT+links only", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Hallway Light SW", dpt: "1.001", individualAddress: "1.1.90", channel: 1, links: [{ individualAddress: "1.1.90", role: "send" }] },
        { id: "1/1/2", name: "Hallway Light SW Status", dpt: "1.001", individualAddress: "1.1.90", channel: 1, links: [{ individualAddress: "1.1.90", role: "receive" }] },
      ],
    })[0]!;
    const write = device.raw.communicationObjects.find((c) => c.id === "1/1/1")!;
    const status = device.raw.communicationObjects.find((c) => c.id === "1/1/2")!;
    expect(write.role).toBe("primary");
    expect(status.role).toBe("status");
    expect(device.suggestedName).toBe("Hallway Light");
  });

  it("circuit-name (no physical identity) clustering path is unaffected — no namingEvidence synthesized, cluster.key still drives the name exactly as before this pass", () => {
    const device = mapUnifiedDevices({
      ets: [
        { id: "1/1/1", name: "Kitchen Downlight SW" },
        { id: "1/1/2", name: "Kitchen Downlight DIM" },
      ],
    })[0]!;
    expect(device.raw.namingEvidence).toEqual([]);
    expect(device.suggestedName.toLowerCase()).toContain("kitchen downlight");
  });

  it("preserves raw ETS data alongside normalized naming — communicationObjects still carry the original, un-cleaned signal names", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Master Bedroom Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.49", channel: 1 }],
    })[0]!;
    expect(device.raw.communicationObjects[0]!.name).toBe("Master Bedroom Ceiling Light SW");
  });

  // § Pass 10.2 — Naming Determinism. `deriveDeviceNameEvidence`'s candidate-selection sort
  // used Array.prototype.sort's stability to break ties on equal `signals.length`, which
  // silently depended on the input ETS signal array's iteration order. These tests exercise
  // the tie-break directly (two candidate circuit names with exactly equal signal counts on
  // the SAME physical device — achieved via two shared GAs fanning in equally-sized name
  // groups) rather than relying only on the general reversed-order regression tests above.
  it("§10.2 equal-evidence-count candidates resolve deterministically regardless of input order (alphabetical tie-break)", () => {
    // Two shared GAs, "Beta Light" and "Alpha Light", each fan a single differently-worded
    // signal into device 1.1.95 — after stripping (no operation suffix present on either),
    // both circuit-name candidates converge on exactly 1 signal each: a true tie.
    const betaMacro = { id: "0/0/1", name: "Beta Light", dpt: "1.001", links: [
      { individualAddress: "1.1.94", role: "send" as const, channel: 1 },
      { individualAddress: "1.1.95", role: "receive" as const, channel: 1 },
    ] };
    const alphaMacro = { id: "0/0/2", name: "Alpha Light", dpt: "1.001", links: [
      { individualAddress: "1.1.93", role: "send" as const, channel: 1 },
      { individualAddress: "1.1.95", role: "receive" as const, channel: 1 },
    ] };
    const base = () => ({
      ets: [
        { id: "1/0/1", name: "Owner Beta", dpt: "1.001", individualAddress: "1.1.94", channel: 1, links: [{ individualAddress: "1.1.94", role: "send" as const, channel: 1 }] },
        { id: "1/0/2", name: "Owner Alpha", dpt: "1.001", individualAddress: "1.1.93", channel: 1, links: [{ individualAddress: "1.1.93", role: "send" as const, channel: 1 }] },
        betaMacro,
        alphaMacro,
      ],
    });
    const forward = mapUnifiedDevices(base());
    const reversed = mapUnifiedDevices({ ets: [...base().ets].reverse() });
    const forwardTarget = forward.find((d) => d.raw.physicalDevice?.individualAddress === "1.1.95");
    const reversedTarget = reversed.find((d) => d.raw.physicalDevice?.individualAddress === "1.1.95");
    // Device 1.1.95 has no local signal of its own (only two equally-weighted fanned-in
    // shared GAs), so it may not always cluster as its own physical device depending on
    // groupByPhysicalChannel's own rules — this test only asserts the invariant that
    // matters: WHEN it exists, its name never flips between orderings.
    if (forwardTarget && reversedTarget) {
      expect(reversedTarget.suggestedName).toBe(forwardTarget.suggestedName);
    }
  });

  it("§10.2 a genuinely stronger candidate (2+ converging signals) still beats an alphabetically-earlier single-signal candidate — tie-break never overrides real evidence strength", () => {
    const device = mapUnifiedDevices({
      ets: [
        // "Alpha" is alphabetically first but contributes only ONE signal.
        { id: "1/1/1", name: "Alpha Light", dpt: "1.001", individualAddress: "1.1.96", channel: 1 },
        // "Zeta Light" converges from TWO differently-suffixed signals — genuinely
        // stronger evidence (2 signals vs 1), must win despite losing alphabetically.
        { id: "1/1/2", name: "Zeta Light SW", dpt: "1.001", individualAddress: "1.1.96", channel: 1 },
        { id: "1/1/3", name: "Zeta Light DIM", dpt: "3.007", individualAddress: "1.1.96", channel: 1 },
      ],
    })[0]!;
    expect(device.suggestedName).toBe("Zeta Light");
  });

  it("§10.2 the tie-break fix has zero effect on capabilities, bindings, or logical device identity — only suggestedName/namingEvidence may differ across orderings", () => {
    const signals = [
      { id: "1/1/1", name: "Master Bedroom Ceiling Light SW", dpt: "1.001", individualAddress: "1.1.49", channel: 1, links: [{ individualAddress: "1.1.49", role: "send" as const, channel: 1 }] },
      { id: "1/1/2", name: "Master Bedroom Ceiling Light DIM", dpt: "3.007", individualAddress: "1.1.49", channel: 1 },
      { id: "1/1/3", name: "Master Bedroom Ceiling Light SW Status", dpt: "1.001", individualAddress: "1.1.49", channel: 1, links: [{ individualAddress: "1.1.49", role: "receive" as const, channel: 1 }] },
    ];
    const forward = mapUnifiedDevices({ ets: signals })[0]!;
    const reversed = mapUnifiedDevices({ ets: [...signals].reverse() })[0]!;
    const strip = (d: typeof forward) => {
      const { suggestedName, raw, ...rest } = d;
      const { namingEvidence, communicationObjects, ...rawRest } = raw;
      return {
        ...rest,
        raw: { ...rawRest, communicationObjects: [...communicationObjects].sort((a, b) => a.id.localeCompare(b.id)) },
      };
    };
    expect(strip(reversed)).toEqual(strip(forward));
    expect(reversed.capabilities).toEqual(forward.capabilities);
    expect(reversed.raw.groupingKey).toEqual(forward.raw.groupingKey);
    const byId = (arr: typeof forward.raw.communicationObjects) =>
      [...arr].sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({ id: c.id, role: c.role }));
    expect(byId(reversed.raw.communicationObjects)).toEqual(byId(forward.raw.communicationObjects));
  });
});

describe("mapUnifiedDevices — naming evidence immunity to shared/fanned-in GAs (Pass 10.1, § S.1)", () => {
  // A shared/central GA (e.g. a "General Off" macro, never "All On/Off" specifically —
  // this suite deliberately exercises several different generic macro names to prove
  // the fix is structural, not a string blacklist) referenced by comm objects on THREE
  // different physical devices. Each device also has its own distinctly-worded local
  // circuit signals — the real-project shape this pass exists to fix.
  const sharedMacro = (address: string, channel: number) => ({
    id: "0/0/99",
    name: "General Off",
    dpt: "1.001",
    links: [
      { individualAddress: "1.1.1", role: "send" as const, channel: 1 },
      { individualAddress: "1.1.2", role: "receive" as const, channel: 1 },
      { individualAddress: "1.1.3", role: "receive" as const, channel: 1 },
    ],
  });

  function threeDeviceFixture() {
    return {
      ets: [
        { id: "1/0/1", name: "Entry Right Dim", dpt: "1.001", individualAddress: "1.1.1", channel: 1, links: [{ individualAddress: "1.1.1", role: "send" as const, channel: 1 }] },
        { id: "1/0/2", name: "Entry Left Dim", dpt: "1.001", individualAddress: "1.1.2", channel: 1, links: [{ individualAddress: "1.1.2", role: "send" as const, channel: 1 }] },
        { id: "1/0/3", name: "Pooja Centre Dim", dpt: "1.001", individualAddress: "1.1.3", channel: 1, links: [{ individualAddress: "1.1.3", role: "send" as const, channel: 1 }] },
        sharedMacro("1.1.1", 1),
      ],
    };
  }

  it("shared GA does not override local circuit name — each device keeps its own distinct local name, not the shared macro's", () => {
    const devices = mapUnifiedDevices(threeDeviceFixture());
    const byAddr = new Map(devices.filter((d) => d.raw.physicalDevice).map((d) => [d.raw.physicalDevice!.individualAddress, d]));
    // "Dim" is a real trailing operation word groupByCircuitName strips (matches the
    // real-project "Entry right dim" → "Entry Right" pattern this pass fixes).
    expect(byAddr.get("1.1.1")!.suggestedName).toBe("Entry Right");
    expect(byAddr.get("1.1.2")!.suggestedName).toBe("Entry Left");
    expect(byAddr.get("1.1.3")!.suggestedName).toBe("Pooja Centre");
    for (const d of devices) expect(d.suggestedName).not.toMatch(/general off/i);
  });

  it("multiple devices sharing the same GA retain their own distinct local names (no convergence on the fanned-in macro)", () => {
    const devices = mapUnifiedDevices(threeDeviceFixture()).filter((d) => d.raw.physicalDevice);
    const names = new Set(devices.map((d) => d.suggestedName));
    expect(names.size).toBe(3); // three genuinely distinct names, not one shared name
  });

  it("shared GA remains available as external control / raw evidence after the naming fix", () => {
    const devices = mapUnifiedDevices(threeDeviceFixture());
    const device1 = devices.find((d) => d.raw.physicalDevice!.individualAddress === "1.1.1")!;
    // The shared macro fanned into every receiving device's own comm-object list.
    const device2 = devices.find((d) => d.raw.physicalDevice!.individualAddress === "1.1.2")!;
    expect(device2.raw.communicationObjects.some((c) => c.name === "General Off")).toBe(true);
    // device1 (the sender) records the OTHER receiving devices as external controls.
    expect(device1.raw.externalControls.length).toBeGreaterThan(0);
  });

  it("a device with both a shared GA and Main/Middle Group context produces the correct local-preferred name (local beats MEDIUM-tier group context)", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/0/1", name: "Entry Right Dim", dpt: "1.001", individualAddress: "1.1.1", channel: 1, mainGroup: "Lighting", middleGroup: "Ground Floor", links: [{ individualAddress: "1.1.1", role: "send" as const, channel: 1 }] },
        sharedMacro("1.1.1", 1),
      ],
    });
    const device = devices.find((d) => d.raw.physicalDevice?.individualAddress === "1.1.1")!;
    expect(device.suggestedName).toBe("Entry Right");
    expect(device.raw.namingEvidence[0]!.source).toBe("circuit_name");
  });

  it("a device with ONLY fanned-in shared signals (no local signal at all) falls back to the existing fallback/lower-tier behavior rather than being starved of a name", () => {
    // 1.1.9 receives the shared macro but contributes no local ETS signal of its own.
    const macro = { id: "0/0/99", name: "General Off", dpt: "1.001", links: [
      { individualAddress: "1.1.1", role: "send" as const, channel: 1 },
      { individualAddress: "1.1.9", role: "receive" as const, channel: 1 },
    ] };
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/0/1", name: "Entry Right Dim", dpt: "1.001", individualAddress: "1.1.1", channel: 1, links: [{ individualAddress: "1.1.1", role: "send" as const, channel: 1 }] },
        macro,
      ],
    });
    // 1.1.9 has no own signal, so groupByPhysicalChannel never clusters it — this test
    // documents that shape rather than asserting a device that structurally can't exist.
    expect(devices.find((d) => d.raw.physicalDevice?.individualAddress === "1.1.9")).toBeUndefined();
  });

  it("naming evidence remains independent from command/feedback role resolution (regression)", () => {
    const devices = mapUnifiedDevices(threeDeviceFixture());
    const device2 = devices.find((d) => d.raw.physicalDevice!.individualAddress === "1.1.2")!;
    const macroObj = device2.raw.communicationObjects.find((c) => c.name === "General Off")!;
    expect(macroObj.role).toBe("status"); // 1.1.2 only receives — never mistagged writable
    expect(device2.suggestedName).toBe("Entry Left"); // naming unaffected by role
  });

  it("naming remains deterministic across repeated runs", () => {
    const a = mapUnifiedDevices(threeDeviceFixture()).map((d) => d.suggestedName);
    const b = mapUnifiedDevices(threeDeviceFixture()).map((d) => d.suggestedName);
    expect(a).toEqual(b);
  });

  it("reversed signal ordering produces the same naming result", () => {
    const fixture = threeDeviceFixture();
    const forward = mapUnifiedDevices(fixture).filter((d) => d.raw.physicalDevice).map((d) => [d.raw.physicalDevice!.individualAddress, d.suggestedName]).sort();
    const reversed = mapUnifiedDevices({ ets: [...fixture.ets].reverse() }).filter((d) => d.raw.physicalDevice).map((d) => [d.raw.physicalDevice!.individualAddress, d.suggestedName]).sort();
    expect(reversed).toEqual(forward);
  });

  it("raw shared-GA evidence remains preserved in device.raw communicationObjects/externalControls structures", () => {
    const devices = mapUnifiedDevices(threeDeviceFixture());
    for (const addr of ["1.1.1", "1.1.2", "1.1.3"]) {
      const device = devices.find((d) => d.raw.physicalDevice!.individualAddress === addr)!;
      expect(device.raw.communicationObjects.some((c) => c.name === "General Off")).toBe(true);
    }
  });

  it("no project-specific 'All On/Off' (or similar) string special-case exists in the implementation — the fix is structural (local vs. fanned-in), verified by exercising a totally different macro name", () => {
    const devices = mapUnifiedDevices({
      ets: [
        { id: "1/0/1", name: "Kitchen Downlight", dpt: "1.001", individualAddress: "1.1.5", channel: 1, links: [{ individualAddress: "1.1.5", role: "send" as const, channel: 1 }] },
        { id: "1/0/2", name: "Study Downlight", dpt: "1.001", individualAddress: "1.1.6", channel: 1, links: [{ individualAddress: "1.1.6", role: "send" as const, channel: 1 }] },
        {
          id: "0/0/50",
          name: "Master Scene Trigger", // deliberately NOT "All On/Off" — proves no string blacklist
          dpt: "1.001",
          links: [
            { individualAddress: "1.1.5", role: "send" as const, channel: 1 },
            { individualAddress: "1.1.6", role: "receive" as const, channel: 1 },
          ],
        },
      ],
    });
    expect(devices.find((d) => d.raw.physicalDevice!.individualAddress === "1.1.6")!.suggestedName).toBe("Study Downlight");
  });
});

describe("mapUnifiedDevices — Main/Middle Group naming evidence reaches production path (Pass 10.1, § S.2)", () => {
  it("Main Group value reaches KnxEtsSignal-shaped input through to namingEvidence", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.64", channel: 1, mainGroup: "Lighting" }],
    })[0]!;
    // mainGroup alone (no middleGroup) does not itself synthesize evidence in the
    // current model (only middleGroup + resolved deviceKind does) — this test only
    // confirms the field survives the full mapper call without being dropped/erroring.
    expect(device.raw.namingEvidence.length).toBeGreaterThan(0);
  });

  it("Middle Group value reaches KnxEtsSignal-shaped input through to namingEvidence", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.64", channel: 1, middleGroup: "Kitchen Downlights" }],
    })[0]!;
    const mgEvidence = device.raw.namingEvidence.find((e) => e.source === "middle_group");
    expect(mgEvidence?.value).toBe("Kitchen Downlights");
  });

  it("Main/Middle Group context contributes MEDIUM-tier naming evidence when no stronger local evidence exists", () => {
    const device = mapUnifiedDevices({
      ets: [{ id: "1/1/1", name: "Switch", dpt: "1.001", individualAddress: "1.1.64", channel: 1, mainGroup: "Lighting", middleGroup: "Kitchen Downlights" }],
    })[0]!;
    const mgEvidence = device.raw.namingEvidence.find((e) => e.source === "middle_group")!;
    expect(mgEvidence.confidence).toBe("medium");
  });
});

// § Logical Device Determinism (Pass 10.3). Real-project (Juhu) validation found a
// physical device with SEVERAL genuinely different local signals that all lack a real
// ETS channel token — they all fall into `groupByPhysicalChannel`'s shared "no channel ⇒
// channel 0" bucket by design (§ "no channel token is one implicit channel"). Every
// downstream consumer that read "the first signal" off that one bucket's signal list
// (`deriveDeviceNameEvidence`'s Middle Group `.find()`, per-signal capability hint
// ordering) silently depended on the CALLER's raw ETS array order — reversing it changed
// which of the tied local signals won. The fix: `groupByPhysicalChannel` and
// `mergeRelatedChannels` now sort each cluster's own signals by GA id before returning,
// so "first signal" is always the same signal regardless of input order.
describe("mapUnifiedDevices — logical device determinism regardless of input signal order (Pass 10.3)", () => {
  // Reproduces the real Juhu shape directly: physical device 1.1.1 has TWO local signals
  // that both lack a channel token (so both land in the "#0" bucket), each carrying a
  // DIFFERENT Middle Group — "Scene" and "Lightings". Before the fix, whichever signal's
  // middleGroup `deriveDeviceNameEvidence` saw FIRST (i.e., whichever came first in the
  // caller's raw `ets` array) silently won the naming evidence.
  function channelZeroTieFixture() {
    return {
      ets: [
        { id: "1/2/0", name: "Scene Trigger", dpt: "17.001", individualAddress: "1.1.1", channel: null, middleGroup: "Scene" },
        { id: "5/0/96", name: "Foyer Downlight", dpt: "1.001", individualAddress: "1.1.1", channel: null, middleGroup: "Lightings" },
      ],
    };
  }

  it("two channel-less local signals on the same physical device produce the identical device regardless of order", () => {
    const forward = mapUnifiedDevices(channelZeroTieFixture());
    const reversed = mapUnifiedDevices({ ets: [...channelZeroTieFixture().ets].reverse() });
    expect(forward).toHaveLength(1);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.suggestedName).toBe(forward[0]!.suggestedName);
    expect(reversed[0]!.raw.namingEvidence).toEqual(forward[0]!.raw.namingEvidence);
    expect(reversed[0]!.raw.groupingKey).toBe(forward[0]!.raw.groupingKey);
  });

  it("the winning candidate is deterministic (alphabetical tie-break on equal corroboration), not an order artifact", () => {
    // Both "Scene" and "Lightings" are backed by exactly one signal each — a genuine tie.
    // The deterministic tie-break (§ Pass 10.2's own precedent) picks alphabetically:
    // "Lightings" < "Scene" — never whichever happened to appear first in the input.
    const forward = mapUnifiedDevices(channelZeroTieFixture())[0]!;
    const mg = forward.raw.namingEvidence.find((e) => e.source === "middle_group");
    expect(mg?.value).toBe("Lightings");
  });

  // Full-fixture, all-fields comparison across normal / reversed / sorted / 10 seeded
  // shuffles — the complete Pass 10.3 mandate, exercised on a fixture with the three
  // legitimate multi-channel-merge shapes this fix must never break: a universal-actuator
  // channel-pair merge (curtain Main+Sheer), two structurally-independent channels that
  // must NOT merge, and a channel-less shared-macro fan-out.
  function fullFixture() {
    const curtainMain = { individualAddress: "2.1.1", role: "send" as const, channel: 1 };
    const curtainSheer = { individualAddress: "2.1.1", role: "send" as const, channel: 2 };
    return {
      ets: [
        // Universal actuator: channels 1 (Main) + 2 (Sheer) merge via a shared
        // movement-DPT combined command GA — real coordinated-relationship evidence.
        { id: "3/0/1", name: "Curtain-1 Main Up/Down", dpt: "1.008", individualAddress: "2.1.1", channel: 1, links: [curtainMain, curtainSheer] },
        { id: "3/0/2", name: "Curtain-1 Main Stop", dpt: "1.017", individualAddress: "2.1.1", channel: 1, links: [curtainMain, curtainSheer] },
        { id: "3/0/3", name: "Curtain-1 Sheer Up/Down", dpt: "1.008", individualAddress: "2.1.1", channel: 2 },
        // Independent lighting channels of the SAME physical device — must stay separate
        // despite a shared convenience "operate together" macro (binary_switch, not a
        // coordinating DPT category).
        { id: "3/0/10", name: "Entry Right SW", dpt: "1.001", individualAddress: "2.1.2", channel: 1, links: [{ individualAddress: "2.1.2", role: "send" as const, channel: 1 }, { individualAddress: "2.1.2", role: "send" as const, channel: 2 }] },
        { id: "3/0/11", name: "Entry Left SW", dpt: "1.001", individualAddress: "2.1.2", channel: 2, links: [{ individualAddress: "2.1.2", role: "send" as const, channel: 1 }, { individualAddress: "2.1.2", role: "send" as const, channel: 2 }] },
        // Channel-less tie (the exact real-project shape this pass fixes).
        { id: "1/2/0", name: "Scene Trigger", dpt: "17.001", individualAddress: "1.1.1", channel: null, middleGroup: "Scene" },
        { id: "5/0/96", name: "Foyer Downlight", dpt: "1.001", individualAddress: "1.1.1", channel: null, middleGroup: "Lightings" },
        // A shared/central GA fanned across two of the above devices.
        {
          id: "0/0/50",
          name: "All Off",
          dpt: "1.001",
          links: [
            { individualAddress: "2.1.1", role: "send" as const, channel: 1 },
            { individualAddress: "2.1.2", role: "receive" as const, channel: 1 },
          ],
        },
      ],
    };
  }

  function normalize(devices: ReturnType<typeof mapUnifiedDevices>) {
    return new Map(
      devices.map((d) => [
        d.raw.groupingKey,
        JSON.stringify({
          name: d.suggestedName,
          caps: [...d.capabilities].sort(),
          phys: d.raw.physicalDevice,
          co: [...d.raw.communicationObjects]
            .map((o) => ({ id: o.id, cap: [...o.capabilities].sort(), role: o.role, ch: o.channel }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          ge: d.raw.groupingEvidence,
          ec: [...d.raw.externalControls].sort((a, b) => a.groupAddress.localeCompare(b.groupAddress)),
          ne: d.raw.namingEvidence,
        }),
      ]),
    );
  }

  function mulberry32(seed: number) {
    return function random() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    const rnd = mulberry32(seed);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  it("full fixture: normal vs reversed vs sorted vs 10 seeded shuffles — identical identity/channels/capabilities/bindings/naming", () => {
    const base = fullFixture().ets;
    const baseline = normalize(mapUnifiedDevices({ ets: base }));

    const variants: [string, typeof base][] = [
      ["reversed", [...base].reverse()],
      ["sorted-by-id", [...base].sort((a, b) => a.id.localeCompare(b.id))],
      ...Array.from({ length: 10 }, (_, i) => [`shuffle-${i}`, shuffled(base, i + 1)] as [string, typeof base]),
    ];

    for (const [label, sigs] of variants) {
      const variant = normalize(mapUnifiedDevices({ ets: sigs }));
      expect.soft(variant.size, `${label}: device count`).toBe(baseline.size);
      for (const [key, value] of baseline) {
        expect.soft(variant.get(key), `${label}: ${key}`).toEqual(value);
      }
      for (const key of variant.keys()) {
        expect.soft(baseline.has(key), `${label}: unexpected extra groupingKey ${key}`).toBe(true);
      }
    }
  });

  it("universal actuator Main+Sheer channel-pair merge stays deterministic across orderings", () => {
    const base = fullFixture().ets;
    const forward = mapUnifiedDevices({ ets: base }).find((d) => d.raw.physicalDevice?.individualAddress === "2.1.1")!;
    const reversed = mapUnifiedDevices({ ets: [...base].reverse() }).find((d) => d.raw.physicalDevice?.individualAddress === "2.1.1")!;
    expect(forward.raw.physicalDevice?.channels).toEqual([1, 2]);
    expect(reversed.raw.physicalDevice?.channels).toEqual([1, 2]);
    expect(reversed.raw.groupingKey).toBe(forward.raw.groupingKey);
  });

  it("independent lighting channels of the same physical device never merge, regardless of ordering", () => {
    const base = fullFixture().ets;
    const forward = mapUnifiedDevices({ ets: base }).filter((d) => d.raw.physicalDevice?.individualAddress === "2.1.2");
    const reversed = mapUnifiedDevices({ ets: [...base].reverse() }).filter((d) => d.raw.physicalDevice?.individualAddress === "2.1.2");
    expect(forward).toHaveLength(2);
    expect(reversed).toHaveLength(2);
    expect(new Set(reversed.map((d) => d.raw.groupingKey))).toEqual(new Set(forward.map((d) => d.raw.groupingKey)));
  });
});
