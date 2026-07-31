import type { CasambiConnectionMode } from "./connection-manager.js";

/**
 * Casambi Health Monitor (§ Casambi Driver Refactor — Foundation "Health Monitor: Framework
 * only"). Defines the per-subsystem status vocabulary (Cloud/REST/UDP/Gateway) and computes one
 * overall verdict from it — the same verdict the Diagnostics module and the Driver Manager's
 * generic health endpoint both surface. Framework only in this release: REST/UDP subsystems that
 * don't exist yet (Local Gateway) always report `"not_implemented"`, never a fabricated status.
 * The actual heartbeat interval/reconnect-backoff timers stay owned by the driver itself (this
 * module doesn't reimplement timing — see `casambi-driver.ts`'s `startHeartbeat`/
 * `scheduleReconnect`, unchanged from before this refactor) so the tested Cloud reconnect
 * behavior can't regress from being routed through an extra layer.
 */

export type CasambiSubsystemStatus = "connected" | "disconnected" | "not_configured" | "not_implemented";

export interface CasambiHealthInputs {
  mode: CasambiConnectionMode;
  /** Cloud: the WebSocket wire's connected state. Local: always false (nothing implemented). */
  connected: boolean;
  /** Whether this driver has ever completed authentication+wire-open at least once. */
  hasConnectedBefore: boolean;
  lastError: string | null;
}

export type CasambiHealthVerdict = "healthy" | "degraded" | "error" | "not_implemented";

/** One overall verdict from every subsystem's status — the same rule the Diagnostics page and
 * the Driver Manager's generic `/v1/drivers/:id/health` endpoint both want, kept in one place so
 * they can never silently disagree. */
export function computeHealthVerdict(inputs: CasambiHealthInputs): CasambiHealthVerdict {
  if (inputs.mode === "local") return "not_implemented";
  if (inputs.connected) return "healthy";
  if (inputs.hasConnectedBefore) return inputs.lastError ? "error" : "degraded";
  return "degraded";
}

/** REST subsystem status. Cloud: the real session/wire connection state. Local: always
 * `"not_implemented"` in this release — see `local-transport/rest-client.ts`. */
export function restSubsystemStatus(mode: CasambiConnectionMode, connected: boolean): CasambiSubsystemStatus {
  if (mode === "local") return "not_implemented";
  return connected ? "connected" : "disconnected";
}

/** UDP subsystem status. Cloud has no UDP concept at all (`"not_configured"`). Local: always
 * `"not_implemented"` in this release — see `local-transport/udp-engine.ts`. Kept as a function
 * (not a constant) so PR-3 only needs to change the body here, never any caller. */
export function udpSubsystemStatus(mode: CasambiConnectionMode): "not_implemented" | "not_configured" {
  return mode === "local" ? "not_implemented" : "not_configured";
}
