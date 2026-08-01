import type { CasambiUdpPacketTrace, CasambiUdpTransportDiagnostics } from "./local-transport/index.js";
import type { CasambiConnectionMode } from "./connection-manager.js";

/**
 * § LAN Transport Phase 2 — Transport Monitor. The "developer-grade" layered debugging view
 * requested to become the primary tool for diagnosing a LAN protocol end-to-end: each section is
 * this codebase's own honest view of ONE layer (raw transport → this adapter → the driver), so a
 * real failure ("packets never arrive") can be localized to the exact layer that stops seeing
 * them, instead of guessed at. Every field here is a real, currently-tracked counter or state —
 * nothing is estimated or backfilled. Fields this codebase genuinely cannot measure (packet loss
 * with no sequence numbers, NATS "dropped" messages with no queue that can drop one, broadcast-vs-
 * unicast reception counts since nothing filters by destination) are simply absent rather than
 * reported as a fabricated `0`. Cloud mode has no UDP transport at all — `transport`/`adapter` are
 * `null` there, never a placeholder shaped like a real one.
 */
export interface CasambiTransportSectionSnapshot {
  /** Which concrete `UdpTransport` this engine is actually bound to right now — derived from the
   * real class, not from config, so a misconfigured/unexpected wiring is visible as `"unknown"`
   * rather than silently assumed. */
  backend: "local-direct" | "nats" | "unknown";
  listening: boolean;
  localAddress: string | null;
  localPort: number | null;
  /** Real send/receive counts as the TRANSPORT itself reports them — compare against `adapter`
   * below; a mismatch pinpoints whether a gap is in the transport or in this adapter's handling. */
  packetsSent: number | null;
  packetsReceived: number | null;
  lastError: string | null;
}

export interface CasambiAdapterSectionSnapshot {
  packetsReceived: number;
  decoded: number;
  decodeFailures: number;
  lastPacketAt: string | null;
  lastDecodeError: { raw: string; message: string; at: string } | null;
  /** The same bounded (last 20) real protocol trace already surfaced in `CasambiDiagnosticsSnapshot`
   * — repeated here so the Transport Monitor is a self-contained one-stop view. */
  recentTraces: readonly CasambiUdpPacketTrace[];
}

/**
 * § Final Hardware Validation — Packet Trace. One entry per datagram the DRIVER processed
 * (bounded, last 20, same convention as `CasambiUdpPacketTrace`), recording what happened to it
 * AFTER decode — the piece `CasambiUdpPacketTrace` can't see, since the engine has no visibility
 * into driver-level dispatch by design (one-way layering: driver knows about the engine, never
 * the reverse). `processingDurationMs` is measured wall-clock time from raw reception
 * (`onRawDatagram`) to the driver finishing its handling of that same datagram — everything in
 * this codebase's receive path is synchronous JS, so this is a real, not simulated, measurement.
 */
export interface CasambiPacketJourneyEntry {
  at: string;
  sourceAddress: string;
  sourcePort: number;
  rawAscii: string;
  decoded: boolean;
  decodeError: string | null;
  /** Hex opcode once decoded, `null` if decode failed. */
  opcode: number | null;
  /** Which `CasambiSignal.kind` `normalizeLocalPacket` produced and this driver acted on, or
   * `null` if decode failed or the opcode wasn't mapped (see `outcome`). */
  handlerInvoked: string | null;
  outcome: "mapped" | "unmapped_opcode" | "decode_failed";
  processingDurationMs: number;
}

export interface CasambiDriverSectionSnapshot {
  entities: number;
  /** Count of units that were NEW the first time this driver ever saw them (Local: first
   * NotifyControlValues packet; Cloud: first REST fetch or `unitChanged` event) — a real,
   * lifetime counter, not a point-in-time entity count (see `entities` for that). */
  discoveryEvents: number;
  /** Count of `command()` calls this driver has successfully dispatched to the command engine. */
  commandsIssued: number;
  /** Count of real, changed capability states this driver has recorded from incoming
   * feedback (Cloud `unitChanged` events or Local `NotifyControlValues` packets) — deduplicated
   * the same way `getState()`'s cache is (identical repeated state is not counted again). */
  feedbackEvents: number;
  /** § Final Hardware Validation — Local mode only. Count of datagrams that decoded successfully
   * (the Adapter section's `decoded` counter includes these) but whose opcode
   * `normalizeLocalPacket` doesn't map to any driver signal, so nothing downstream (discovery,
   * entities, UI) ever saw them. The exact, nameable failure this codebase's Failure Analysis
   * report looks for: "Adapter decoded, Discovery ignored packet — opcode 0xXX not mapped." */
  unmappedOpcodeEvents: number;
  /** The most recent such opcode, or `null` if none has occurred. */
  lastUnmappedOpcode: number | null;
  /** § Final Hardware Validation — Packet Trace. Empty array in Cloud mode (no per-datagram
   * journey concept there). */
  recentJourney: readonly CasambiPacketJourneyEntry[];
}

export interface CasambiTransportMonitorSnapshot {
  connectionType: CasambiConnectionMode;
  transport: CasambiTransportSectionSnapshot | null;
  adapter: CasambiAdapterSectionSnapshot | null;
  driver: CasambiDriverSectionSnapshot;
}

export interface CasambiTransportMonitorInputs {
  mode: CasambiConnectionMode;
  entities: number;
  discoveryEvents: number;
  commandsIssued: number;
  feedbackEvents: number;
  unmappedOpcodeEvents: number;
  lastUnmappedOpcode: number | null;
  recentJourney: readonly CasambiPacketJourneyEntry[];
  local: {
    listening: boolean;
    localAddress: string | null;
    localPort: number | null;
    transportDiagnostics: CasambiUdpTransportDiagnostics | null;
    packetsReceived: number;
    decoded: number;
    decodeFailures: number;
    lastPacketAt: string | null;
    lastDecodeError: { raw: string; message: string; at: string } | null;
    recentTraces: readonly CasambiUdpPacketTrace[];
  } | null;
}

export function buildTransportMonitorSnapshot(inputs: CasambiTransportMonitorInputs): CasambiTransportMonitorSnapshot {
  const local = inputs.local;
  return {
    connectionType: inputs.mode,
    transport: local
      ? {
          backend: local.transportDiagnostics?.backend ?? "unknown",
          listening: local.listening,
          localAddress: local.localAddress,
          localPort: local.localPort,
          packetsSent: local.transportDiagnostics?.packetsSent ?? null,
          packetsReceived: local.transportDiagnostics?.packetsReceived ?? null,
          lastError: local.transportDiagnostics?.lastError ?? null,
        }
      : null,
    adapter: local
      ? {
          packetsReceived: local.packetsReceived,
          decoded: local.decoded,
          decodeFailures: local.decodeFailures,
          lastPacketAt: local.lastPacketAt,
          lastDecodeError: local.lastDecodeError,
          recentTraces: local.recentTraces,
        }
      : null,
    driver: {
      entities: inputs.entities,
      discoveryEvents: inputs.discoveryEvents,
      commandsIssued: inputs.commandsIssued,
      feedbackEvents: inputs.feedbackEvents,
      unmappedOpcodeEvents: inputs.unmappedOpcodeEvents,
      lastUnmappedOpcode: inputs.lastUnmappedOpcode,
      recentJourney: inputs.recentJourney,
    },
  };
}
