/**
 * (§7 Phase 3A — heartbeat policy) A TCP/TLS socket staying open is not evidence the
 * Agent process behind it is alive (§13 Phase 2 gate's "connection state must be
 * truthful" principle, applied here) — a stalled/deadlocked Agent can hold a socket
 * open indefinitely while never sending another `heartbeat`. This module is pure
 * policy (interval/timeout math), deliberately with no socket/timer of its own, so it's
 * testable without fake clocks tied to a real transport.
 */
export interface TvAgentHeartbeatPolicy {
  /** How often the Agent is expected to send a `heartbeat` message. */
  intervalMs: number;
  /** No heartbeat received within this window since the last one (or since connect, if
   * none yet) means the Agent is considered unhealthy. Must be a multiple of
   * `intervalMs` large enough to absorb normal jitter/GC pauses without one missed beat
   * flapping the connection — see `DEFAULT_AGENT_HEARTBEAT_POLICY`'s doc comment for
   * why 3x is the chosen default. */
  timeoutMs: number;
}

/** §7 "do not make the heartbeat excessively frequent for 100 devices" — 100 sockets
 * each heartbeating every 15s is 100 tiny messages every 15s (~6.7/s system-wide),
 * negligible even on a modest hub; every 1s would be 100x that for no real benefit,
 * since an Agent crash/hang is not a sub-second-latency event to detect. `timeoutMs` at
 * 3x interval tolerates one missed beat (a GC pause, a brief CPU spike) without
 * flapping, while still detecting a genuinely dead Agent within ~45s — acceptable for
 * a "rich feedback degraded" signal, not a hard real-time control path (that's Remote
 * v2's job, with its own, much tighter, reconnect timing). */
export const DEFAULT_AGENT_HEARTBEAT_POLICY: TvAgentHeartbeatPolicy = {
  intervalMs: 15_000,
  timeoutMs: 45_000,
};

/** Pure function: given when the last heartbeat (or connection) was observed and the
 * current time, is the Agent still considered healthy under this policy? No hidden
 * state, no timers — the caller (a real Agent transport) owns scheduling; this is only
 * the health/staleness judgment. */
export function isAgentHeartbeatHealthy(lastHeartbeatAt: number, now: number, policy: TvAgentHeartbeatPolicy = DEFAULT_AGENT_HEARTBEAT_POLICY): boolean {
  return now - lastHeartbeatAt < policy.timeoutMs;
}
