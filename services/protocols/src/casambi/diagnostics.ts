import { capabilitiesFromUnit, type CasambiUnit } from "./entity-mapper.js";
import type { CasambiConnectionMode } from "./connection-manager.js";
import {
  computeHealthVerdict,
  restSubsystemStatus,
  udpSubsystemStatus,
  type CasambiHealthVerdict,
  type CasambiSubsystemStatus,
} from "./health-monitor.js";

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
    health: computeHealthVerdict({
      mode: inputs.mode,
      connected: inputs.connected,
      hasConnectedBefore: inputs.hasConnectedBefore,
      lastError: inputs.lastError,
    }),
  };
}
