import os from "node:os";
import type { LanDiagnosticsSnapshot, LanSessionDiagnostics } from "../shared/wire-types.js";
import type { LanDeployment } from "./deployment.js";

/**
 * Builds the service-wide diagnostics snapshot (§ Production Architecture Refactor — "Move
 * transport diagnostics into supreme-lan").
 *
 * The deployment is read from this service's OWN configuration (`SUPREME_LAN_DEPLOYMENT`, see
 * `deployment.ts`), never inferred from OS network interfaces: a process cannot reliably determine
 * from inside its own network namespace whether it shares the host's — the interface lists look
 * alike either way — so guessing would violate this codebase's "never fabricate a fact it cannot
 * verify" rule. This snapshot reports exactly the configured value, plus the deployment-neutral
 * `lanAccess` derived from it (the property that actually matters and that holds identically for a
 * native SupremeOS service, a VM, or a container).
 */
export interface LanHealthInputs {
  /** § Production Architecture Direction — the configured deployment (see `deployment.ts`).
   * Deployment vocabulary lives in that one module; this snapshot just reports it. */
  deployment: LanDeployment;
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
    deployment: inputs.deployment.id,
    deploymentLabel: inputs.deployment.label,
    lanAccess: inputs.deployment.lanAccess,
    natsConnected: inputs.natsConnected,
    uptimeSec: Math.round((Date.now() - inputs.startedAt) / 1000),
    interfaces,
    sessions: inputs.sessions,
  };
}
