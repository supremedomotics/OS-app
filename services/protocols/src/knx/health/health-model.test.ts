import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_CONFIG as C, evaluateDevice, activeCapability, type DeviceRecord, type PathObservation } from "./health-model.js";

const UP: PathObservation = { gateway: "reachable", interface: "up", bus: "ok" };
const NOW = 10_000_000;
const rec = (o: Partial<DeviceRecord> = {}): DeviceRecord => ({
  deviceId: "d", individualAddress: 0x1101, statusGroups: [0x0901], activeCheck: "allowed", lastSeenAt: null, lastSeenKind: null,
  lastResponseAt: null, lastResponseLatencyMs: null, proven: false, consecutiveFailures: 0, ring: [], lastCheck: null, ...o,
});
const ev = (r: DeviceRecord, p: PathObservation = UP, now = NOW) => { const e = evaluateDevice(r, now, p, C); return `${e.state}/${e.reason}/${e.confidence}`; };

describe("evidence rules (docs/knx/knx-device-health-design.md §3)", () => {
  it("rows 2–4: a broken path makes every device unknown — evidence is never blamed on the device", () => {
    const proven = rec({ proven: true, consecutiveFailures: 9, lastSeenAt: NOW - 3_600_000, lastSeenKind: "active_response" });
    expect(ev(proven, { gateway: "unreachable", interface: "up", bus: "ok" })).toBe("unknown/path_down/none");
    expect(ev(proven, { gateway: "reachable", interface: "down", bus: "ok" })).toBe("unknown/path_down/none");
    expect(ev(proven, { gateway: "unknown", interface: "up", bus: "ok" })).toBe("unknown/path_unknown/none");
    expect(ev(proven, { gateway: "reachable", interface: "unknown", bus: "ok" })).toBe("unknown/path_unknown/none");
    expect(ev(proven, { gateway: "reachable", interface: "up", bus: "degraded" })).toBe("unknown/bus_degraded/low");
  });
  it("row 5: offline needs proof of answering + repeated active failures + long silence — all three", () => {
    const base = { proven: true, consecutiveFailures: C.offlineAfterFailures, lastSeenAt: NOW - C.offlineMinSilenceMs, lastSeenKind: "active_response" as const };
    expect(ev(rec(base))).toBe("offline/active_checks_failed/high");
    expect(ev(rec({ ...base, proven: false }))).not.toMatch(/^offline/);                                    // never answered a read
    expect(ev(rec({ ...base, consecutiveFailures: C.offlineAfterFailures - 1 }))).not.toMatch(/^offline/);   // not enough failures
    expect(ev(rec({ ...base, lastSeenAt: NOW - C.offlineMinSilenceMs + 1 }))).not.toMatch(/^offline/);        // heard of recently
  });
  it("row 5: a device never heard from at all but proven earlier in a previous run is judged on failures and silence only", () => {
    expect(ev(rec({ proven: true, consecutiveFailures: 3, lastSeenAt: null }))).toBe("offline/active_checks_failed/high");
  });
  it("row 6: silent + never proven stays unknown — the object may not answer reads", () => {
    expect(ev(rec({ proven: false, consecutiveFailures: 50, lastSeenAt: NOW - 3_600_000, lastSeenKind: "passive_telegram" }))).toBe("unknown/unproven_silent/low");
    expect(ev(rec({ proven: false, consecutiveFailures: 50, lastSeenAt: null }))).toBe("unknown/unproven_silent/low");
  });
  it("row 6 does not apply while the device keeps talking (fresh evidence ⇒ online)", () => {
    expect(ev(rec({ proven: false, consecutiveFailures: 5, lastSeenAt: NOW - 1000, lastSeenKind: "passive_telegram" }))).toBe("online/passive_telegram/medium");
  });
  it("row 7: a proven device with failures below the offline threshold is degraded, not offline", () => {
    expect(ev(rec({ proven: true, consecutiveFailures: 1, lastSeenAt: NOW - 1000, lastSeenKind: "active_response" }))).toBe("degraded/active_checks_failed/medium");
    expect(ev(rec({ proven: true, consecutiveFailures: 3, lastSeenAt: NOW - 1000, lastSeenKind: "active_response" }))).toBe("degraded/active_checks_failed/medium"); // still recently heard
  });
  it("row 7 ignores failures of unproven devices (a single missed read of an unproven object means nothing)", () => {
    expect(ev(rec({ proven: false, consecutiveFailures: 1, lastSeenAt: NOW - 1000, lastSeenKind: "passive_telegram" }))).toBe("online/passive_telegram/medium");
  });
  it("row 8: no evidence → unknown", () => { expect(ev(rec())).toBe("unknown/no_evidence/none"); });
  it("row 9: intermittent = several failures in the ring but the latest answered", () => {
    const ring = [true, false, true, false, true, false, true];
    expect(ev(rec({ proven: true, ring, lastSeenAt: NOW - 1000, lastSeenKind: "active_response", lastResponseLatencyMs: 50 }))).toBe("degraded/intermittent/medium");
    expect(ev(rec({ proven: true, ring: [true, false, true, false], lastSeenAt: NOW - 1000, lastSeenKind: "active_response", lastResponseLatencyMs: 50 }))).toBe("online/active_response/high");
    expect(ev(rec({ proven: true, ring: [false, false, false], lastSeenAt: NOW - 1000, lastSeenKind: "active_response", lastResponseLatencyMs: 50 }))).toBe("online/active_response/high"); // latest not an answer: row 7 handles failures; ring alone is not enough
  });
  it("row 10: a slow but fresh response is degraded", () => {
    expect(ev(rec({ proven: true, lastSeenAt: NOW - 1000, lastSeenKind: "active_response", lastResponseLatencyMs: C.slowResponseMs + 1 }))).toBe("degraded/slow_response/medium");
    expect(ev(rec({ proven: true, lastSeenAt: NOW - 1000, lastSeenKind: "active_response", lastResponseLatencyMs: C.slowResponseMs }))).toBe("online/active_response/high");
  });
  it("row 11: fresh evidence ⇒ online; confidence reflects the kind of evidence", () => {
    expect(ev(rec({ lastSeenAt: NOW - C.passiveFreshnessMs, lastSeenKind: "passive_telegram" }))).toBe("online/passive_telegram/medium");
    expect(ev(rec({ lastSeenAt: NOW - C.activeFreshnessMs, lastSeenKind: "active_response", lastResponseLatencyMs: 10 }))).toBe("online/active_response/high");
  });
  it("row 12: aging evidence becomes unknown/stale — it never becomes offline by itself, however long", () => {
    expect(ev(rec({ lastSeenAt: NOW - C.passiveFreshnessMs - 1, lastSeenKind: "passive_telegram" }))).toBe("unknown/stale_evidence/low");
    expect(ev(rec({ lastSeenAt: NOW - 365 * 86_400_000, lastSeenKind: "passive_telegram" }))).toBe("unknown/stale_evidence/low");
    expect(ev(rec({ proven: true, lastSeenAt: NOW - 365 * 86_400_000, lastSeenKind: "active_response" }))).toBe("unknown/stale_evidence/low");
  });
  it("path conditions take precedence over everything below them", () => {
    const r = rec({ proven: true, consecutiveFailures: 3, lastSeenAt: NOW - C.offlineMinSilenceMs, lastSeenKind: "active_response" });
    expect(ev(r)).toBe("offline/active_checks_failed/high");
    expect(ev(r, { ...UP, bus: "degraded" })).toBe("unknown/bus_degraded/low");
  });
});

describe("active-check capability", () => {
  it("is derived, never assumed", () => {
    expect(activeCapability(rec())).toBe("candidate");
    expect(activeCapability(rec({ proven: true }))).toBe("proven");
    expect(activeCapability(rec({ statusGroups: [] }))).toBe("not_available");
    expect(activeCapability(rec({ individualAddress: null }))).toBe("not_available");
    expect(activeCapability(rec({ activeCheck: "disabled", proven: true }))).toBe("disabled");
  });
});
