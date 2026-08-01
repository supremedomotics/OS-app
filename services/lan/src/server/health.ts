import os from "node:os";
import type { LanDiagnosticsSnapshot, LanSessionDiagnostics } from "../shared/wire-types.js";

/**
 * Builds the service-wide diagnostics snapshot (§ Production Architecture Refactor — "Move
 * transport diagnostics into supreme-lan"). `networkMode` is read from this service's OWN
 * configuration, never inferred from OS network interfaces: whether a container is genuinely on
 * `network_mode: host` cannot be reliably self-detected from inside it (interface lists look
 * similar in both cases), so guessing would violate this codebase's "never fabricate a fact it
 * cannot verify" rule. The deploying Compose file sets `SUPREME_LAN_NETWORK_MODE` explicitly (see
 * `infra/hub-compose/docker-compose.lan-host.yml`), and this snapshot honestly reports exactly
 * that configured value.
 */
export interface LanHealthInputs {
  networkMode: "bridge" | "host" | "macvlan";
  natsConnected: boolean;
  startedAt: number;
  sessions: LanSessionDiagnostics[];
}

export function buildDiagnosticsSnapshot(inputs: LanHealthInputs): LanDiagnosticsSnapshot {
  const interfaces: LanDiagnosticsSnapshot["interfaces"] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4") interfaces.push({ name, address: addr.address, internal: addr.internal });
    }
  }
  return {
    networkMode: inputs.networkMode,
    natsConnected: inputs.natsConnected,
    uptimeSec: Math.round((Date.now() - inputs.startedAt) / 1000),
    interfaces,
    sessions: inputs.sessions,
  };
}
