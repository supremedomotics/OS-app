import { booleanStage, countedStage, type PipelineStage } from "../core/pipeline-stages.js";
import type { CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

/**
 * § LAN receive-path investigation — the Casambi receive pipeline as a PASS/FAIL/WAITING
 * checklist, derived entirely from an already-collected `CasambiTransportMonitorSnapshot`. No new
 * measurement is taken here and nothing is inferred beyond what the counters actually say.
 *
 * Stage list matches the pipeline the investigation brief asked to be proven, in order:
 * Socket → Listening → Receiving → Publishing → Decoding → Discovery → Entities.
 *
 * The distinction that matters: "Receiving" is backed by a real received-packet counter, never by
 * the socket having bound successfully. A bound socket that receives nothing is the exact silent
 * Docker-bridge failure mode, and it renders as WAITING with the reason spelled out — never as a
 * green tick.
 */
export function casambiPipelineStages(snapshot: CasambiTransportMonitorSnapshot): PipelineStage[] {
  const t = snapshot.transport;
  const a = snapshot.adapter;
  const d = snapshot.driver;

  if (snapshot.connectionType !== "local" || !t) {
    // Cloud mode has no UDP pipeline at all — report that honestly rather than showing seven
    // inapplicable rows.
    return [{ name: "UDP pipeline", status: "waiting", detail: "Not applicable — driver is in Cloud mode, which uses REST/WebSocket, not UDP." }];
  }

  const received = a?.packetsReceived ?? 0;
  const stages: PipelineStage[] = [
    booleanStage("Socket", t.localPort !== null, {
      passDetail: `Created and bound${t.localAddress ? ` on ${t.localAddress}:${t.localPort}` : ""}`,
      failDetail: "No socket has been created — the driver has not connected yet.",
    }),
    booleanStage("Listening", t.listening, {
      passDetail: `Listening via ${t.backend} transport`,
      failDetail: t.lastError ?? "Socket is not listening and no error was reported.",
    }),
    countedStage("Receiving", received, {
      waitingDetail:
        "Socket is bound but NO datagram has arrived yet. If the gateway is confirmed to be broadcasting (e.g. visible in Wireshark on the host), the most likely cause is that supreme-lan is on Docker bridge networking, which does not deliver LAN broadcast/multicast into containers — deploy with docker-compose.lan-host.yml on Linux. See docs/architecture/Casambi-LAN-Receive-Path-Investigation.md.",
      passDetail: (n) => `${n} datagram(s) received`,
    }),
    countedStage("Publishing (NATS)", t.backend === "nats" ? (t.packetsReceived ?? 0) : received, {
      waitingDetail:
        t.backend === "nats"
          ? "No datagram has been republished over NATS yet — nothing has been received to publish."
          : "Not applicable — transport is local-direct (same process), so there is no NATS hop.",
      passDetail: (n) => `${n} datagram(s) delivered over the ${t.backend} transport`,
    }),
    countedStage("Decoding", a?.decoded ?? 0, {
      waitingDetail:
        (a?.decodeFailures ?? 0) > 0
          ? `${a?.decodeFailures} datagram(s) arrived but NONE decoded — likely a Net ID or Data Format mismatch with the gateway's own setting. Last error: ${a?.lastDecodeError?.message ?? "unknown"}`
          : "Nothing decoded yet — no datagram has arrived to decode.",
      passDetail: (n) => `${n} packet(s) decoded successfully`,
    }),
    countedStage("Discovery", d.discoveryEvents, {
      waitingDetail:
        d.unmappedOpcodeEvents > 0
          ? `Packets decoded, but the opcode(s) seen are not mapped to a discovery signal (last: 0x${(d.lastUnmappedOpcode ?? 0).toString(16)}). Discovery reacts to NotifyControlValues (0x4B); other opcodes are ignored by design.`
          : "No unit discovered yet. Discovery is automatic and begins with the first NotifyControlValues notification.",
      passDetail: (n) => `${n} unit(s) discovered`,
    }),
    countedStage("Entities", d.entities, {
      waitingDetail: "No entity created yet — entities are created from discovered units.",
      passDetail: (n) => `${n} entit(y/ies) created`,
    }),
  ];
  return stages;
}
