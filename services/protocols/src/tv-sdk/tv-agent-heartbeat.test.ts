import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_HEARTBEAT_POLICY, isAgentHeartbeatHealthy } from "./tv-agent-heartbeat.js";

describe("tv-agent-heartbeat — §7 heartbeat interval/timeout policy", () => {
  it("is healthy immediately after a heartbeat", () => {
    expect(isAgentHeartbeatHealthy(1000, 1000)).toBe(true);
  });

  it("is healthy within the timeout window, even after one missed interval", () => {
    const oneMissedBeat = DEFAULT_AGENT_HEARTBEAT_POLICY.intervalMs * 2;
    expect(isAgentHeartbeatHealthy(0, oneMissedBeat)).toBe(true);
  });

  it("is unhealthy once the timeout window elapses with no heartbeat", () => {
    expect(isAgentHeartbeatHealthy(0, DEFAULT_AGENT_HEARTBEAT_POLICY.timeoutMs + 1)).toBe(false);
  });

  it("timeoutMs is a multiple of intervalMs large enough to tolerate at least one missed beat", () => {
    expect(DEFAULT_AGENT_HEARTBEAT_POLICY.timeoutMs).toBeGreaterThanOrEqual(DEFAULT_AGENT_HEARTBEAT_POLICY.intervalMs * 2);
  });

  it("respects a custom policy rather than only the default", () => {
    const fast = { intervalMs: 100, timeoutMs: 300 };
    expect(isAgentHeartbeatHealthy(0, 250, fast)).toBe(true);
    expect(isAgentHeartbeatHealthy(0, 350, fast)).toBe(false);
  });
});
