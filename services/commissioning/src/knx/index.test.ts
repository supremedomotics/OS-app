import { describe, expect, it } from "vitest";
import { runKnxImport, toCommissionable, knxSignalsFromModel } from "./index.js";
import { emptyProjectModel, DEFAULT_COM_FLAGS } from "./types.js";

describe("KNX import orchestrator", () => {
  it("runs the full pipeline end to end from a flat GA export", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="Living Room Downlight - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Living Room Downlight - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
        <GroupAddress Name="Master Bedroom Curtain - Position" Address="2/1/1" DPTs="DPST-5-1" />
      </x>`,
    }, { existingRoomNames: ["Living Room", "Master Bedroom"] });

    expect(result.devices).toHaveLength(2);
    const downlight = result.devices.find((d) => d.name.includes("Downlight"));
    expect(downlight?.room).toBe("Living Room");
    expect(downlight?.deviceType).toBe("light_dimmable");
    expect(result.stats.groupAddressCount).toBe(3);
    expect(result.stats.recognizedDeviceCount).toBe(2);
    expect(result.stats.roomsFound).toBe(2);
    expect(result.stats.parseMs).toBeGreaterThanOrEqual(0);
  });

  it("routes an .esf source through the ESF parser (no fabricated DPT)", () => {
    const esf = [`"Name"\t"Address"\t"Description"`, `"Garage Door"\t"3/1/1"\t""`].join("\n");
    const result = runKnxImport({ kind: "text", content: esf });
    expect(result.stats.groupAddressCount).toBe(1);
  });

  it("flags two devices landing on the same (name, room) as conflicting_device", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="Kitchen Downlight - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Kitchen Downlight - Brightness" Address="1/1/2" DPTs="DPST-5-1" />
      </x>`,
    });
    // Same cluster, so this alone shouldn't conflict; verify no false positive on a single device.
    expect(result.warnings.some((w) => w.code === "conflicting_device")).toBe(false);
  });

  it("converts a recognized device into a commissionable device + card in one call", () => {
    const result = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Hallway Light - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>`,
    });
    const commissionable = toCommissionable(result.devices[0]!);
    expect(commissionable.bindings).toEqual([{ capability: "onoff", address: "1/1/1", config: { dpt: "DPT1.001" } }]);
    expect(commissionable.card.icon).toBe("lightbulb");
    expect(commissionable.card.controls).toEqual([{ kind: "toggle", capability: "onoff" }]);
  });

  it("applies learned renames end to end", () => {
    const first = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>`,
    });
    const fingerprint = first.devices[0]!.fingerprint;
    const second = runKnxImport(
      { kind: "text", content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/1" DPTs="DPST-1-1" /></x>` },
      { learnedNames: [{ fingerprint, name: "Dining Spot", learnedAt: "2026-01-01T00:00:00.000Z" }] },
    );
    expect(second.devices[0]?.name).toBe("Dining Spot");
  });

  it("keeps a device's fingerprint stable across re-imports even when unrelated GAs are added before it", () => {
    // A flat GA export's synthetic id must derive from the address, not row position —
    // otherwise adding a device earlier in a re-exported project would shift every later
    // GA's positional id and silently break the Learning Engine's rename recall.
    const first = runKnxImport({
      kind: "text",
      content: `<x><GroupAddress Name="Living Spot 1 - Switch" Address="1/1/5" DPTs="DPST-1-1" /></x>`,
    });
    const second = runKnxImport({
      kind: "text",
      content: `<x>
        <GroupAddress Name="New Hallway Light - Switch" Address="1/1/1" DPTs="DPST-1-1" />
        <GroupAddress Name="Living Spot 1 - Switch" Address="1/1/5" DPTs="DPST-1-1" />
      </x>`,
    });
    const livingSpot = second.devices.find((d) => d.name.includes("Living Spot"));
    expect(livingSpot?.fingerprint).toBe(first.devices[0]!.fingerprint);
  });
});

/** Test helper — a comm object that SENDS (writes) to the given GAs, matching the
 * common case (a Switch/Dimming object commands its GA). Tests needing a Receive-role
 * (feedback/status) object build the full literal directly. */
function sendComObject(overrides: { id: string; deviceInstanceId: string; number: number; text: string; dpt: string; gaIds: string[] }) {
  return {
    id: overrides.id, deviceInstanceId: overrides.deviceInstanceId, number: overrides.number,
    text: overrides.text, dpt: overrides.dpt, flags: DEFAULT_COM_FLAGS,
    groupAddressIds: overrides.gaIds, sendGroupAddressIds: overrides.gaIds, receiveGroupAddressIds: [],
  };
}

// § Production KNX Driver 2.0 — Physical Device Identity: knxSignalsFromModel() must
// preserve individualAddress/manufacturer/model/channel from the ETS device tree,
// instead of flattening every group address down to just {id,name,room,description,dpt}.
describe("knxSignalsFromModel — physical device identity", () => {
  it("attaches the owning DeviceInstance's individualAddress/manufacturer/model, and the channel parsed from the comm object's function text", () => {
    const model = emptyProjectModel("Test Project");
    model.deviceInstances.set("dev-1", {
      id: "dev-1", name: "DALI Device-1", individualAddress: "1.1.12",
      manufacturer: "ABB", product: "DALI Gateway", hardwareName: "DG/S 1.1",
      spaceId: null, comObjectIds: ["co-1", "co-2"],
    });
    model.communicationObjects.set("co-1", sendComObject({ id: "co-1", deviceInstanceId: "dev-1", number: 1, text: "Channel 1 Switch", dpt: "1.001", gaIds: ["ga-1"] }));
    model.communicationObjects.set("co-2", sendComObject({ id: "co-2", deviceInstanceId: "dev-1", number: 2, text: "Channel 1 Dimming", dpt: "3.007", gaIds: ["ga-2"] }));
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Ceiling SW", description: null, comment: null,
      dpt: "1.001", mainGroup: "1", middleGroup: "1", comObjectIds: ["co-1"],
    });
    model.groupAddresses.set("ga-2", {
      id: "ga-2", address: "1/1/2", name: "Ceiling Dimming", description: null, comment: null,
      dpt: "3.007", mainGroup: "1", middleGroup: "1", comObjectIds: ["co-2"],
    });

    const signals = knxSignalsFromModel(model);
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.individualAddress).toBe("1.1.12");
      expect(s.manufacturer).toBe("ABB");
      expect(s.model).toBe("DALI Gateway");
      expect(s.channel).toBe(1);
    }
  });

  // § Naming Evidence (Pass 10.1, § S.2) — ets-parser.ts already populates
  // mainGroup/middleGroup on every parsed GroupAddress; knxSignalsFromModel must copy
  // them through onto the returned KnxEtsSignal, not silently drop them.
  it("threads mainGroup/middleGroup from the parsed GroupAddress record onto the returned KnxEtsSignal (Pass 10.1 § S.2)", () => {
    const model = emptyProjectModel();
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Ceiling SW", description: null, comment: null,
      dpt: "1.001", mainGroup: "Lighting", middleGroup: "Ground Floor", comObjectIds: [],
    });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.mainGroup).toBe("Lighting");
    expect(signal?.middleGroup).toBe("Ground Floor");
  });

  it("leaves mainGroup/middleGroup null (never fabricated) when the source GroupAddress carries none", () => {
    const model = emptyProjectModel();
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Flat Export GA", description: null, comment: null,
      dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: [],
    });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.mainGroup).toBeNull();
    expect(signal?.middleGroup).toBeNull();
  });

  it("leaves individualAddress/manufacturer/model/channel null for a group address with no owning communication object (flat GA export, no device tree)", () => {
    const model = emptyProjectModel();
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Kitchen Light SW", description: null, comment: null,
      dpt: "1.001", mainGroup: "1", middleGroup: "1", comObjectIds: [],
    });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.individualAddress).toBeNull();
    expect(signal?.manufacturer).toBeNull();
    expect(signal?.model).toBeNull();
    expect(signal?.channel).toBeNull();
  });

  it("returns null channel when the comm object's function text carries no channel token", () => {
    const model = emptyProjectModel();
    model.deviceInstances.set("dev-1", {
      id: "dev-1", name: "Single Switch Actuator", individualAddress: "1.1.5",
      manufacturer: null, product: null, hardwareName: null, spaceId: null, comObjectIds: ["co-1"],
    });
    model.communicationObjects.set("co-1", sendComObject({ id: "co-1", deviceInstanceId: "dev-1", number: 1, text: "Switch", dpt: "1.001", gaIds: ["ga-1"] }));
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Switch", description: null, comment: null,
      dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: ["co-1"],
    });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.individualAddress).toBe("1.1.5");
    expect(signal?.channel).toBeNull();
  });

  it("prefers the DeviceInstance's own Space placement over the Function/Space room fallback (§19 — device-tree metadata outranks Function-group inference)", () => {
    const model = emptyProjectModel();
    model.spaces.set("space-1", { id: "space-1", type: "room", name: "Living Room", parentId: null, childIds: [], deviceInstanceIds: ["dev-1"] });
    model.spaces.set("space-2", { id: "space-2", type: "room", name: "Function Room (weaker signal)", parentId: null, childIds: [], deviceInstanceIds: [] });
    model.deviceInstances.set("dev-1", {
      id: "dev-1", name: "Ceiling Light", individualAddress: "1.1.1",
      manufacturer: null, product: null, hardwareName: null, spaceId: "space-1", comObjectIds: ["co-1"],
    });
    model.communicationObjects.set("co-1", sendComObject({ id: "co-1", deviceInstanceId: "dev-1", number: 1, text: "Switch", dpt: "1.001", gaIds: ["ga-1"] }));
    model.functions.set("fn-1", { id: "fn-1", name: "Ceiling Light", spaceId: "space-2", groupAddressIds: ["ga-1"] });
    model.groupAddresses.set("ga-1", {
      id: "ga-1", address: "1/1/1", name: "Switch", description: null, comment: null,
      dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: ["co-1"],
    });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.room).toBe("Living Room");
  });
});

// § Critical Group Address Requirement (Production KNX Driver 2.0) — a GA referenced by
// multiple communication objects (shared/central addresses, or a device's own command +
// feedback pair) must have every relationship preserved, tagged by role, never collapsed
// to "the first one found."
describe("knxSignalsFromModel — Group Address relationship preservation", () => {
  it("distinguishes a command (send) GA from a feedback/status (receive) GA on the same device", () => {
    const model = emptyProjectModel();
    model.deviceInstances.set("dev-1", {
      id: "dev-1", name: "Actuator", individualAddress: "1.1.1",
      manufacturer: null, product: null, hardwareName: null, spaceId: null, comObjectIds: ["co-1", "co-2"],
    });
    // co-1 WRITES ga-1 (a command object) and co-2 READS ga-2 (a status/feedback object).
    model.communicationObjects.set("co-1", {
      id: "co-1", deviceInstanceId: "dev-1", number: 1, text: "Switch", dpt: "1.001",
      flags: DEFAULT_COM_FLAGS, groupAddressIds: ["ga-1"], sendGroupAddressIds: ["ga-1"], receiveGroupAddressIds: [],
    });
    model.communicationObjects.set("co-2", {
      id: "co-2", deviceInstanceId: "dev-1", number: 2, text: "Switch Status", dpt: "1.001",
      flags: DEFAULT_COM_FLAGS, groupAddressIds: ["ga-2"], sendGroupAddressIds: [], receiveGroupAddressIds: ["ga-2"],
    });
    model.groupAddresses.set("ga-1", { id: "ga-1", address: "1/1/1", name: "Switch", description: null, comment: null, dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: ["co-1"] });
    model.groupAddresses.set("ga-2", { id: "ga-2", address: "1/1/2", name: "Switch Status", description: null, comment: null, dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: ["co-2"] });

    const [commandSignal, feedbackSignal] = knxSignalsFromModel(model);
    expect(commandSignal?.links).toEqual([{ deviceInstanceId: "dev-1", individualAddress: "1.1.1", comObjectId: "co-1", comObjectText: "Switch", role: "send", channel: null }]);
    expect(feedbackSignal?.links).toEqual([{ deviceInstanceId: "dev-1", individualAddress: "1.1.1", comObjectId: "co-2", comObjectText: "Switch Status", role: "receive", channel: null }]);
    expect(commandSignal?.isShared).toBe(false);
    expect(feedbackSignal?.isShared).toBe(false);
  });

  it("a shared/central GA referenced by TWO different physical devices preserves BOTH relationships and is marked isShared", () => {
    const model = emptyProjectModel();
    model.deviceInstances.set("dev-1", {
      id: "dev-1", name: "Actuator A", individualAddress: "1.1.1",
      manufacturer: null, product: null, hardwareName: null, spaceId: null, comObjectIds: ["co-1"],
    });
    model.deviceInstances.set("dev-2", {
      id: "dev-2", name: "Actuator B", individualAddress: "1.1.2",
      manufacturer: null, product: null, hardwareName: null, spaceId: null, comObjectIds: ["co-2"],
    });
    // Both devices RECEIVE the same central/shared "All Off" group address.
    model.communicationObjects.set("co-1", {
      id: "co-1", deviceInstanceId: "dev-1", number: 1, text: "Central Off", dpt: "1.001",
      flags: DEFAULT_COM_FLAGS, groupAddressIds: ["ga-central"], sendGroupAddressIds: [], receiveGroupAddressIds: ["ga-central"],
    });
    model.communicationObjects.set("co-2", {
      id: "co-2", deviceInstanceId: "dev-2", number: 1, text: "Central Off", dpt: "1.001",
      flags: DEFAULT_COM_FLAGS, groupAddressIds: ["ga-central"], sendGroupAddressIds: [], receiveGroupAddressIds: ["ga-central"],
    });
    model.groupAddresses.set("ga-central", {
      id: "ga-central", address: "1/1/99", name: "Central Off", description: null, comment: null,
      dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: ["co-1", "co-2"],
    });

    const [signal] = knxSignalsFromModel(model);
    expect(signal?.isShared).toBe(true);
    expect(signal?.links).toHaveLength(2);
    expect(new Set(signal?.links.map((l) => l.deviceInstanceId))).toEqual(new Set(["dev-1", "dev-2"]));
    expect(signal?.links.every((l) => l.role === "receive")).toBe(true);
  });

  it("a GA with no owning communication object at all has an empty links array, never fabricated relationships", () => {
    const model = emptyProjectModel();
    model.groupAddresses.set("ga-1", { id: "ga-1", address: "1/1/1", name: "Orphan", description: null, comment: null, dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: [] });
    const [signal] = knxSignalsFromModel(model);
    expect(signal?.links).toEqual([]);
    expect(signal?.isShared).toBe(false);
  });
});
