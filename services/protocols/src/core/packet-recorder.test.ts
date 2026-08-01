import { describe, expect, it } from "vitest";
import { PacketRecorder } from "./packet-recorder.js";

const base = { direction: "incoming" as const, ts: "2026-01-01T00:00:00.000Z", driver: "casambi", packetLength: 4, decoded: null, raw: "aabbccdd" };

describe("PacketRecorder", () => {
  it("assigns incrementing ids and returns them in insertion order via all()", () => {
    const recorder = new PacketRecorder();
    const a = recorder.record({ ...base, latencyMs: null });
    const b = recorder.record({ ...base, latencyMs: null });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(recorder.all().map((p) => p.id)).toEqual([1, 2]);
  });

  it("evicts the oldest packet once capacity is exceeded", () => {
    const recorder = new PacketRecorder({ capacity: 2 });
    recorder.record({ ...base, latencyMs: null });
    recorder.record({ ...base, latencyMs: null });
    recorder.record({ ...base, latencyMs: null });
    expect(recorder.all().map((p) => p.id)).toEqual([2, 3]);
  });

  it("query() filters by driver, deviceId, direction, since, and decoded-content search", () => {
    const recorder = new PacketRecorder();
    recorder.record({ ...base, driver: "casambi", deviceId: "d1", direction: "incoming", ts: "2026-01-01T00:00:00.000Z", decoded: { opcode: 0x1e }, latencyMs: null });
    recorder.record({ ...base, driver: "knx", deviceId: "d2", direction: "outgoing", ts: "2026-01-02T00:00:00.000Z", decoded: { opcode: 0x20 }, latencyMs: null });

    expect(recorder.query({ driver: "casambi" })).toHaveLength(1);
    expect(recorder.query({ deviceId: "d2" })).toHaveLength(1);
    expect(recorder.query({ direction: "outgoing" })[0].driver).toBe("knx");
    expect(recorder.query({ since: "2026-01-02T00:00:00.000Z" })).toHaveLength(1);
    expect(recorder.query({ search: "0x1e" })).toHaveLength(0); // decoded is serialized as a number, not hex text
    expect(recorder.query({ search: "opcode" })).toHaveLength(2);
  });

  it("recordWithLatency computes latency from a known request-sent timestamp", () => {
    const recorder = new PacketRecorder();
    const sentAt = Date.now() - 50;
    const packet = recorder.recordWithLatency({ ...base }, sentAt);
    expect(packet.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it("recordWithLatency is null when no request timestamp is tracked", () => {
    const recorder = new PacketRecorder();
    const packet = recorder.recordWithLatency({ ...base }, null);
    expect(packet.latencyMs).toBeNull();
  });

  it("clear() empties the buffer", () => {
    const recorder = new PacketRecorder();
    recorder.record({ ...base, latencyMs: null });
    recorder.clear();
    expect(recorder.all()).toHaveLength(0);
  });

  it("export() produces newline-delimited JSON matching query()", () => {
    const recorder = new PacketRecorder();
    recorder.record({ ...base, latencyMs: null });
    recorder.record({ ...base, latencyMs: null });
    const lines = recorder.export().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 1, driver: "casambi" });
  });
});
