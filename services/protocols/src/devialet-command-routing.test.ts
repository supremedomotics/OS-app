import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import {
  devialetCommandLevelFor,
  resolveDevialetCommandTarget,
  DevialetCommandRoutingError,
  DevialetOperationUnavailableError,
} from "./devialet-command-routing.js";
import type { DevialetDeviceTopology } from "./devialet-topology.js";

/**
 * § D7 — pure command-routing tests. No I/O, no driver, no server. Integration with
 * the real R1 client/driver (single-request guarantees, availableOperations gating,
 * error propagation) lives in `devialet-driver-command-routing.test.ts`.
 */

function topology(overrides: Partial<DevialetDeviceTopology> = {}): DevialetDeviceTopology {
  return { deviceId: "A", supremeDeviceId: "dev-a" as DeviceId, host: "a-host", systemId: "S1", groupId: "G1", role: "Mono", ...overrides };
}

describe("devialetCommandLevelFor", () => {
  it("classifies volume as system-level", () => {
    expect(devialetCommandLevelFor("volume")).toBe("system");
  });

  it("classifies playback/mute/source actions as group-level", () => {
    for (const action of ["play", "pause", "stop", "next", "previous", "mute", "unmute", "source"]) {
      expect(devialetCommandLevelFor(action)).toBe("group");
    }
  });

  it("classifies seek/shuffle/repeat/advanced/unknown as unsupported (no documented R1 mapping)", () => {
    for (const action of ["seek", "shuffle", "repeat", "advanced", "something-made-up"]) {
      expect(devialetCommandLevelFor(action)).toBe("unsupported");
    }
  });
});

describe("resolveDevialetCommandTarget", () => {
  it("A — a device with known system+group resolves a system-level command to its systemId", () => {
    const result = resolveDevialetCommandTarget("system", "A", topology());
    expect(result).toEqual({ ok: true, level: "system", targetId: "S1", devialetId: "A" });
  });

  it("B — a device with known system+group resolves a group-level command to its groupId", () => {
    const result = resolveDevialetCommandTarget("group", "A", topology());
    expect(result).toEqual({ ok: true, level: "group", targetId: "G1", devialetId: "A" });
  });

  it("I — a device whose identity was never established fails with identity-unknown", () => {
    const result = resolveDevialetCommandTarget("system", null, null);
    expect(result).toEqual({ ok: false, level: "system", reason: "identity-unknown" });
  });

  it("J — a device with known identity but unknown groupId fails group-level resolution while system-level would still succeed", () => {
    const partial = topology({ groupId: null });
    expect(resolveDevialetCommandTarget("group", "A", partial)).toEqual({ ok: false, level: "group", reason: "topology-unavailable" });
    expect(resolveDevialetCommandTarget("system", "A", partial)).toEqual({ ok: true, level: "system", targetId: "S1", devialetId: "A" });
  });

  it("K — device unbound: no topology entry at all (identity known, topology null) fails cleanly, never fabricating a target", () => {
    const result = resolveDevialetCommandTarget("system", "A", null);
    expect(result).toEqual({ ok: false, level: "system", reason: "topology-unavailable" });
  });

  it("never falls back to deviceId as systemId/groupId", () => {
    const noTopology = topology({ systemId: null, groupId: null });
    expect(resolveDevialetCommandTarget("system", "A", noTopology).ok).toBe(false);
    expect(resolveDevialetCommandTarget("group", "A", noTopology).ok).toBe(false);
  });

  it("never consults leaderDeviceId/masterSystemId (not part of DevialetDeviceTopology at all — routing depends only on systemId/groupId)", () => {
    // DevialetDeviceTopology intentionally has no leader/master field; this test
    // documents that resolution is a pure function of systemId/groupId only.
    const result = resolveDevialetCommandTarget("system", "A", topology({ systemId: "S1" }));
    expect(result).toEqual({ ok: true, level: "system", targetId: "S1", devialetId: "A" });
  });
});

describe("DevialetCommandRoutingError", () => {
  it("carries level/reason/deviceId and a descriptive message", () => {
    const err = new DevialetCommandRoutingError("group", "topology-unavailable", "dev-a" as DeviceId);
    expect(err).toBeInstanceOf(Error);
    expect(err.level).toBe("group");
    expect(err.reason).toBe("topology-unavailable");
    expect(err.deviceId).toBe("dev-a");
    expect(err.message).toContain("group");
  });
});

describe("DevialetOperationUnavailableError", () => {
  it("carries action/deviceId", () => {
    const err = new DevialetOperationUnavailableError("next", "dev-a" as DeviceId);
    expect(err).toBeInstanceOf(Error);
    expect(err.action).toBe("next");
    expect(err.deviceId).toBe("dev-a");
  });
});
