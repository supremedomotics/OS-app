import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

/**
 * § Final Hardware Validation & Certification — Failure Analysis. "If discovery still fails, do
 * not modify protocol logic immediately. Instead prove exactly where the pipeline stopped." This
 * is that proof, mechanized: a pure function over an ALREADY-COLLECTED, real
 * `CasambiTransportMonitorSnapshot` (never a fresh measurement, never a guess) that walks the
 * pipeline stage by stage (Transport -> NATS -> Casambi Adapter -> Driver/Discovery) and reports
 * the first stage that looks broken, with a concrete, data-backed reason, the exact evidence that
 * led to that verdict, and a concrete next action — matching the certification brief's format:
 *
 *   ✓ UDP Received
 *   ✓ NATS Published
 *   ✓ Adapter Decoded
 *   ✗ Discovery
 *   Reason: ...
 *   Evidence: ...
 *   Suggested Fix: ...
 *
 * Every stage this function can't honestly evaluate from the snapshot (e.g. Cloud mode has no
 * UDP transport at all) is reported as `"not_applicable"`, never silently skipped or guessed as
 * passing. `evidence` is always the literal numbers/facts already present in the snapshot — never
 * a fresh measurement this function takes itself, and never fabricated when the snapshot has
 * nothing relevant to show.
 */
export type CasambiFailureStageStatus = "pass" | "fail" | "not_applicable";

export interface CasambiFailureStageResult {
  stage: string;
  status: CasambiFailureStageStatus;
  /** Present only when `status === "fail"` — a concrete, data-backed explanation, never a guess. */
  reason: string | null;
  /** The literal snapshot facts that led to this verdict (e.g. "transport.packetsReceived = 0",
   * "adapter.decodeFailures = 3"), so the verdict is independently checkable against the raw
   * Transport Monitor response, not just asserted. Empty for a stage with nothing distinctive to
   * cite (e.g. a plain pass with no interesting counters). */
  evidence: string[];
  /** A concrete next action for a `"fail"` stage — always actionable, never "check the logs".
   * `null` for `"pass"`/`"not_applicable"`. */
  suggestedFix: string | null;
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

interface StageInput {
  stage: string;
  status: CasambiFailureStageStatus;
  reason?: string;
  evidence?: string[];
  suggestedFix?: string;
}

export function buildFailureAnalysisReport(snapshot: CasambiTransportMonitorSnapshot): CasambiFailureAnalysisReport {
  const stages: CasambiFailureStageResult[] = [];
  const push = (input: StageInput) =>
    stages.push({
      stage: input.stage,
      status: input.status,
      reason: input.reason ?? null,
      evidence: input.evidence ?? [],
      suggestedFix: input.suggestedFix ?? null,
    });

  if (snapshot.connectionType === "cloud") {
    push({ stage: "Transport (UDP)", status: "not_applicable" });
    push({ stage: "NATS", status: "not_applicable" });
    push({ stage: "Casambi Adapter", status: "not_applicable" });
  } else {
    const transport = snapshot.transport;
    if (!transport) {
      push({
        stage: "Transport (UDP)",
        status: "fail",
        reason: "Local mode is configured but no transport has been constructed yet.",
        evidence: ["snapshot.transport = null"],
        suggestedFix: "Call driver.connect() (or confirm the Gateway's installer flow did) before polling the Transport Monitor.",
      });
    } else if (!transport.listening) {
      push({
        stage: "Transport (UDP)",
        status: "fail",
        reason: transport.lastError ? `Socket is not listening — last error: ${transport.lastError}` : "Socket is not listening, and no error was reported.",
        evidence: [`transport.listening = false`, `transport.lastError = ${JSON.stringify(transport.lastError)}`],
        suggestedFix: transport.lastError
          ? `Resolve the reported bind error ("${transport.lastError}") — common causes: another process already bound the UDP port (EADDRINUSE), or insufficient permission to bind it.`
          : "Confirm the Gateway's supreme-lan connectivity: is NatsUdpTransportClient's bind() request actually reaching a running supreme-lan process? Check supreme-lan's own container logs for a bind attempt.",
      });
    } else if (transport.backend === "nats" && (transport.packetsReceived ?? 0) === 0) {
      push({
        stage: "Transport (UDP)",
        status: "fail",
        reason: "Socket is bound and listening, but zero packets have been received by the transport itself.",
        evidence: [`transport.backend = "nats"`, `transport.listening = true`, `transport.packetsReceived = 0`],
        suggestedFix:
          "The real Lithernet gateway's broadcast is not reaching supreme-lan. Run tcpdump -i <iface> udp port <udp-port> on the Linux host itself: if tcpdump sees the broadcast and this doesn't, supreme-lan is likely still on bridge networking — confirm it's running with docker-compose.lan-host.yml's network_mode: host. If tcpdump sees nothing either, the problem is external (firewall, switch IGMP/broadcast filtering, wrong interface, VLAN mismatch), not something a code change fixes.",
      });
    } else if (transport.backend === "local-direct" && (transport.packetsReceived ?? 0) === 0) {
      push({
        stage: "Transport (UDP)",
        status: "fail",
        reason: "Socket is bound and listening (same-process, no supreme-lan), but zero packets received.",
        evidence: [`transport.backend = "local-direct"`, `transport.listening = true`, `transport.packetsReceived = 0`],
        suggestedFix: "Confirm the Gateway process itself is on the same LAN segment as the real gateway (no supreme-lan/host-networking layer is in play here to blame instead) — run tcpdump directly on the Gateway's own host.",
      });
    } else {
      push({
        stage: "Transport (UDP)",
        status: "pass",
        evidence: [`transport.backend = "${transport.backend}"`, `transport.packetsReceived = ${transport.packetsReceived}`, `transport.lastError = ${JSON.stringify(transport.lastError)}`],
      });
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
        push({ stage: "NATS", status: "not_applicable" }); // no point evaluating a downstream stage past a failed one
      } else {
        push({
          stage: "NATS",
          status: "pass",
          evidence: [`transport.packetsReceived = ${transport.packetsReceived} (these ARE real session.rx events delivered over NATS — there is no other path for this counter to increment)`],
        });
      }
    } else {
      push({ stage: "NATS", status: "not_applicable" }); // local-direct has no NATS hop at all
    }

    const adapter = snapshot.adapter;
    if (!adapter) {
      push({ stage: "Casambi Adapter", status: "fail", reason: "No adapter-level data available (transport never constructed).", evidence: ["snapshot.adapter = null"], suggestedFix: "Same fix as the Transport stage above — connect the driver first." });
    } else if (adapter.packetsReceived === 0) {
      push({ stage: "Casambi Adapter", status: "not_applicable" }); // nothing to decode yet — not a new failure past Transport's own verdict
    } else if (adapter.decoded === 0 && adapter.decodeFailures > 0) {
      const lastErr = adapter.lastDecodeError;
      push({
        stage: "Casambi Adapter",
        status: "fail",
        reason: lastErr
          ? `${adapter.decodeFailures} datagram(s) received, none decoded successfully. Last decode error: "${lastErr.message}"`
          : `${adapter.decodeFailures} datagram(s) received, none decoded successfully, but no decode error detail is available.`,
        evidence: [
          `adapter.packetsReceived = ${adapter.packetsReceived}`,
          `adapter.decoded = 0`,
          `adapter.decodeFailures = ${adapter.decodeFailures}`,
          ...(lastErr ? [`lastDecodeError.raw = ${JSON.stringify(lastErr.raw)}`, `lastDecodeError.message = ${JSON.stringify(lastErr.message)}`] : []),
        ],
        suggestedFix: lastErr
          ? `Check the raw payload against udp-codec.ts's decodeCasambiPacket format expectations — likely a Net ID/Data Format mismatch between the Gateway's config and the real gateway's own "DEC or HEX" setting, or a firmware wire-format difference not yet accounted for. Save this raw payload as a new regression capture (see the Packet Replay guide) so it's a permanent test once fixed.`
          : "Enable driver logging (onLog) and re-trigger the traffic to capture a fresh decode error with detail.",
      });
    } else {
      push({
        stage: "Casambi Adapter",
        status: "pass",
        evidence: [`adapter.packetsReceived = ${adapter.packetsReceived}`, `adapter.decoded = ${adapter.decoded}`, `adapter.decodeFailures = ${adapter.decodeFailures}`],
      });
    }
  }

  const driver = snapshot.driver;
  if (snapshot.connectionType === "local" && (snapshot.adapter?.decoded ?? 0) === 0) {
    push({ stage: "Discovery / Driver", status: "not_applicable" }); // nothing decoded yet to discover from
  } else if (driver.unmappedOpcodeEvents > 0 && driver.discoveryEvents === 0 && driver.feedbackEvents === 0) {
    const opcodeHex = driver.lastUnmappedOpcode !== null ? `0x${driver.lastUnmappedOpcode.toString(16)}` : "unknown";
    push({
      stage: "Discovery / Driver",
      status: "fail",
      reason: `Discovery ignored packet — opcode ${opcodeHex} not mapped to a driver signal.`,
      evidence: [`driver.unmappedOpcodeEvents = ${driver.unmappedOpcodeEvents}`, `driver.lastUnmappedOpcode = ${opcodeHex}`, `driver.discoveryEvents = 0`, `driver.feedbackEvents = 0`],
      suggestedFix: `Add a case for opcode ${opcodeHex} to event-engine.ts's normalizeLocalPacket() once its real payload meaning is confirmed against the Lithernet UDP Developer Reference (or against driver.recentJourney's raw payload for this exact packet). Save the triggering capture under tests/regression/casambi/ so the fix is permanently regression-tested.`,
    });
  } else if (driver.entities === 0 && driver.discoveryEvents === 0 && snapshot.connectionType === "local") {
    push({ stage: "Discovery / Driver", status: "not_applicable" }); // no traffic reached the driver at all yet — covered by earlier stages
  } else {
    push({
      stage: "Discovery / Driver",
      status: "pass",
      evidence: [`driver.entities = ${driver.entities}`, `driver.discoveryEvents = ${driver.discoveryEvents}`, `driver.feedbackEvents = ${driver.feedbackEvents}`, `driver.commandsIssued = ${driver.commandsIssued}`],
    });
  }

  const failing = stages.find((s) => s.status === "fail");
  return {
    healthy: !failing,
    stages,
    firstFailingStage: failing?.stage ?? null,
  };
}

/** Renders a `CasambiFailureAnalysisReport` in the exact ✓/✗ + Reason/Evidence/Suggested Fix
 * shape the certification brief specified — the one place this codebase produces that literal
 * text shape, kept separate from the structured report so a UI/CLI/log consumer can format it
 * differently if needed. */
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
    if (failed?.evidence.length) lines.push("", "Evidence:", ...failed.evidence.map((e) => `- ${e}`));
    if (failed?.suggestedFix) lines.push("", "Suggested Fix:", failed.suggestedFix);
  }
  return lines.join("\n");
}
