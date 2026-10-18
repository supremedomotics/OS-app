/**
 * KNX device-health model and evidence rules (§ Supreme KNX Health). PURE: no I/O, no timers — the stateful monitor (health-monitor.ts) feeds it.
 * Design, evidence classes and the rule table: docs/knx/knx-device-health-design.md. Key principle: SILENCE IS NOT EVIDENCE OF ABSENCE. `offline` needs
 * repeated active-check failures, proof that the device has answered an active read before, a long silence window, and a healthy path.
 * Every default below is an implementation decision (class I); none comes from a KNX specification.
 */
export type HealthState = "online" | "offline" | "degraded" | "unknown";
export type Confidence = "high" | "medium" | "low" | "none";
export type EvidenceKind = "passive_telegram" | "active_response";
export type HealthReason =
  | "not_monitored" | "path_down" | "path_unknown" | "bus_degraded"
  | "active_checks_failed" | "unproven_silent" | "no_evidence" | "intermittent" | "slow_response"
  | "active_response" | "passive_telegram" | "stale_evidence";

export type GatewayReachability = "reachable" | "unreachable" | "unknown";
export type InterfaceConnectivity = "up" | "down" | "unknown";
export type BusCommunication = "ok" | "degraded" | "unknown";
export interface PathObservation {
  gateway: GatewayReachability;
  interface: InterfaceConnectivity;
  bus: BusCommunication;
}

export interface HealthConfig {
  /** Evidence younger than this makes a device `online` (passive telegram / active response respectively). */
  passiveFreshnessMs: number;
  activeFreshnessMs: number;
  degradedAfterFailures: number;
  offlineAfterFailures: number;
  /** `offline` additionally requires this long without ANY evidence. */
  offlineMinSilenceMs: number;
  slowResponseMs: number;
  /** Intermittent = at least this many failures among the last `ringSize` conclusive active outcomes while the latest succeeded. */
  intermittentFailures: number;
  ringSize: number;
  // --- active checking
  tickMs: number;
  checkIntervalMs: number;
  failureRecheckMs: number;
  offlineProbeIntervalMs: number;
  responseTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  // --- load control
  maxConcurrentChecks: number;
  minReadGapMs: number;
  maxChecksPerMinute: number;
  maxChecksPerTick: number;
  controlQuietMs: number;
  // --- bus judgement
  busErrorThreshold: number;
  busFreshnessMs: number;
  eventLogSize: number;
}

export const DEFAULT_HEALTH_CONFIG: Readonly<HealthConfig> = Object.freeze({
  passiveFreshnessMs: 600_000,
  activeFreshnessMs: 900_000,
  degradedAfterFailures: 1,
  offlineAfterFailures: 3,
  offlineMinSilenceMs: 600_000,
  slowResponseMs: 1_500,
  intermittentFailures: 3,
  ringSize: 8,
  tickMs: 5_000,
  checkIntervalMs: 300_000,
  failureRecheckMs: 60_000,
  offlineProbeIntervalMs: 600_000,
  responseTimeoutMs: 3_000,
  maxAttempts: 2,
  retryDelayMs: 1_000,
  maxConcurrentChecks: 1,
  minReadGapMs: 1_000,
  maxChecksPerMinute: 6,
  maxChecksPerTick: 1,
  controlQuietMs: 3_000,
  busErrorThreshold: 3,
  busFreshnessMs: 300_000,
  eventLogSize: 256,
});

export type ActiveCheckCapability = "not_available" | "candidate" | "proven" | "disabled";

export interface DeviceRecord {
  deviceId: string;
  individualAddress: number | null;
  /** Readable status group addresses the DEVICE ITSELF sends/answers (integrator-supplied; e.g. ETS objects with the Read flag). */
  statusGroups: number[];
  /** `disabled` = never probe (e.g. Data Secure groups, where a plain read is not a valid exchange). */
  activeCheck: "allowed" | "disabled";
  lastSeenAt: number | null;
  lastSeenKind: EvidenceKind | null;
  lastResponseAt: number | null;
  lastResponseLatencyMs: number | null;
  /** The device has answered an active read at least once: only then can repeated silence mean anything. */
  proven: boolean;
  consecutiveFailures: number;
  /** Conclusive active outcomes, newest last; true = answered. */
  ring: boolean[];
  lastCheck: { at: number; outcome: "success" | "failure" | "inconclusive" } | null;
}

export interface Evaluation { state: HealthState; confidence: Confidence; reason: HealthReason }

export function activeCapability(d: DeviceRecord): ActiveCheckCapability {
  if (d.activeCheck === "disabled") return "disabled";
  if (d.individualAddress === null || d.statusGroups.length === 0) return "not_available";
  return d.proven ? "proven" : "candidate";
}

const fresh = (d: DeviceRecord, now: number, c: HealthConfig): boolean => {
  if (d.lastSeenAt === null) return false;
  const win = d.lastSeenKind === "active_response" ? c.activeFreshnessMs : c.passiveFreshnessMs;
  return now - d.lastSeenAt <= win;
};

/** Rule table of docs/knx/knx-device-health-design.md §3 — ordered, first match wins. */
export function evaluateDevice(d: DeviceRecord, now: number, path: PathObservation, c: HealthConfig): Evaluation {
  if (path.gateway === "unreachable" || path.interface === "down") return { state: "unknown", confidence: "none", reason: "path_down" };
  if (path.gateway === "unknown" || path.interface === "unknown") return { state: "unknown", confidence: "none", reason: "path_unknown" };
  if (path.bus === "degraded") return { state: "unknown", confidence: "low", reason: "bus_degraded" };

  const freshEv = fresh(d, now, c);
  const silentFor = d.lastSeenAt === null ? Number.POSITIVE_INFINITY : now - d.lastSeenAt;
  if (d.proven && d.consecutiveFailures >= c.offlineAfterFailures && silentFor >= c.offlineMinSilenceMs) {
    return { state: "offline", confidence: "high", reason: "active_checks_failed" };
  }
  if (!d.proven && d.consecutiveFailures >= c.offlineAfterFailures && !freshEv) {
    return { state: "unknown", confidence: "low", reason: "unproven_silent" };
  }
  if (d.proven && d.consecutiveFailures >= c.degradedAfterFailures) return { state: "degraded", confidence: "medium", reason: "active_checks_failed" };
  if (d.lastSeenAt === null) return { state: "unknown", confidence: "none", reason: "no_evidence" };

  const failuresInRing = d.ring.filter((ok) => !ok).length;
  if (failuresInRing >= c.intermittentFailures && d.ring[d.ring.length - 1] === true) return { state: "degraded", confidence: "medium", reason: "intermittent" };
  if (freshEv && d.lastSeenKind === "active_response" && d.lastResponseLatencyMs !== null && d.lastResponseLatencyMs > c.slowResponseMs) {
    return { state: "degraded", confidence: "medium", reason: "slow_response" };
  }
  if (freshEv) return d.lastSeenKind === "active_response"
    ? { state: "online", confidence: "high", reason: "active_response" }
    : { state: "online", confidence: "medium", reason: "passive_telegram" };
  return { state: "unknown", confidence: "low", reason: "stale_evidence" };
}
