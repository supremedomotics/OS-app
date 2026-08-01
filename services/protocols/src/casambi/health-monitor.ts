import type { CasambiConnectionMode } from "./connection-manager.js";

/**
 * Casambi Health Monitor (§ Casambi Driver Refactor — Foundation "Health Monitor"; § PR-2 Local
 * Gateway Foundation). Defines the per-subsystem status vocabulary (Cloud/REST/UDP/Gateway) and
 * computes one overall verdict from it — the same verdict the Diagnostics module and the Driver
 * Manager's generic health endpoint both surface. The actual heartbeat interval/reconnect-backoff
 * timers stay owned by the driver itself (this module doesn't reimplement timing — see
 * `casambi-driver.ts`'s `startHeartbeat`/`scheduleReconnect`, unchanged from before this refactor)
 * so the tested Cloud reconnect behavior can't regress from being routed through an extra layer.
 */

export type CasambiSubsystemStatus = "connected" | "disconnected" | "not_configured" | "not_implemented";

export interface CasambiHealthInputs {
  mode: CasambiConnectionMode;
  /** Cloud: the WebSocket wire's connected state. Local: the UDP socket's bound/listening state
   * (`CasambiUdpEngine.listening`) — a real signal now, not a placeholder. */
  connected: boolean;
  /** Whether this driver has ever completed authentication+wire-open (Cloud) or UDP socket bind
   * (Local) at least once. */
  hasConnectedBefore: boolean;
  lastError: string | null;
}

export type CasambiHealthVerdict = "healthy" | "degraded" | "error" | "not_implemented";

/** One overall verdict from every subsystem's status — the same rule the Diagnostics page and
 * the Driver Manager's generic `/v1/drivers/:id/health` endpoint both want, kept in one place so
 * they can never silently disagree. Identical logic for Cloud and Local now that both modes have
 * a real `connected` signal — UDP being connectionless just means "connected" means "socket bound
 * and listening" rather than "handshake acknowledged," which `computeHealthVerdict` doesn't need
 * to know about. */
export function computeHealthVerdict(inputs: CasambiHealthInputs): CasambiHealthVerdict {
  if (inputs.connected) return "healthy";
  if (inputs.hasConnectedBefore) return inputs.lastError ? "error" : "degraded";
  return "degraded";
}

/** REST subsystem status. Cloud: the real session/wire connection state. Local: the Lithernet
 * Gateway's documented REST surface is a single stateless write endpoint (`/set/target_value`,
 * `local-transport/rest-client.ts`) with no persistent connection to hold open — `"not_configured"`
 * here honestly means "nothing to report a live connection state for," not "unimplemented." */
export function restSubsystemStatus(mode: CasambiConnectionMode, connected: boolean): CasambiSubsystemStatus {
  if (mode === "local") return "not_configured";
  return connected ? "connected" : "disconnected";
}

/** UDP subsystem status. Cloud has no UDP concept at all (`"not_configured"`). Local: the real
 * UDP Casambi Command engine's bound/listening state (`local-transport/udp-engine.ts`). */
export function udpSubsystemStatus(mode: CasambiConnectionMode, connected: boolean): CasambiSubsystemStatus {
  if (mode !== "local") return "not_configured";
  return connected ? "connected" : "disconnected";
}
