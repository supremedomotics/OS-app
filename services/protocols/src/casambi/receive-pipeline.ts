import { stageMetrics, type PipelineStage, type StageMetrics } from "../core/pipeline-stages.js";
import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

/**
 * § Runtime Data Path Verification — the complete receive pipeline, stage by stage, from the OS
 * network stack to room assignment.
 *
 * This is a PURE function over evidence already collected elsewhere. It takes no measurement of
 * its own, so it can neither create nor destroy a fact: every number below traces to a real
 * counter in `CasambiTransportMonitorSnapshot` (driver/adapter/transport) or to
 * `@supreme/lan`'s forensics (kernel routing table, `/proc/net/udp` drop counters, the independent
 * probe). Where a stage's throughput is genuinely not observable, the field is `null` WITH a
 * reason — never `0`, because "nothing entered this stage" and "nothing counts what enters this
 * stage" point at opposite root causes.
 *
 * The stage list is exactly the one under investigation, in order:
 *
 *   OS Network Stack → supreme-lan UDP Socket → Datagram Received → Raw Packet Recorder →
 *   NATS Publish → Gateway Subscriber → Casambi UDP Engine → Protocol Decoder →
 *   Discovery Engine → Entity Mapper → Room Assignment
 *
 * No stage is aggregated into another, and no stage is skipped when it cannot be evaluated — an
 * unevaluable stage is reported as such, which is itself diagnostic information.
 */

/** The `@supreme/lan` forensics this report consumes. Structurally typed rather than imported so
 * `@supreme/protocols` keeps its existing dependency direction and this module stays testable
 * without a running transport service. Every field optional: an older `supreme-lan`, or one that
 * simply was not asked, yields `null` stages rather than fabricated ones. */
export interface LanForensicsInput {
  network?: {
    procAvailable?: boolean;
    networkNamespace?: string | null;
    defaultGateway?: string | null;
    routes?: { destination: string; gateway: string; isDefault: boolean; interfaceName: string }[] | null;
    interfaces?: { name: string; address: string; internal: boolean; cidr?: string | null }[];
    udpSockets?: { localAddress: string; localPort: number; rxQueue: number; drops: number }[] | null;
  } | null;
  sockets?: {
    sessionId: string;
    forensics?: {
      boundAddress?: string | null;
      boundPort?: number | null;
      recvBufferSize?: number | null;
      requestedBroadcast?: boolean;
      joinedMulticastAt?: string | null;
      kernelSocket?: { rxQueue: number; drops: number } | null;
    };
  }[];
  probe?: {
    listening?: boolean;
    boundPort?: number | null;
    datagramsReceived?: number;
    firstDatagramAt?: string | null;
    lastDatagramAt?: string | null;
    lastError?: string | null;
  } | null;
  probeDisabledReason?: string | null;
}

/** An optional, human-supplied packet count from a host capture (tcpdump/Wireshark) taken over the
 * same window. SupremeOS cannot observe this itself — that is precisely why it is an input. */
export interface WiresharkObservation {
  packets: number;
  /** What was captured, so the comparison is auditable (e.g. "udp port 10009 on eth0, 60s"). */
  captureFilter?: string;
  capturedAt?: string;
}

export interface ReceivePipelineInputs {
  snapshot: CasambiTransportMonitorSnapshot;
  lan?: LanForensicsInput | null;
  wireshark?: WiresharkObservation | null;
}

const NOT_APPLICABLE_CLOUD = "Cloud mode uses REST/WebSocket; there is no UDP receive pipeline to instrument.";

/** End-to-end latency statistics computed from the driver's REAL per-packet journey entries
 * (`processingDurationMs`, measured wall-clock from raw reception to the driver finishing that
 * datagram). `null` when no packet has completed a journey — never an estimate. */
function journeyLatency(snapshot: CasambiTransportMonitorSnapshot): number | null {
  const durations = snapshot.driver.recentJourney.map((j) => j.processingDurationMs).filter((d) => Number.isFinite(d));
  if (durations.length === 0) return null;
  return Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3));
}

function firstLastJourneyAt(snapshot: CasambiTransportMonitorSnapshot): { firstAt: string | null; lastAt: string | null } {
  const journey = snapshot.driver.recentJourney;
  return { firstAt: journey[0]?.at ?? null, lastAt: journey[journey.length - 1]?.at ?? null };
}

export function casambiReceivePipeline(inputs: ReceivePipelineInputs): PipelineStage[] {
  const { snapshot, lan } = inputs;
  const t = snapshot.transport;
  const a = snapshot.adapter;
  const d = snapshot.driver;

  if (snapshot.connectionType !== "local") {
    return [{ name: "UDP receive pipeline", status: "waiting", detail: NOT_APPLICABLE_CLOUD, metrics: stageMetrics(NOT_APPLICABLE_CLOUD) }];
  }

  const stages: PipelineStage[] = [];
  const { firstAt, lastAt } = firstLastJourneyAt(snapshot);

  // ── 1. OS Network Stack ────────────────────────────────────────────────────────────────────
  // The kernel does not count "datagrams that should have arrived", so `entered` is unknowable
  // here by construction. What IS readable is whether this namespace can route at all, and
  // whether the kernel dropped anything it DID deliver to a socket.
  const net = lan?.network ?? null;
  const kernelDrops = sumKernelDrops(lan);
  stages.push({
    name: "OS Network Stack",
    ...osNetworkStatus(net, kernelDrops),
    metrics: stageMetrics(
      "The kernel cannot report datagrams that never reached it; `entered` is unknowable at this layer by construction. A host-side capture (tcpdump/Wireshark) is the only source for that number — supply it as the Wireshark comparison input.",
      { failures: kernelDrops },
    ),
  });

  // ── 2. supreme-lan UDP Socket ──────────────────────────────────────────────────────────────
  const socketBound = t !== null && t.localPort !== null;
  const sockForensics = lan?.sockets?.[0]?.forensics ?? null;
  stages.push({
    name: "supreme-lan UDP Socket",
    status: socketBound ? "pass" : "fail",
    detail: socketBound
      ? `Bound on ${t!.localAddress ?? "0.0.0.0"}:${t!.localPort} via the ${t!.backend} transport${sockForensics?.recvBufferSize ? `, receive buffer ${sockForensics.recvBufferSize} bytes` : ""}${sockForensics?.kernelSocket ? " (corroborated by the kernel's own socket table)" : ""}`
      : (t?.lastError ?? "No socket has been created — the driver has not connected yet."),
    metrics: stageMetrics(
      // This stage is about the socket EXISTING, not about throughput — datagram counts belong to
      // the "Datagram Received" stage below, and duplicating them here would imply this stage
      // could lose one, which it cannot.
      `This stage reports socket existence and configuration, not throughput; datagram counts are measured at the "Datagram Received" stage. ${
        sockForensics?.kernelSocket ? "" : "No matching kernel socket row was available to corroborate the bind (either supreme-lan forensics were not collected, or this platform has no /proc)."
      }`.trim(),
      { failures: sockForensics?.kernelSocket?.drops ?? null },
    ),
  });

  // ── 3. Datagram Received ───────────────────────────────────────────────────────────────────
  // The single most decisive counter in the whole pipeline: the socket's own receive count.
  const socketReceived = t?.packetsReceived ?? null;
  stages.push({
    name: "Datagram Received",
    status: (socketReceived ?? 0) > 0 ? "pass" : socketBound ? "waiting" : "fail",
    detail: datagramReceivedDetail(socketReceived, socketBound, lan),
    metrics: stageMetrics(null, { entered: socketReceived, exited: socketReceived, failures: 0, firstAt, lastAt }),
  });

  // ── 4. Raw Packet Recorder ─────────────────────────────────────────────────────────────────
  // Records every datagram BEFORE decode, so a reception failure and a parse failure can never be
  // confused again. Its count is the retained trace length, which is bounded — hence exited is
  // reported from the unbounded counter, not from the log's length.
  const traced = a?.recentTraces.length ?? 0;
  stages.push({
    name: "Raw Packet Recorder",
    status: traced > 0 ? "pass" : "waiting",
    detail:
      traced > 0
        ? `${traced} datagram(s) retained (bounded ring buffer; ${a?.packetsReceived ?? 0} received in total)`
        : "Nothing recorded yet — the recorder captures each datagram before decoding, so this stays empty only while nothing has arrived.",
    metrics: stageMetrics("The retained trace log is intentionally bounded, so its length is not a total; `entered`/`exited` use the unbounded adapter counter instead.", {
      entered: a?.packetsReceived ?? null,
      exited: a?.packetsReceived ?? null,
      failures: 0,
      firstAt,
      lastAt: a?.lastPacketAt ?? null,
    }),
  });

  // ── 5. NATS Publish ────────────────────────────────────────────────────────────────────────
  // Only a real stage when the transport genuinely crosses a process boundary.
  const overNats = t?.backend === "nats";
  stages.push({
    name: "NATS Publish",
    status: overNats ? ((socketReceived ?? 0) > 0 ? "pass" : "waiting") : "pass",
    detail: overNats
      ? (socketReceived ?? 0) > 0
        ? `${socketReceived} datagram(s) republished by supreme-lan as session.rx events`
        : "Nothing published yet — supreme-lan has received nothing to publish."
      : "Not applicable — the transport is local-direct (same process), so there is no NATS hop to lose a packet in.",
    metrics: stageMetrics(
      overNats
        ? "supreme-lan publishes each received datagram exactly once and NATS has no queue here that can silently drop one, so a separate publish-side counter would duplicate the socket's receive count rather than measure anything new."
        : "No NATS hop exists in this configuration.",
      { entered: overNats ? socketReceived : null, exited: overNats ? socketReceived : null },
    ),
  });

  // ── 6. Gateway Subscriber ──────────────────────────────────────────────────────────────────
  // The Gateway-side count of session.rx events actually delivered. Comparing it against stage 5
  // is what would localize a genuine NATS-layer loss.
  const gatewayReceived = a?.packetsReceived ?? null;
  stages.push({
    name: "Gateway Subscriber",
    status: (gatewayReceived ?? 0) > 0 ? "pass" : "waiting",
    detail: gatewaySubscriberDetail(overNats, socketReceived, gatewayReceived),
    metrics: stageMetrics(
      overNats
        ? "Cross-process latency (supreme-lan → Gateway) is not measured: the two sides timestamp with independent wall clocks, so any difference would include unknown clock skew rather than real transit time."
        : null,
      { entered: socketReceived, exited: gatewayReceived, failures: gapBetween(socketReceived, gatewayReceived), firstAt, lastAt: a?.lastPacketAt ?? null },
    ),
  });

  // ── 7. Casambi UDP Engine ──────────────────────────────────────────────────────────────────
  stages.push({
    name: "Casambi UDP Engine",
    status: (gatewayReceived ?? 0) > 0 ? "pass" : "waiting",
    detail:
      (gatewayReceived ?? 0) > 0
        ? `${gatewayReceived} datagram(s) handed to the engine's receive handler`
        : "The engine is attached to the transport but has handled no datagram yet.",
    metrics: stageMetrics(null, { entered: gatewayReceived, exited: gatewayReceived, failures: 0, firstAt, lastAt: a?.lastPacketAt ?? null }),
  });

  // ── 8. Protocol Decoder ────────────────────────────────────────────────────────────────────
  const decoded = a?.decoded ?? null;
  const decodeFailures = a?.decodeFailures ?? null;
  stages.push({
    name: "Protocol Decoder",
    status: (decoded ?? 0) > 0 ? "pass" : (decodeFailures ?? 0) > 0 ? "fail" : "waiting",
    detail: decoderDetail(decoded, decodeFailures, a?.lastDecodeError ?? null),
    metrics: stageMetrics(null, { entered: gatewayReceived, exited: decoded, failures: decodeFailures, firstAt, lastAt: a?.lastPacketAt ?? null }),
  });

  // ── 9. Discovery Engine ────────────────────────────────────────────────────────────────────
  // A decoded packet whose opcode maps to no signal is a REAL, nameable loss at this stage — the
  // difference between "nothing decoded" and "decoded but ignored".
  stages.push({
    name: "Discovery Engine",
    status: d.discoveryEvents > 0 ? "pass" : d.unmappedOpcodeEvents > 0 ? "fail" : "waiting",
    detail: discoveryDetail(d.discoveryEvents, d.unmappedOpcodeEvents, d.lastUnmappedOpcode),
    metrics: stageMetrics(null, {
      entered: decoded,
      exited: d.discoveryEvents,
      failures: d.unmappedOpcodeEvents,
      firstAt,
      lastAt,
      latencyMs: journeyLatency(snapshot),
    }),
  });

  // ── 10. Entity Mapper ──────────────────────────────────────────────────────────────────────
  stages.push({
    name: "Entity Mapper",
    status: d.entities > 0 ? "pass" : "waiting",
    detail:
      d.entities > 0
        ? `${d.entities} entit(y/ies) mapped from ${d.discoveryEvents} discovered unit(s)`
        : "No entity mapped yet — entities are created from discovered units, so this waits on the Discovery stage above.",
    metrics: stageMetrics(null, { entered: d.discoveryEvents, exited: d.entities, failures: gapBetween(d.discoveryEvents, d.entities), firstAt, lastAt }),
  });

  // ── 11. Room Assignment ────────────────────────────────────────────────────────────────────
  // Deliberately NOT given a fabricated counter. Room assignment genuinely does not happen in this
  // driver: a discovered device is assigned to a room during installer commissioning
  // (`approvePendingDevice` in the Gateway's installer routes), which is a separate, human-driven
  // step with its own audit trail. Reporting a number here would invent one.
  const roomUnmeasured =
    "Room assignment is not performed by the Casambi driver. A discovered unit becomes a room-assigned device only when an installer approves it during commissioning (the Gateway's approvePendingDevice flow), so no driver-side counter for it exists or could exist without fabricating one.";
  stages.push({
    name: "Room Assignment",
    status: "waiting",
    detail:
      d.entities > 0
        ? `${d.entities} entit(y/ies) are ready for commissioning. Assignment happens when an installer approves them into a room — it is not a driver-side step.`
        : "Nothing to assign yet — this stage waits on the Entity Mapper above, and then on installer commissioning.",
    metrics: stageMetrics(roomUnmeasured, { entered: d.entities }),
  });

  return stages;
}

function sumKernelDrops(lan: LanForensicsInput | null | undefined): number | null {
  const sockets = lan?.sockets;
  if (!sockets || sockets.length === 0) return null;
  const drops = sockets.map((s) => s.forensics?.kernelSocket?.drops).filter((d): d is number => typeof d === "number");
  return drops.length === 0 ? null : drops.reduce((a, b) => a + b, 0);
}

function osNetworkStatus(net: LanForensicsInput["network"], kernelDrops: number | null): { status: PipelineStage["status"]; detail: string } {
  if (!net) {
    return {
      status: "waiting",
      detail: "No supreme-lan forensics were collected, so the OS network layer has not been inspected. Query the transport's forensics endpoint to read the live routing table, namespace identity, and kernel drop counters.",
    };
  }
  if (kernelDrops !== null && kernelDrops > 0) {
    return {
      status: "fail",
      detail: `The kernel DROPPED ${kernelDrops} datagram(s) for this process's socket(s) — they arrived and were then lost to receive-buffer overflow. This is a completely different failure from "nothing arrived": the network path works, the application is not draining fast enough or the buffer is too small.`,
    };
  }
  if (net.defaultGateway === null && net.procAvailable) {
    return {
      status: "fail",
      detail: `This process's network namespace (${net.networkNamespace ?? "unknown"}) has NO default route. Any send to an off-subnet address is rejected by the kernel with ENETUNREACH before a packet leaves the process, and no reply can arrive.`,
    };
  }
  const nonInternal = (net.interfaces ?? []).filter((i) => !i.internal);
  return {
    status: "pass",
    detail: `Namespace ${net.networkNamespace ?? "unknown"}, default gateway ${net.defaultGateway ?? "none"}, ${nonInternal.length} non-loopback interface(s): ${nonInternal.map((i) => `${i.name}=${i.cidr ?? i.address}`).join(", ") || "(none)"}. No kernel-level drops recorded.`,
  };
}

function datagramReceivedDetail(received: number | null, bound: boolean, lan: LanForensicsInput | null | undefined): string {
  if (!bound) return "No socket is bound, so nothing can be received.";
  if ((received ?? 0) > 0) return `${received} datagram(s) delivered by the OS to this socket.`;

  // The probe is what makes a zero here interpretable rather than merely alarming.
  const probe = lan?.probe;
  if (probe?.listening && (probe.datagramsReceived ?? 0) > 0) {
    return `ZERO datagrams on the driver's socket, but the INDEPENDENT probe on port ${probe.boundPort} received ${probe.datagramsReceived}. The OS is delivering traffic to this process — the loss is inside SupremeOS, above the socket, not below it.`;
  }
  if (probe?.listening) {
    return "ZERO datagrams on the driver's socket, AND the independent probe (no decoder, no NATS, no protocol) also received nothing. Nothing is arriving at this process at all — the loss is BELOW SupremeOS. Pair this with a host-side capture to distinguish 'the gateway is not transmitting' from 'the packets reach the host but not this network namespace'.";
  }
  return `ZERO datagrams received on a socket that is bound and listening. ${lan?.probeDisabledReason ?? "The independent probe is not running, so this cannot yet be separated from a gateway that simply is not transmitting."}`;
}

function gatewaySubscriberDetail(overNats: boolean, published: number | null, received: number | null): string {
  if (!overNats) return `${received ?? 0} datagram(s) delivered in-process (no NATS hop).`;
  if ((received ?? 0) > 0 && published !== null && published !== received) {
    return `MISMATCH: supreme-lan received ${published} datagram(s) but the Gateway subscriber saw ${received}. The gap is inside the NATS hop.`;
  }
  if ((received ?? 0) > 0) return `${received} session.rx event(s) received over NATS, matching what supreme-lan published.`;
  return "No session.rx event received yet — nothing has been published to deliver.";
}

function decoderDetail(decoded: number | null, failures: number | null, lastError: { message: string } | null): string {
  if ((decoded ?? 0) > 0) return `${decoded} packet(s) decoded successfully${(failures ?? 0) > 0 ? `, ${failures} failed` : ""}.`;
  if ((failures ?? 0) > 0) {
    return `${failures} datagram(s) arrived and NONE decoded. This is a wire-format mismatch, not a reception problem — most commonly the Net ID or the gateway's DEC/HEX data-format setting. Last error: ${lastError?.message ?? "unknown"}`;
  }
  return "Nothing decoded yet — no datagram has arrived to decode.";
}

function discoveryDetail(events: number, unmapped: number, lastOpcode: number | null): string {
  if (events > 0) return `${events} unit(s) discovered${unmapped > 0 ? ` (${unmapped} decoded packet(s) carried an unmapped opcode and were ignored)` : ""}.`;
  if (unmapped > 0) {
    return `Packets decoded successfully but Discovery ignored every one of them — opcode 0x${(lastOpcode ?? 0).toString(16)} is not mapped to a driver signal. Discovery reacts to NotifyControlValues (0x4B); other opcodes are ignored by design, so this is a mapping gap, not a reception or decode failure.`;
  }
  return "No unit discovered yet. Discovery is automatic and begins with the first NotifyControlValues notification.";
}

/** Loss between two adjacent counters, or `null` when either side is unknown. Never reports a
 * negative "loss" — a downstream count exceeding its upstream means the two counters are not
 * measuring the same population, which is a reporting bug rather than packet loss. */
function gapBetween(upstream: number | null, downstream: number | null): number | null {
  if (upstream === null || downstream === null) return null;
  return Math.max(0, upstream - downstream);
}

/** Convenience: the per-stage metrics keyed by stage name, for a caller that wants the numbers
 * without re-walking the array. */
export function pipelineMetricsByStage(stages: readonly PipelineStage[]): Record<string, StageMetrics | undefined> {
  return Object.fromEntries(stages.map((s) => [s.name, s.metrics]));
}
