import { describe, expect, it } from "vitest";
import { buildDiscoveredDevices, buildDiscoveredGroups, startLocalDiscovery, stopLocalDiscovery } from "./discovery-engine.js";
import type { CasambiUnit } from "./entity-mapper.js";
import type { CasambiGroup } from "./cloud-transport.js";
import type { CasambiPacket } from "./local-transport/index.js";

describe("buildDiscoveredDevices — the transport-independent output-shaping half", () => {
  it("produces the same discovery contract regardless of which transport populated the unit map", () => {
    const units = new Map<number, CasambiUnit>([
      [1, { id: 1, name: "Ceiling", groupId: 10, controls: [{ type: "Dimmer", value: 0.5 }] }],
    ]);
    const groups = new Map<number, CasambiGroup>([[10, { id: 10, name: "Living Room", units: [1] }]]);
    const discovered = buildDiscoveredDevices(units, groups);
    expect(discovered).toEqual([
      expect.objectContaining({ backendId: "casambi:1", suggestedName: "Ceiling", capabilities: ["brightness"] }),
    ]);
    expect(discovered[0].raw).toMatchObject({ room: "Living Room" });
  });

  it("classifies a sensor-only unit's capabilities independently of a light unit in the same map", () => {
    const units = new Map<number, CasambiUnit>([
      [1, { id: 1, controls: [{ type: "Dimmer", value: 0.5 }] }],
      [2, { id: 2, sensors: { presence: 1 } }],
    ]);
    const discovered = buildDiscoveredDevices(units, new Map());
    expect(discovered.find((d) => d.backendId === "casambi:1")?.capabilities).toEqual(["brightness"]);
    expect(discovered.find((d) => d.backendId === "casambi:2")?.capabilities).toEqual(["sensor"]);
  });
});

describe("buildDiscoveredGroups (§ Casambi Group → Supreme Room)", () => {
  const dimmer = [{ type: "Dimmer", value: 0.5 }];

  it("groups units by their own groupId and carries the Cloud group name through", () => {
    const units = new Map<number, CasambiUnit>([
      [1, { id: 1, name: "DL-1", groupId: 10, controls: dimmer }],
      [2, { id: 2, name: "DL-2", groupId: 10, controls: dimmer }],
      [3, { id: 3, name: "Pantry", groupId: 11, controls: dimmer }],
    ]);
    const groups = new Map<number, CasambiGroup>([
      [10, { id: 10, name: "R&D", units: [1, 2] }],
      [11, { id: 11, name: "Pantry", units: [3] }],
    ]);
    expect(buildDiscoveredGroups(units, groups)).toEqual([
      { groupId: 11, name: "Pantry", unitIds: [3] },
      { groupId: 10, name: "R&D", unitIds: [1, 2] }, // sorted by name
    ]);
  });

  it("reports only members this driver actually knows — never the Cloud's fuller membership list", () => {
    const units = new Map<number, CasambiUnit>([[1, { id: 1, groupId: 10, controls: dimmer }]]);
    // The Cloud says the group has three units; only unit 1 has ever been seen here.
    const groups = new Map<number, CasambiGroup>([[10, { id: 10, name: "R&D", units: [1, 2, 3] }]]);
    expect(buildDiscoveredGroups(units, groups)).toEqual([{ groupId: 10, name: "R&D", unitIds: [1] }]);
  });

  it("omits ungrouped units, unnamed groups, and groups whose id has no unit at all", () => {
    const units = new Map<number, CasambiUnit>([
      [1, { id: 1, controls: dimmer }], // ungrouped — carries no room signal
      [2, { id: 2, groupId: 10, controls: dimmer }], // its group has no name to resolve a room from
    ]);
    const groups = new Map<number, CasambiGroup>([
      [10, { id: 10, units: [2] }], // unnamed
      [11, { id: 11, name: "Nobody Here", units: [] }], // named, but no known member
    ]);
    expect(buildDiscoveredGroups(units, groups)).toEqual([]);
  });

  it("includes a control-less unit — capabilitiesFromUnit still classifies it onoff, so it IS commissionable", () => {
    const units = new Map<number, CasambiUnit>([[3, { id: 3, groupId: 11 }]]);
    const groups = new Map<number, CasambiGroup>([[11, { id: 11, name: "Switches", units: [3] }]]);
    expect(buildDiscoveredGroups(units, groups)).toEqual([{ groupId: 11, name: "Switches", unitIds: [3] }]);
  });
});

/**
 * § Architecture Validation — the DRIVING half of Local discovery (deciding when/how to start
 * learning about units) used to be three raw `udp.send(encodeXxx(...))` calls inline in
 * `casambi-driver.ts`'s `connectLocal`. These tests exercise the extracted functions directly.
 */
describe("startLocalDiscovery / stopLocalDiscovery", () => {
  function fakeUdp() {
    const sent: CasambiPacket[] = [];
    return { sent, send: async (packet: CasambiPacket) => void sent.push(packet) };
  }

  it("sends SetDefaultMask then Subscribe(0, 0, 250), in that order", async () => {
    const udp = fakeUdp();
    await startLocalDiscovery(udp, 0);
    expect(udp.sent).toEqual([
      { netId: 0, direction: "toCasambi", opcode: 0x4b, args: [3, 0, 0, 0xff, 0xff, 0xff, 0xff] },
      { netId: 0, direction: "toCasambi", opcode: 0x4b, args: [1, 0, 250] },
    ]);
  });

  it("uses the configured Net ID for both packets", async () => {
    const udp = fakeUdp();
    await startLocalDiscovery(udp, 3);
    expect(udp.sent.every((p) => p.netId === 3)).toBe(true);
  });

  it("stopLocalDiscovery sends Unsubscribe(0, 250)", async () => {
    const udp = fakeUdp();
    await stopLocalDiscovery(udp, 0);
    expect(udp.sent).toEqual([{ netId: 0, direction: "toCasambi", opcode: 0x4b, args: [0, 0, 250] }]);
  });
});
