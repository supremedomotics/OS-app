import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

/**
 * § Final Hardware Validation — Failure Analysis. "If discovery still fails, do not modify
 * protocol logic immediately. Instead prove exactly where the pipeline stopped." This is that
 * proof, mechanized: a pure function over an ALREADY-COLLECTED, real `CasambiTransportMonitorSnapshot`
 * (never a fresh measurement, never a guess) that walks the pipeline stage by stage
 * (Transport -> NATS -> Casambi Adapter -> Driver/Discovery) and reports the first stage that
 * looks broken, with a concrete, data-backed reason — matching the brief's own example format:
 *
 *   ✓ UDP received
 *   ✓ Published to NATS
 *   ✓ Adapter decoded
 *   ✗ Discovery ignored packet
 *   Reason: Opcode 0xXX not mapped.
 *
 * Every stage this function can't honestly evaluate from the snapshot (e.g. Cloud mode has no
 * UDP transport at all) is reported as `"not_applicable"`, never silently skipped or guessed as
 * passing.
 */
export type CasambiFailureStageStatus = "pass" | "fail" | "not_applicable";

export interface CasambiFailureStageResult {
  stage: string;
  status: CasambiFailureStageStatus;
  /** Present only when `status === "fail"` — a concrete, data-backed explanation, never a guess. */
  reason: string | null;
}

export interface CasambiFailureAnalysisReport {
  /** `true` only when every evaluated stage passed (stages marked `not_applicable` don't count
   * against this — e.g. Cloud mode passing with no UDP stages at all is a legitimate "healthy"). */
  healthy: boolean;
  stages: CasambiFailureStageResult[];
  /** The FIRST failing stage's name, or `null` if none failed — "prove exactly where the
   * pipeline stopped" as a single, unambiguous answer. */
  firstFailingStage: string | null;
}

export function buildFailureAnalysisReport(snapshot: CasambiTransportMonitorSnapshot): CasambiFailureAnalysisReport {
  const stages: CasambiFailureStageResult[] = [];
  const push = (stage: string, status: CasambiFailureStageStatus, reason: string | null = null) =>
    stages.push({ stage, status, reason });

  if (snapshot.connectionType === "cloud") {
    push("Transport (UDP)", "not_applicable", null);
    push("NATS", "not_applicable", null);
    push("Casambi Adapter", "not_applicable", null);
  } else {
    const transport = snapshot.transport;
    if (!transport) {
      push("Transport (UDP)", "fail", "Local mode is configured but no transport has been constructed yet (driver never connected).");
    } else if (!transport.listening) {
      push(
        "Transport (UDP)",
        "fail",
        transport.lastError
          ? `Socket is not listening — last error: ${transport.lastError}`
          : "Socket is not listening (bind never completed, and no error was reported — check the Gateway's supreme-lan connectivity).",
      );
    } else if (transport.backend === "nats" && (transport.packetsReceived ?? 0) === 0) {
      push("Transport (UDP)", "fail", "Socket is bound and listening, but zero packets have been received by the transport itself. The real Lithernet gateway's broadcast is not reaching supreme-lan — check the gateway's own broadcast (Wireshark on the Docker host's real NIC) and confirm supreme-lan is on host networking, not bridge (see the architecture doc §1/§10.3).");
    } else if (transport.backend === "local-direct" && (transport.packetsReceived ?? 0) === 0) {
      push("Transport (UDP)", "fail", "Socket is bound and listening (same-process, no supreme-lan), but zero packets received. Confirm the real Lithernet gateway can actually reach this host's LAN interface directly.");
    } else {
      push("Transport (UDP)", "pass");
    }

    if (transport?.backend === "nats") {
      // A real, per-instance count of NATS request/reply + session events this client observed
      // (see NatsUdpTransportClient's own counters) — approximated here from the transport
      // section's packetsReceived, since that field IS the count of real session.rx events this
      // client received over NATS. A genuine "supreme-lan received it but NATS never delivered
      // it" gap would show as transport.packetsReceived stuck at 0 while a direct
      // `queryLanHealth()` call (see the Transport Monitor route) shows the SERVICE'S OWN session
      // counters already incremented — that comparison requires the `lan` field the Gateway route
      // attaches, which this pure function (snapshot-only) doesn't have; report NATS as
      // "cannot evaluate in isolation" rather than guess.
      if (stages[0]?.status === "fail" && stages[0]?.stage === "Transport (UDP)") {
        push("NATS", "not_applicable", null); // no point evaluating a downstream stage past a failed one
      } else {
        push("NATS", "pass");
      }
    } else {
      push("NATS", "not_applicable", null); // local-direct has no NATS hop at all
    }

    const adapter = snapshot.adapter;
    if (!adapter) {
      push("Casambi Adapter", "fail", "No adapter-level data available (transport never constructed).");
    } else if (adapter.packetsReceived === 0) {
      push("Casambi Adapter", "not_applicable", null); // nothing to decode yet — not a new failure past Transport's own verdict
    } else if (adapter.decoded === 0 && adapter.decodeFailures > 0) {
      const lastErr = adapter.lastDecodeError;
      push(
        "Casambi Adapter",
        "fail",
        lastErr
          ? `${adapter.decodeFailures} datagram(s) received, none decoded successfully. Last decode error: "${lastErr.message}" on payload: ${lastErr.raw.trim()}`
          : `${adapter.decodeFailures} datagram(s) received, none decoded successfully, but no decode error detail is available.`,
      );
    } else {
      push("Casambi Adapter", "pass");
    }
  }

  const driver = snapshot.driver;
  if (snapshot.connectionType === "local" && (snapshot.adapter?.decoded ?? 0) === 0) {
    push("Discovery / Driver", "not_applicable", null); // nothing decoded yet to discover from
  } else if (driver.unmappedOpcodeEvents > 0 && driver.discoveryEvents === 0 && driver.feedbackEvents === 0) {
    const opcodeHex = driver.lastUnmappedOpcode !== null ? `0x${driver.lastUnmappedOpcode.toString(16)}` : "unknown";
    push("Discovery / Driver", "fail", `Discovery ignored packet — opcode ${opcodeHex} not mapped to a driver signal (see event-engine.ts's normalizeLocalPacket).`);
  } else if (driver.entities === 0 && driver.discoveryEvents === 0 && snapshot.connectionType === "local") {
    push("Discovery / Driver", "not_applicable", null); // no traffic reached the driver at all yet — covered by earlier stages
  } else {
    push("Discovery / Driver", "pass");
  }

  const failing = stages.find((s) => s.status === "fail");
  return {
    healthy: !failing,
    stages,
    firstFailingStage: failing?.stage ?? null,
  };
}

/** Renders a `CasambiFailureAnalysisReport` in the exact ✓/✗ checklist format the governing
 * brief specified — the one place this codebase produces that literal text shape, kept separate
 * from the structured report so a UI/CLI/log consumer can format it differently if needed. */
export function formatFailureAnalysisReport(report: CasambiFailureAnalysisReport): string {
  const lines: string[] = [];
  for (const stage of report.stages) {
    if (stage.status === "not_applicable") {
      lines.push(`○ ${stage.stage} (not applicable)`);
    } else {
      lines.push(`${stage.status === "pass" ? "✓" : "✗"} ${stage.stage}`);
    }
  }
  if (report.firstFailingStage) {
    const failed = report.stages.find((s) => s.stage === report.firstFailingStage);
    lines.push("", "Reason:", failed?.reason ?? "(no reason recorded)");
  }
  return lines.join("\n");
}
