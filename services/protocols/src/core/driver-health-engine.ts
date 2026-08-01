/**
 * SupremeOS Driver Health Engine (§ Casambi Driver Refactor — PR-2). Generalizes the
 * Casambi-only Health Monitor shipped in the Foundation PR (`casambi/health-monitor.ts`) into a
 * reusable, cross-driver engine. Any driver can build a {@link DriverHealthInputs} from its own
 * real counters and get back one comparable {@link DriverHealthSnapshot} — a single health score
 * and verdict, instead of every driver inventing its own ad hoc "is it working" logic.
 *
 * Pure and synchronous: this module never owns a timer or a socket. A driver's own reconnect/
 * heartbeat scheduling (e.g. Casambi's `startHeartbeat`/`scheduleReconnect`, unchanged since the
 * Foundation PR) keeps producing the raw counters; this only turns them into a score.
 */

export type LifecycleState =
  | "not_implemented"
  | "unknown"
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface DriverHealthInputs {
  connectionState: LifecycleState;
  transportState: LifecycleState;
  discoveryState: LifecycleState;
  feedbackState: LifecycleState;
  synchronizationState: LifecycleState;
  /** Round-trip of the last heartbeat/probe, in ms. `null` when never measured. */
  latencyMs: number | null;
  reconnectCount: number;
  lastPacketAt: string | null;
  packetsReceived: number;
  /** Packets a driver KNOWS it missed (e.g. a sequence-numbered protocol detecting a gap) — `0`
   * for a driver with no way to detect loss, never a guess. */
  packetsLost: number;
  averageResponseTimeMs: number | null;
  entityCount: number;
  errors: string[];
  warnings: string[];
  diagnosticMessages: string[];
}

export type DriverHealthVerdict = "healthy" | "degraded" | "error" | "not_implemented";

export interface DriverHealthSnapshot extends DriverHealthInputs {
  /** 0 (unusable) – 100 (fully healthy). */
  healthScore: number;
  verdict: DriverHealthVerdict;
  packetLossRatio: number | null;
}

const STATE_PENALTY: Record<LifecycleState, number> = {
  connected: 0,
  idle: 0,
  connecting: 10,
  unknown: 15,
  disconnected: 30,
  error: 40,
  not_implemented: 100,
};

export function computeDriverHealth(inputs: DriverHealthInputs): DriverHealthSnapshot {
  const states = [
    inputs.connectionState,
    inputs.transportState,
    inputs.discoveryState,
    inputs.feedbackState,
    inputs.synchronizationState,
  ];
  if (states.every((s) => s === "not_implemented")) {
    return { ...inputs, healthScore: 0, verdict: "not_implemented", packetLossRatio: null };
  }

  let score = 100;
  for (const s of states) score -= STATE_PENALTY[s] / states.length;
  score -= Math.min(20, inputs.errors.length * 5);
  score -= Math.min(10, inputs.warnings.length * 2);
  score -= Math.min(15, inputs.reconnectCount * 3);

  const packetLossRatio =
    inputs.packetsReceived + inputs.packetsLost > 0
      ? inputs.packetsLost / (inputs.packetsReceived + inputs.packetsLost)
      : null;
  if (packetLossRatio !== null) score -= Math.min(20, packetLossRatio * 100);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: DriverHealthVerdict;
  if (inputs.errors.length > 0 || states.includes("error")) verdict = "error";
  else if (score >= 90) verdict = "healthy";
  else verdict = "degraded";

  return { ...inputs, healthScore: score, verdict, packetLossRatio };
}
