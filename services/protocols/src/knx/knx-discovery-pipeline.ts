import { booleanStage, countedStage, type PipelineStage } from "../core/pipeline-stages.js";
import type { KnxDiscoveryDiagnostics } from "../knx-discovery.js";

/**
 * § LAN receive-path investigation — the KNX/IP discovery pipeline as a PASS/FAIL/WAITING
 * checklist, from one real `knxSearch()` run's observed outcomes.
 *
 * The stage this exists for is "Joined Multicast" vs "Received Search Response". Those were
 * previously indistinguishable to an installer: the join succeeds, no error is raised, zero
 * gateways are listed, and nothing on screen explains why. Verified experimentally on real Docker
 * that a bridge-networked container joins `224.0.23.12` successfully and receives NOTHING, while
 * the identical code on host networking receives traffic — so a green "multicast joined" tick was
 * actively misleading. Reception is now its own stage backed by a real datagram counter.
 */
export function knxDiscoveryStages(d: KnxDiscoveryDiagnostics): PipelineStage[] {
  return [
    booleanStage("Socket", d.socketBound, {
      passDetail: "Created and bound",
      failDetail: "The discovery socket never bound — check for a port conflict on 3671 or a permissions restriction.",
    }),
    booleanStage("Joined Multicast", d.joinedMulticast, {
      passDetail: "224.0.23.12 membership accepted (note: acceptance does not guarantee delivery)",
      failDetail: d.joinError ?? "The multicast join failed.",
    }),
    countedStage("Received Search Response", d.datagramsReceived, {
      waitingDetail:
        "The multicast group was joined and the SEARCH_REQUEST was sent, but NO datagram came back. If a KNX/IP gateway is confirmed present on this LAN, the most likely cause is that this process is running in a Docker container on bridge networking, which accepts the multicast join but never delivers multicast in from the physical LAN. See docs/architecture/Casambi-LAN-Receive-Path-Investigation.md.",
      passDetail: (n) => `${n} datagram(s) received`,
    }),
    countedStage("Gateway Parsed", d.searchResponsesParsed, {
      waitingDetail:
        d.datagramsReceived > 0
          ? `${d.datagramsReceived} datagram(s) arrived but none parsed as a KNXnet/IP SEARCH_RESPONSE — unexpected traffic on the discovery port.`
          : "Nothing received to parse.",
      passDetail: (n) => `${n} SEARCH_RESPONSE frame(s) parsed`,
    }),
    countedStage("Gateway Created", d.gatewaysFound, {
      waitingDetail: "No KNX/IP gateway has been listed yet.",
      passDetail: (n) => `${n} gateway(s) discovered`,
    }),
  ];
}
