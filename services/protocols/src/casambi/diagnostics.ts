import { capabilitiesFromUnit, type CasambiUnit } from "./entity-mapper.js";
import type { CasambiConnectionMode } from "./connection-manager.js";
import {
  computeHealthVerdict,
  restSubsystemStatus,
  udpStage,
  udpSubsystemStatus,
  type CasambiHealthVerdict,
  type CasambiSubsystemStatus,
  type CasambiUdpStage,
} from "./health-monitor.js";

/**
 * Real, non-fabricated UDP transport detail (§ UDP Diagnostics audit — "expose additional
 * information... never fabricate values"). `null` fields mean "not yet measured," never a guess.
 * `packetLoss` has no getter at all on the source engine and is intentionally absent here too —
 * the documented Casambi UDP packet structure (`{length, opcode, args}`) carries no sequence
 * numbers, so ongoing packet loss cannot be computed honestly for the general notification
 * stream. `averageLatencyMs` reflects only measured `probe()` round-trips, never the (unmeasurable)
 * latency of unsolicited notifications.
 */
export interface CasambiUdpDetail {
  stage: CasambiUdpStage;
  socketState: "closed" | "bound" | "error";
  localAddress: string | null;
  localPort: number | null;
  remoteAddress: string;
  remotePort: number;
  packetsSent: number;
  packetsReceived: number;
  lastPacketAt: string | null;
  averageLatencyMs: number | null;
  lastSendError: string | null;
  lastDecodeError: { raw: string; message: string; at: string } | null;
}

/**
 * Casambi Diagnostics (§ Casambi Driver Refactor — Foundation "Diagnostics: dedicated diagnostics
 * page"). One immutable snapshot, transport-independent (every field applies to both Cloud and
 * Local — the difference is only in the values, never the shape), consumed by the gateway route
 * and the Driver Manager's Casambi diagnostics panel.
 */
export interface CasambiDiagnosticsSnapshot {
  connectionType: CasambiConnectionMode;
  /** Cloud: the network name. Local: `ip:restPort`. `null` before the first successful fetch. */
  gateway: string | null;
  /** Round-trip of the last heartbeat ping, in ms. `null` when never measured. */
  latencyMs: number | null;
  /** Total discovered entities (units mapped to at least one Supreme capability). */
  entities: number;
  onlineDevices: number;
  offlineDevices: number;
  reconnectCount: number;
  lastEventAt: string | null;
  restStatus: CasambiSubsystemStatus;
  udpStatus: CasambiSubsystemStatus;
  health: CasambiHealthVerdict;
  /** Real UDP transport detail, Local mode only. `null` for Cloud (no UDP concept) or before the
   * Local transport has been constructed. See {@link CasambiUdpDetail}. */
  udp: CasambiUdpDetail | null;
}

export interface CasambiDiagnosticsInputs {
  mode: CasambiConnectionMode;
  gateway: string | null;
  connected: boolean;
  hasConnectedBefore: boolean;
  latencyMs: number | null;
  units: ReadonlyMap<number, CasambiUnit>;
  reconnects: number;
  lastEventAt: string | null;
  lastError: string | null;
  /** Raw UDP engine getters, Local mode only — `buildDiagnosticsSnapshot` derives the honest
   * `stage` from these rather than accepting a pre-computed one, so every caller gets the same
   * never-fabricated staging logic. */
  udp?: {
    socketState: "closed" | "bound" | "error";
    localAddress: string | null;
    localPort: number | null;
    remoteAddress: string;
    remotePort: number;
    packetsSent: number;
    packetsReceived: number;
    lastPacketAt: string | null;
    averageLatencyMs: number | null;
    lastSendError: string | null;
    lastDecodeError: { raw: string; message: string; at: string } | null;
  } | null;
}

export function buildDiagnosticsSnapshot(inputs: CasambiDiagnosticsInputs): CasambiDiagnosticsSnapshot {
  let entities = 0;
  let onlineDevices = 0;
  let offlineDevices = 0;
  for (const unit of inputs.units.values()) {
    if (capabilitiesFromUnit(unit).length === 0) continue;
    entities += 1;
    if (unit.online === true) onlineDevices += 1;
    else if (unit.online === false) offlineDevices += 1;
  }
  return {
    connectionType: inputs.mode,
    gateway: inputs.gateway,
    latencyMs: inputs.latencyMs,
    entities,
    onlineDevices,
    offlineDevices,
    reconnectCount: inputs.reconnects,
    lastEventAt: inputs.lastEventAt,
    restStatus: restSubsystemStatus(inputs.mode, inputs.connected),
    udpStatus: udpSubsystemStatus(inputs.mode, inputs.connected),
    udp: inputs.udp
      ? {
          stage: udpStage(inputs.mode, inputs.udp.socketState, inputs.udp.packetsReceived),
          socketState: inputs.udp.socketState,
          localAddress: inputs.udp.localAddress,
          localPort: inputs.udp.localPort,
          remoteAddress: inputs.udp.remoteAddress,
          remotePort: inputs.udp.remotePort,
          packetsSent: inputs.udp.packetsSent,
          packetsReceived: inputs.udp.packetsReceived,
          lastPacketAt: inputs.udp.lastPacketAt,
          averageLatencyMs: inputs.udp.averageLatencyMs,
          lastSendError: inputs.udp.lastSendError,
          lastDecodeError: inputs.udp.lastDecodeError,
        }
      : null,
    health: computeHealthVerdict({
      mode: inputs.mode,
      connected: inputs.connected,
      hasConnectedBefore: inputs.hasConnectedBefore,
      lastError: inputs.lastError,
    }),
  };
}
