import { describe, expect, it } from "vitest";
import { buildDiscoveredDevices, startLocalDiscovery, stopLocalDiscovery } from "./discovery-engine.js";
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
