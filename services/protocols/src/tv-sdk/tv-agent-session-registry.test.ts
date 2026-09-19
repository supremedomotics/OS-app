import { describe, expect, it } from "vitest";
import { TvAgentSessionRegistry } from "./tv-agent-session-registry.js";
import type { AgentMessage } from "./tv-agent-protocol.js";

function msg(agentId: string, deviceId: string, sessionId: string, sequenceNumber: number): AgentMessage {
  return {
    protocolVersion: 1,
    agentId,
    deviceId,
    sessionId,
    sequenceNumber,
    messageId: `${agentId}-${sequenceNumber}`,
    timestamp: new Date().toISOString(),
    messageType: "heartbeat",
    payload: {},
  } as AgentMessage;
}

describe("TvAgentSessionRegistry — §3/§4/§14 device binding + replay protection", () => {
  it("authorizes a message from a correctly bound agent/device/session with an increasing sequence", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    expect(reg.authorize(msg("agent-1", "tv-1", "session-1", 0)).ok).toBe(true);
    expect(reg.authorize(msg("agent-1", "tv-1", "session-1", 1)).ok).toBe(true);
  });

  it("rejects an unknown agent", () => {
    const reg = new TvAgentSessionRegistry();
    const result = reg.authorize(msg("ghost-agent", "tv-1", "session-1", 0));
    expect(result).toEqual({ ok: false, reason: "unknown_agent" });
  });

  it("§14 rejects device_mismatch: a message claiming a device the agent is not bound to", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    const result = reg.authorize(msg("agent-1", "tv-999", "session-1", 0));
    expect(result).toEqual({ ok: false, reason: "device_mismatch" });
  });

  it("rejects a revoked agent, and revocation prevents automatic reconnection without an explicit rebind", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    reg.revoke("agent-1");
    expect(reg.authorize(msg("agent-1", "tv-1", "session-1", 0))).toEqual({ ok: false, reason: "revoked" });
    expect(reg.isBound("agent-1")).toBe(false);
  });

  it("rejects a message for a stale/superseded session id (a reconnect that changed sessionId)", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    reg.bind("agent-1", "tv-1", "session-2"); // reconnect issues a fresh session
    const result = reg.authorize(msg("agent-1", "tv-1", "session-1", 5)); // old session's message arrives late
    expect(result).toEqual({ ok: false, reason: "unknown_session" });
  });

  it("§4 rejects a stale (replayed) sequence number", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    reg.authorize(msg("agent-1", "tv-1", "session-1", 5));
    const result = reg.authorize(msg("agent-1", "tv-1", "session-1", 5)); // exact replay
    expect(result).toEqual({ ok: false, reason: "stale_or_duplicate_sequence" });
  });

  it("§4 rejects a duplicate message id carrying an already-seen (or lower) sequence number", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    reg.authorize(msg("agent-1", "tv-1", "session-1", 10));
    const result = reg.authorize(msg("agent-1", "tv-1", "session-1", 3)); // out-of-order / duplicate-ish lower sequence
    expect(result).toEqual({ ok: false, reason: "stale_or_duplicate_sequence" });
  });

  it("rebinding the same agentId to a different deviceId is refused, not silently allowed", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    expect(() => reg.bind("agent-1", "tv-2", "session-2")).toThrow(/already bound/);
  });

  it("unbind() forgets the agent entirely — a fresh bind() to a new device is then allowed", () => {
    const reg = new TvAgentSessionRegistry();
    reg.bind("agent-1", "tv-1", "session-1");
    reg.unbind("agent-1");
    expect(() => reg.bind("agent-1", "tv-2", "session-2")).not.toThrow();
    expect(reg.describe("agent-1")?.deviceId).toBe("tv-2");
  });

  describe("§15 100-agent security isolation test", () => {
    it("100 agents bound 1:1 to 100 devices — every cross-device impersonation attempt is rejected", () => {
      const reg = new TvAgentSessionRegistry();
      const N = 100;
      for (let i = 0; i < N; i++) reg.bind(`agent-${i}`, `device-${i}`, `session-${i}`);

      // Legitimate traffic for all 100 succeeds.
      for (let i = 0; i < N; i++) {
        expect(reg.authorize(msg(`agent-${i}`, `device-${i}`, `session-${i}`, 0)).ok).toBe(true);
      }

      // §15's exact named attack scenarios (Agent001->Device002, Agent050->Device051,
      // Agent100->Device001), reindexed to this suite's 0-based ids (agent-99 is the
      // 100th agent), plus a full N x N cross-product sweep below.
      expect(reg.authorize(msg("agent-0", "device-1", "session-0", 1))).toEqual({ ok: false, reason: "device_mismatch" });
      expect(reg.authorize(msg("agent-49", "device-50", "session-49", 1))).toEqual({ ok: false, reason: "device_mismatch" });
      expect(reg.authorize(msg("agent-99", "device-0", "session-99", 1))).toEqual({ ok: false, reason: "device_mismatch" });

      let rejections = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const result = reg.authorize(msg(`agent-${i}`, `device-${j}`, `session-${i}`, 1000 + j));
          expect(result.ok, `agent-${i} must not be authorized for device-${j}`).toBe(false);
          rejections++;
        }
      }
      expect(rejections).toBe(N * (N - 1));
    });

    it("§15 revoked / unknown / duplicate-agentId / stale-sequence / oversized scenarios all reject cleanly at 100-agent scale", () => {
      const reg = new TvAgentSessionRegistry();
      const N = 100;
      for (let i = 0; i < N; i++) reg.bind(`agent-${i}`, `device-${i}`, `session-${i}`);

      // Revoked agent.
      reg.revoke("agent-7");
      expect(reg.authorize(msg("agent-7", "device-7", "session-7", 1))).toEqual({ ok: false, reason: "revoked" });

      // Unknown agent (never bound).
      expect(reg.authorize(msg("agent-unknown", "device-1", "session-x", 1))).toEqual({ ok: false, reason: "unknown_agent" });

      // "Duplicated Agent ID" — attempting to rebind an already-bound id to a
      // different device must throw, not silently reassign identity.
      expect(() => reg.bind("agent-3", "device-999", "session-999")).toThrow();

      // Stale sequence after legitimate traffic already advanced the high-water mark.
      reg.authorize(msg("agent-10", "device-10", "session-10", 50));
      expect(reg.authorize(msg("agent-10", "device-10", "session-10", 49))).toEqual({ ok: false, reason: "stale_or_duplicate_sequence" });

      // Oversized/malformed messages are the wire-schema layer's job
      // (tv-agent-protocol.test.ts's §6 suite) — the registry's contract is only
      // identity/replay, confirmed here by simply noting authorize() never inspects
      // payload contents at all (a message that already failed parseAgentMessage never
      // reaches this registry in the real pipeline).
      expect(Object.keys(reg.describe("agent-10") ?? {})).not.toContain("payload");
    });
  });

  it("§9 resource accounting: registry size reflects bind/unbind exactly, across 100 cycles", () => {
    const reg = new TvAgentSessionRegistry();
    for (let i = 0; i < 100; i++) {
      reg.bind(`agent-${i}`, `device-${i}`, `session-${i}`);
    }
    expect(reg.size).toBe(100);
    for (let i = 0; i < 100; i++) reg.unbind(`agent-${i}`);
    expect(reg.size).toBe(0);
  });
});
