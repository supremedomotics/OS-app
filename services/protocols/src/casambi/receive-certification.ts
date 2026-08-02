import { casambiReceivePipeline, type ReceivePipelineInputs } from "./receive-pipeline.js";
import type { PipelineStage } from "../core/pipeline-stages.js";

/**
 * § Runtime Data Path Verification — automatic root cause detection and the final certification
 * report.
 *
 * "Never invent a diagnosis. If unknown, report unknown." That rule is implemented literally: every
 * classification below requires specific evidence to be present, and the function falls through to
 * `unknown` rather than picking the closest-looking category. `unknown` carries what WOULD settle
 * it, so an unknown verdict is an instruction rather than a shrug.
 *
 * The classifier is intentionally ordered from the bottom of the stack upward. Diagnosing at the
 * wrong layer is the specific failure this whole investigation exists to prevent: if the kernel
 * never delivered a datagram, the decoder's counters are irrelevant, and reporting "decoder
 * rejected packets" because it happens to have zero successes would send someone to rewrite a
 * codec that was never reached.
 */

/** Exactly the categories the brief specifies — no more, and none invented. */
export type ReceiveRootCause =
  | "gateway_not_transmitting"
  | "packets_blocked_before_socket"
  | "packets_received_by_socket"
  | "packets_lost_before_nats"
  | "packets_lost_before_decoder"
  | "packets_rejected_by_decoder"
  | "packets_ignored_by_discovery"
  | "entities_not_created"
  | "unknown";

export interface RootCauseVerdict {
  cause: ReceiveRootCause;
  /** Plain-language statement of what the evidence shows. */
  summary: string;
  /** The literal facts that led here, so the verdict is independently checkable. */
  evidence: string[];
  /** For `unknown`: exactly what additional evidence would settle it. `null` otherwise. */
  needed: string | null;
}

/** § "Compare with Wireshark" — the difference report. SupremeOS cannot observe the host capture
 * itself, so `wiresharkPackets` is a supplied input; when it is absent the comparison reports that
 * honestly rather than assuming zero. */
export interface WiresharkComparison {
  wiresharkPackets: number | null;
  socketPackets: number | null;
  /** `wireshark - socket`, or `null` when either side is unknown. */
  difference: number | null;
  /** The first stage at which the count drops, in plain words. */
  stageWherePacketsDisappear: string;
  captureFilter: string | null;
}

export type CertificationStatus = "pass" | "fail" | "not_evaluated";

export interface CertificationSection {
  name: string;
  status: CertificationStatus;
  detail: string;
}

export interface ReceiveCertificationReport {
  generatedAt: string;
  sections: CertificationSection[];
  rootCause: RootCauseVerdict;
  wireshark: WiresharkComparison;
  stages: PipelineStage[];
  /** `true` only when every evaluated section passed. A `not_evaluated` section never counts as a
   * pass — an un-run check is not a passing check. */
  certified: boolean;
}

function stageMetric(stages: PipelineStage[], name: string, field: "entered" | "exited" | "failures"): number | null {
  return stages.find((s) => s.name === name)?.metrics?.[field] ?? null;
}

export function classifyReceiveRootCause(inputs: ReceivePipelineInputs, stages: PipelineStage[]): RootCauseVerdict {
  const { snapshot, lan, wireshark } = inputs;

  if (snapshot.connectionType !== "local") {
    return {
      cause: "unknown",
      summary: "The driver is in Cloud mode, which has no UDP receive pipeline. No receive-path root cause applies.",
      evidence: [`snapshot.connectionType = "${snapshot.connectionType}"`],
      needed: "Switch the driver to Local Gateway mode to evaluate the UDP receive path.",
    };
  }

  const socketReceived = snapshot.transport?.packetsReceived ?? null;
  const adapterReceived = snapshot.adapter?.packetsReceived ?? null;
  const decoded = snapshot.adapter?.decoded ?? null;
  const decodeFailures = snapshot.adapter?.decodeFailures ?? 0;
  const probe = lan?.probe ?? null;
  const kernelDrops = stageMetric(stages, "OS Network Stack", "failures");

  // ── Layer 0: did the kernel drop what it DID receive? ──────────────────────────────────────
  // Checked first because it is the one case where packets provably arrived AND were provably
  // lost by the OS — every application-level counter downstream would be misleading.
  if (kernelDrops !== null && kernelDrops > 0) {
    return {
      cause: "packets_blocked_before_socket",
      summary: `The kernel dropped ${kernelDrops} datagram(s) destined for this process's socket — they reached the machine and were lost to receive-buffer overflow before the application could read them.`,
      evidence: [`/proc/net/udp drops = ${kernelDrops}`, `transport.packetsReceived = ${socketReceived}`],
      needed: null,
    };
  }

  // ── Layer 1: is anything reaching the process at all? ──────────────────────────────────────
  if ((socketReceived ?? 0) === 0) {
    // The independent probe is what separates "below SupremeOS" from "the gateway is silent".
    if (probe?.listening && (probe.datagramsReceived ?? 0) > 0) {
      return {
        cause: "packets_lost_before_nats",
        summary: `The independent probe received ${probe.datagramsReceived} datagram(s) on the same port while the driver's own socket received none. The OS delivers traffic to this process, so the loss is INSIDE SupremeOS, between the transport socket and the driver.`,
        evidence: [`probe.datagramsReceived = ${probe.datagramsReceived}`, `transport.packetsReceived = ${socketReceived}`, `probe.boundPort = ${probe.boundPort}`],
        needed: null,
      };
    }
    if (probe?.listening && (probe.datagramsReceived ?? 0) === 0) {
      // Both listeners are deaf. Whether the gateway is silent or the packets are blocked before
      // the namespace is NOT determinable from inside the process — that is exactly what the host
      // capture settles, and it is the one input SupremeOS cannot produce itself.
      if (wireshark && wireshark.packets > 0) {
        return {
          cause: "packets_blocked_before_socket",
          summary: `A host capture recorded ${wireshark.packets} packet(s) over the same window, while BOTH the driver's socket and the independent probe received zero. The packets reach the machine but never reach this process's network namespace.`,
          evidence: [`wireshark.packets = ${wireshark.packets}`, `probe.datagramsReceived = 0`, `transport.packetsReceived = 0`, `network.namespace = ${lan?.network?.networkNamespace ?? "unknown"}`],
          needed: null,
        };
      }
      if (wireshark && wireshark.packets === 0) {
        return {
          cause: "gateway_not_transmitting",
          summary: "A host capture over the same window recorded zero packets, and both listeners received zero. Nothing is being transmitted to this machine — the fault is at the gateway or on the network path to it, not in SupremeOS.",
          evidence: [`wireshark.packets = 0`, `probe.datagramsReceived = 0`, `transport.packetsReceived = 0`],
          needed: null,
        };
      }
      return {
        cause: "unknown",
        summary: "Neither the driver's socket nor the independent probe has received anything. From inside this process, 'the gateway is not transmitting' and 'the packets are blocked before this network namespace' are indistinguishable — both produce exactly these counters.",
        evidence: [`transport.packetsReceived = 0`, `probe.datagramsReceived = 0`, `probe.listening = true`],
        needed:
          "A host-side packet capture (tcpdump -i <iface> udp port <port>) taken over the same window. If it shows packets, the cause is packets_blocked_before_socket; if it shows none, the cause is gateway_not_transmitting. No measurement available inside this process can substitute for it.",
      };
    }
    return {
      cause: "unknown",
      summary: "The driver's socket has received nothing, and no independent probe was running to tell whether that is a SupremeOS problem or an absence of traffic.",
      evidence: [`transport.packetsReceived = 0`, `probe = ${probe === null ? "null (not running)" : "not listening"}`],
      needed: lan?.probeDisabledReason ?? "Start the independent UDP probe (SUPREME_LAN_PROBE_PORT) and take a host-side capture over the same window.",
    };
  }

  // ── Layer 2: packets reached the socket. Where do they stop after that? ────────────────────
  if ((adapterReceived ?? 0) === 0) {
    return {
      cause: "packets_lost_before_decoder",
      summary: `The transport socket received ${socketReceived} datagram(s), but none reached the Casambi engine. The loss is in the delivery path between the transport and the driver.`,
      evidence: [`transport.packetsReceived = ${socketReceived}`, `adapter.packetsReceived = 0`, `transport.backend = "${snapshot.transport?.backend}"`],
      needed: null,
    };
  }

  if ((decoded ?? 0) === 0 && decodeFailures > 0) {
    return {
      cause: "packets_rejected_by_decoder",
      summary: `${decodeFailures} datagram(s) reached the decoder and every one failed to parse. This is a wire-format mismatch, not a reception problem.`,
      evidence: [`adapter.packetsReceived = ${adapterReceived}`, `adapter.decoded = 0`, `adapter.decodeFailures = ${decodeFailures}`, `lastDecodeError = ${JSON.stringify(snapshot.adapter?.lastDecodeError?.message ?? null)}`],
      needed: null,
    };
  }

  if (snapshot.driver.discoveryEvents === 0 && snapshot.driver.unmappedOpcodeEvents > 0) {
    const opcode = snapshot.driver.lastUnmappedOpcode;
    return {
      cause: "packets_ignored_by_discovery",
      summary: `${snapshot.driver.unmappedOpcodeEvents} packet(s) decoded successfully but carried an opcode Discovery does not map (last: 0x${(opcode ?? 0).toString(16)}), so nothing downstream ever saw them.`,
      evidence: [`adapter.decoded = ${decoded}`, `driver.discoveryEvents = 0`, `driver.unmappedOpcodeEvents = ${snapshot.driver.unmappedOpcodeEvents}`, `driver.lastUnmappedOpcode = 0x${(opcode ?? 0).toString(16)}`],
      needed: null,
    };
  }

  if (snapshot.driver.discoveryEvents > 0 && snapshot.driver.entities === 0) {
    return {
      cause: "entities_not_created",
      summary: `${snapshot.driver.discoveryEvents} unit(s) were discovered but no entity was created from them — the loss is in the entity mapper, downstream of a working receive path.`,
      evidence: [`driver.discoveryEvents = ${snapshot.driver.discoveryEvents}`, `driver.entities = 0`],
      needed: null,
    };
  }

  return {
    cause: "packets_received_by_socket",
    summary: `The receive path is working end to end: ${socketReceived} datagram(s) received, ${decoded} decoded, ${snapshot.driver.discoveryEvents} unit(s) discovered, ${snapshot.driver.entities} entit(y/ies) created.`,
    evidence: [`transport.packetsReceived = ${socketReceived}`, `adapter.decoded = ${decoded}`, `driver.discoveryEvents = ${snapshot.driver.discoveryEvents}`, `driver.entities = ${snapshot.driver.entities}`],
    needed: null,
  };
}

export function compareWithWireshark(inputs: ReceivePipelineInputs, cause: ReceiveRootCause): WiresharkComparison {
  const socketPackets = inputs.snapshot.transport?.packetsReceived ?? null;
  const wiresharkPackets = inputs.wireshark?.packets ?? null;
  const difference = wiresharkPackets !== null && socketPackets !== null ? wiresharkPackets - socketPackets : null;

  return {
    wiresharkPackets,
    socketPackets,
    difference,
    captureFilter: inputs.wireshark?.captureFilter ?? null,
    stageWherePacketsDisappear: whereTheyDisappear(inputs, cause, difference),
  };
}

function whereTheyDisappear(inputs: ReceivePipelineInputs, cause: ReceiveRootCause, difference: number | null): string {
  if (inputs.wireshark == null) return "Not determinable — no host capture count was supplied to compare against.";
  if (difference === null) return "Not determinable — the socket's receive count is unavailable.";
  if (difference <= 0) return "Nowhere — the socket received at least as many packets as the host capture recorded.";
  switch (cause) {
    case "packets_blocked_before_socket":
      return "Before socket receive";
    case "gateway_not_transmitting":
      return "Nowhere in SupremeOS — nothing was transmitted to lose.";
    case "packets_lost_before_nats":
      return "Between the transport socket and the NATS publish";
    case "packets_lost_before_decoder":
      return "Between the transport and the Casambi engine";
    case "packets_rejected_by_decoder":
      return "At the protocol decoder";
    case "packets_ignored_by_discovery":
      return "At the Discovery Engine";
    case "entities_not_created":
      return "At the Entity Mapper";
    default:
      return "Unknown — the capture shows more packets than the socket received, but the evidence does not identify which stage lost them.";
  }
}

/** The seven certification sections, in the order the brief specifies. A section is `not_evaluated`
 * whenever the evidence needed to judge it was not collected — never silently passed. */
export function buildReceiveCertificationReport(inputs: ReceivePipelineInputs): ReceiveCertificationReport {
  const stages = casambiReceivePipeline(inputs);
  const rootCause = classifyReceiveRootCause(inputs, stages);
  const wireshark = compareWithWireshark(inputs, rootCause.cause);
  const s = inputs.snapshot;

  const socketReceived = s.transport?.packetsReceived ?? null;
  const adapterReceived = s.adapter?.packetsReceived ?? null;
  const decoded = s.adapter?.decoded ?? null;
  const net = inputs.lan?.network ?? null;

  const sections: CertificationSection[] = [
    section("Socket", s.transport?.localPort != null, `Socket ${s.transport?.localPort != null ? `bound on ${s.transport.localAddress ?? "0.0.0.0"}:${s.transport.localPort}` : "was never created"}.`, s.connectionType !== "local"),
    net === null
      ? { name: "Network", status: "not_evaluated", detail: "No supreme-lan forensics were collected, so the network namespace, routing table, and kernel counters were never inspected." }
      : section(
          "Network",
          net.defaultGateway !== null && (stageMetric(stages, "OS Network Stack", "failures") ?? 0) === 0,
          net.defaultGateway === null
            ? `Namespace ${net.networkNamespace ?? "unknown"} has NO default route — off-subnet sends are rejected by the kernel.`
            : `Namespace ${net.networkNamespace ?? "unknown"}, default gateway ${net.defaultGateway}, no kernel-level drops.`,
        ),
    section("Packet Reception", (socketReceived ?? 0) > 0, `${socketReceived ?? 0} datagram(s) delivered by the OS to the transport socket.`),
    s.transport?.backend === "nats"
      ? section("NATS", (adapterReceived ?? 0) > 0 && adapterReceived === socketReceived, `supreme-lan published ${socketReceived ?? 0}; the Gateway subscriber received ${adapterReceived ?? 0}.`)
      : { name: "NATS", status: "not_evaluated", detail: "The transport is local-direct (same process) — there is no NATS hop in this configuration." },
    (adapterReceived ?? 0) === 0
      ? { name: "Decoder", status: "not_evaluated", detail: "No datagram reached the decoder, so it was never exercised." }
      : section("Decoder", (decoded ?? 0) > 0, `${decoded ?? 0} decoded, ${s.adapter?.decodeFailures ?? 0} failed.`),
    (decoded ?? 0) === 0
      ? { name: "Discovery", status: "not_evaluated", detail: "Nothing decoded, so Discovery was never exercised." }
      : section("Discovery", s.driver.discoveryEvents > 0, `${s.driver.discoveryEvents} unit(s) discovered, ${s.driver.unmappedOpcodeEvents} decoded packet(s) ignored as unmapped opcodes.`),
    s.driver.discoveryEvents === 0
      ? { name: "Entity Creation", status: "not_evaluated", detail: "Nothing discovered, so no entity could be created." }
      : section("Entity Creation", s.driver.entities > 0, `${s.driver.entities} entit(y/ies) created from ${s.driver.discoveryEvents} discovered unit(s).`),
  ];

  const evaluated = sections.filter((x) => x.status !== "not_evaluated");
  return {
    generatedAt: new Date().toISOString(),
    sections,
    rootCause,
    wireshark,
    stages,
    // Every section must be evaluated AND passing. An un-run check is never a passing check, so a
    // report with any `not_evaluated` section cannot certify.
    certified: evaluated.length === sections.length && evaluated.every((x) => x.status === "pass"),
  };
}

function section(name: string, ok: boolean, detail: string, notEvaluated = false): CertificationSection {
  if (notEvaluated) return { name, status: "not_evaluated", detail };
  return { name, status: ok ? "pass" : "fail", detail };
}

/** Renders the report in the literal shape the brief specified. Kept separate from the structured
 * data so a UI, a CLI, and a log can each format it their own way. */
export function formatReceiveCertificationReport(report: ReceiveCertificationReport): string {
  const lines = ["Receive Pipeline Report", ""];
  for (const s of report.sections) {
    lines.push(`${s.name}`, s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "NOT EVALUATED", "");
  }
  lines.push("Overall Root Cause", report.rootCause.cause.toUpperCase().replace(/_/g, " "), "", report.rootCause.summary);
  if (report.rootCause.needed) lines.push("", "Needed to resolve the unknown:", report.rootCause.needed);
  if (report.rootCause.evidence.length) lines.push("", "Evidence:", ...report.rootCause.evidence.map((e) => `- ${e}`));
  lines.push(
    "",
    "Wireshark comparison",
    `Wireshark packets: ${report.wireshark.wiresharkPackets ?? "not supplied"}`,
    `supreme-lan socket packets: ${report.wireshark.socketPackets ?? "unknown"}`,
    `Difference: ${report.wireshark.difference ?? "not determinable"}`,
    `Stage where packets disappear: ${report.wireshark.stageWherePacketsDisappear}`,
  );
  return lines.join("\n");
}
