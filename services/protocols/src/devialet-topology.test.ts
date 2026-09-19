import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import {
  DevialetTopologyRegistry,
  buildDevialetTopologySnapshot,
  diffDevialetTopology,
  removeDeviceFromTopology,
  isTopologyChangeEmpty,
  EMPTY_DEVIALET_TOPOLOGY,
  type DevialetFreshDeviceTopology,
} from "./devialet-topology.js";

/**
 * § D6 — pure topology reconciliation tests. No I/O, no driver, no server — matches
 * the `*-codec.ts` test convention. Driver-level integration (real `/devices/current`/
 * `/systems/current` calls feeding this) is tested separately in
 * `devialet-driver-topology.test.ts`.
 */

function device(deviceId: string, supremeDeviceId: string, systemId: string | null, groupId: string | null, role: string | null = null, systemName?: string | null): DevialetFreshDeviceTopology {
  return { deviceId, supremeDeviceId: supremeDeviceId as DeviceId, host: `${deviceId}-host`, systemId, groupId, role, systemName };
}

describe("buildDevialetTopologySnapshot", () => {
  it("A — a single solo device produces one device, one system, one group", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "Mono")]);
    expect(Object.keys(snap.devices)).toEqual(["A"]);
    expect(snap.systems.S1).toMatchObject({ systemId: "S1", groupId: "G1", memberDeviceIds: ["A"] });
    expect(snap.groups.G1).toMatchObject({ groupId: "G1", memberSystemIds: ["S1"] });
  });

  it("B — a stereo pair produces one system with two sorted members and correct roles", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("B", "dev-b", "S1", "G1", "FrontRight"),
      device("A", "dev-a", "S1", "G1", "FrontLeft"),
    ]);
    expect(snap.systems.S1!.memberDeviceIds).toEqual(["A", "B"]);
    expect(snap.devices.A!.role).toBe("FrontLeft");
    expect(snap.devices.B!.role).toBe("FrontRight");
  });

  it("C — two independent systems in one group", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("A", "dev-a", "S1", "G1"),
      device("B", "dev-b", "S2", "G1"),
    ]);
    expect(snap.groups.G1!.memberSystemIds).toEqual(["S1", "S2"]);
    expect(snap.systems.S1!.memberDeviceIds).toEqual(["A"]);
    expect(snap.systems.S2!.memberDeviceIds).toEqual(["B"]);
  });

  it("D — group split: G1(S1,S2) becomes G2(S1) + G3(S2)", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1"), device("B", "dev-b", "S2", "G1")]);
    const after = buildDevialetTopologySnapshot(before, [device("A", "dev-a", "S1", "G2"), device("B", "dev-b", "S2", "G3")]);
    expect(after.groups.G1).toBeUndefined();
    expect(after.groups.G2!.memberSystemIds).toEqual(["S1"]);
    expect(after.groups.G3!.memberSystemIds).toEqual(["S2"]);
    // physical devices are untouched by a group split.
    expect(after.devices.A!.deviceId).toBe("A");
    expect(after.devices.B!.deviceId).toBe("B");
  });

  it("E — group id change with the same physical device", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1")]);
    const after = buildDevialetTopologySnapshot(before, [device("A", "dev-a", "S1", "G2")]);
    expect(after.groups.G1).toBeUndefined();
    expect(after.groups.G2).toBeDefined();
    expect(after.devices.A!.deviceId).toBe("A");
  });

  it("F — system id change with the same physical device (and its group changes too)", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1")]);
    const after = buildDevialetTopologySnapshot(before, [device("A", "dev-a", "S2", "G2")]);
    expect(after.systems.S1).toBeUndefined();
    expect(after.systems.S2!.memberDeviceIds).toEqual(["A"]);
    expect(after.devices.A!.deviceId).toBe("A");
  });

  it("G — stereo to solo: A+B in S1 becomes A alone in S2, B remains a physical device with no system", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("A", "dev-a", "S1", "G1", "FrontLeft"),
      device("B", "dev-b", "S1", "G1", "FrontRight"),
    ]);
    // Both A and B report fresh state this round: A moved to a new solo system, B
    // reports no system at all (disbanded stereo pair, not yet reassigned).
    const after = buildDevialetTopologySnapshot(before, [
      device("A", "dev-a", "S2", "G2", "Mono"),
      device("B", "dev-b", null, null, null),
    ]);
    expect(after.systems.S1).toBeUndefined();
    expect(after.systems.S2!.memberDeviceIds).toEqual(["A"]);
    expect(after.devices.B!.systemId).toBeNull();
    expect(after.devices.B).toBeDefined(); // B still exists as a physical device
  });

  it("H — solo to stereo: A alone in S1 becomes A+B in S2", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "Mono")]);
    const after = buildDevialetTopologySnapshot(before, [
      device("A", "dev-a", "S2", "G2", "FrontLeft"),
      device("B", "dev-b", "S2", "G2", "FrontRight"),
    ]);
    expect(after.systems.S1).toBeUndefined();
    expect(after.systems.S2!.memberDeviceIds).toEqual(["A", "B"]);
  });

  it("I — device leaves a system: A+B in S1 becomes A alone in S2; B remains a physical device (query simply omits B this round)", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("A", "dev-a", "S1", "G1", "FrontLeft"),
      device("B", "dev-b", "S1", "G1", "FrontRight"),
    ]);
    // Only A answers this round (B temporarily unreachable) — B's LAST KNOWN topology
    // (still S1) is preserved, not deleted, per the merge rule.
    const after = buildDevialetTopologySnapshot(before, [device("A", "dev-a", "S2", "G2", "Mono")]);
    expect(after.devices.B).toBeDefined();
    expect(after.devices.B!.systemId).toBe("S1"); // stale but preserved, not fabricated as gone
    expect(after.systems.S1!.memberDeviceIds).toEqual(["B"]); // A moved out, B stayed
    expect(after.systems.S2!.memberDeviceIds).toEqual(["A"]);
  });

  it("J — a new physical device joins: A alone in S1 becomes A+B in S2", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "Mono")]);
    const after = buildDevialetTopologySnapshot(before, [
      device("A", "dev-a", "S2", "G2", "FrontLeft"),
      device("B", "dev-b", "S2", "G2", "FrontRight"),
    ]);
    expect(Object.keys(after.devices).sort()).toEqual(["A", "B"]);
  });

  it("K — multiple independent physical devices with no system/group at all stay independent", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", null, null), device("B", "dev-b", null, null)]);
    expect(Object.keys(snap.systems)).toEqual([]);
    expect(Object.keys(snap.groups)).toEqual([]);
    expect(Object.keys(snap.devices).sort()).toEqual(["A", "B"]);
  });

  it("M/N/O — a device whose fresh entry is simply absent this round (representing a failed device/system/group query) keeps its prior topology untouched", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "Mono")]);
    const after = buildDevialetTopologySnapshot(before, []); // nothing answered this round
    expect(after).toEqual(before);
  });

  it("P — a malformed/duplicate deviceId in the fresh input overwrites deterministically (last entry wins) rather than crashing", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("A", "dev-a-first", "S1", "G1"),
      device("A", "dev-a-second", "S2", "G2"),
    ]);
    expect(Object.keys(snap.devices)).toEqual(["A"]);
    expect(snap.devices.A!.supremeDeviceId).toBe("dev-a-second");
    expect(snap.systems.S1).toBeUndefined();
    expect(snap.systems.S2!.memberDeviceIds).toEqual(["A"]);
  });

  it("Q — repeated identical topology is idempotent (deep-equal on re-apply)", () => {
    const input = [device("A", "dev-a", "S1", "G1", "FrontLeft"), device("B", "dev-b", "S1", "G1", "FrontRight")];
    const once = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, input);
    const twice = buildDevialetTopologySnapshot(once, input);
    expect(twice).toEqual(once);
  });

  it("Q — idempotent regardless of input ordering (member lists are sorted)", () => {
    const a = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1"), device("B", "dev-b", "S1", "G1")]);
    const b = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("B", "dev-b", "S1", "G1"), device("A", "dev-a", "S1", "G1")]);
    expect(a).toEqual(b);
  });

  it("R — a leader/master field never appears — always null/absent, never guessed", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "FrontLeft"), device("B", "dev-b", "S1", "G1", "FrontRight")]);
    expect(snap.systems.S1!.leaderDeviceId).toBeNull();
    expect(snap.groups.G1!.masterSystemId).toBeNull();
  });

  it("S — a device reporting no systemId at all (the R1 doc's documented accessory shape) never contributes system/group membership", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1"), device("ARCH", "dev-arch", null, null)]);
    expect(snap.devices.ARCH!.systemId).toBeNull();
    expect(Object.values(snap.systems).some((s) => s.memberDeviceIds.includes("ARCH"))).toBe(false);
  });

  it("systemName enrichment: undefined this round falls back to the previous snapshot's known name; null overwrites to unknown", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [{ ...device("A", "dev-a", "S1", "G1"), systemName: "Living Room" }]);
    expect(before.systems.S1!.systemName).toBe("Living Room");
    const stillNamed = buildDevialetTopologySnapshot(before, [device("A", "dev-a", "S1", "G1")]); // systemName undefined this round
    expect(stillNamed.systems.S1!.systemName).toBe("Living Room");
    const nameLost = buildDevialetTopologySnapshot(before, [{ ...device("A", "dev-a", "S1", "G1"), systemName: null }]);
    expect(nameLost.systems.S1!.systemName).toBeNull();
  });
});

describe("removeDeviceFromTopology", () => {
  it("V — removes a device and any now-empty system/group it left behind", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1", "Mono")]);
    const after = removeDeviceFromTopology(snap, "A");
    expect(after.devices.A).toBeUndefined();
    expect(after.systems.S1).toBeUndefined();
    expect(after.groups.G1).toBeUndefined();
  });

  it("removes only the departing member from a shared system, leaving the other intact", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [
      device("A", "dev-a", "S1", "G1", "FrontLeft"),
      device("B", "dev-b", "S1", "G1", "FrontRight"),
    ]);
    const after = removeDeviceFromTopology(snap, "A");
    expect(after.devices.A).toBeUndefined();
    expect(after.devices.B).toBeDefined();
    expect(after.systems.S1!.memberDeviceIds).toEqual(["B"]);
  });

  it("is a safe no-op for a deviceId that isn't present", () => {
    const snap = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1")]);
    expect(removeDeviceFromTopology(snap, "never-there")).toEqual(snap);
  });
});

describe("diffDevialetTopology / isTopologyChangeEmpty", () => {
  it("reports no change for two structurally-identical snapshots", () => {
    const a = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1")]);
    const b = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1")]);
    expect(isTopologyChangeEmpty(diffDevialetTopology(a, b))).toBe(true);
  });

  it("reports added/removed/changed device, system, and group ids precisely", () => {
    const before = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S1", "G1"), device("B", "dev-b", "S1", "G1")]);
    const after = buildDevialetTopologySnapshot(EMPTY_DEVIALET_TOPOLOGY, [device("A", "dev-a", "S2", "G2"), device("C", "dev-c", "S3", "G3")]);
    const diff = diffDevialetTopology(before, after);
    expect(diff.addedDeviceIds).toEqual(["C"]);
    expect(diff.removedDeviceIds).toEqual(["B"]);
    expect(diff.changedDeviceIds).toEqual(["A"]);
    expect(diff.addedSystemIds).toEqual(["S2", "S3"]);
    expect(diff.removedSystemIds).toEqual(["S1"]);
    expect(diff.addedGroupIds).toEqual(["G2", "G3"]);
    expect(diff.removedGroupIds).toEqual(["G1"]);
  });
});

describe("DevialetTopologyRegistry (§16 — instance-owned, never module-level)", () => {
  it("T — two independent registry instances never share state", () => {
    const reg1 = new DevialetTopologyRegistry();
    const reg2 = new DevialetTopologyRegistry();
    reg1.merge([device("A", "dev-a", "S1", "G1")]);
    expect(reg1.get().devices.A).toBeDefined();
    expect(reg2.get().devices.A).toBeUndefined();
  });

  it("merge() reports changed:false on an idempotent re-apply", () => {
    const reg = new DevialetTopologyRegistry();
    const first = reg.merge([device("A", "dev-a", "S1", "G1")]);
    expect(first.changed).toBe(true);
    const second = reg.merge([device("A", "dev-a", "S1", "G1")]);
    expect(second.changed).toBe(false);
  });

  it("K/L — multiple physical devices across one registry remain correctly isolated by id", () => {
    const reg = new DevialetTopologyRegistry();
    reg.merge([device("A", "dev-a", "S1", "G1"), device("B", "dev-b", "S2", "G2")]);
    expect(reg.get().devices.A!.systemId).toBe("S1");
    expect(reg.get().devices.B!.systemId).toBe("S2");
  });

  it("U — dynamic group/system changes flow through merge() correctly over time", () => {
    const reg = new DevialetTopologyRegistry();
    reg.merge([device("A", "dev-a", "S1", "G1")]);
    const changed = reg.merge([device("A", "dev-a", "S1", "G2")]);
    expect(changed.changed).toBe(true);
    expect(changed.changes.removedGroupIds).toEqual(["G1"]);
    expect(changed.changes.addedGroupIds).toEqual(["G2"]);
  });
});
