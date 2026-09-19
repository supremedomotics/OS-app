import type { DeviceId } from "@supreme/domain-model";
import type { DevialetDeviceTopology } from "./devialet-topology.js";

/**
 * Devialet command hierarchy & target resolution (§ D7) — pure logic only, no I/O.
 * `devialet-driver.ts` is the only caller.
 *
 * § The load-bearing protocol fact this whole file is built on: the R1 doc states,
 * for `/devices/{deviceId}`, `/systems/{systemId}`, and `/groups/{groupId}` alike,
 * that "The only supported {id} today is 'current'" — a real systemId/groupId can
 * NEVER be substituted into the URL path; only the literal string `"current"` is
 * accepted, resolved by the device that RECEIVES the HTTP request (the "dispatcher,"
 * per the doc's own "The dispatcher" section: "the device that receives the API
 * command... In many cases, it forwards the API command to other devices in the
 * installation"). Concretely: sending a system-level request to Device A's own host
 * ALREADY correctly addresses System S1 (A's own current system) — there is no
 * second device to "redirect" to, and no benefit to picking a different group member,
 * since Devialet's own firmware performs any needed internal forwarding.
 *
 * "Resolving a command target" in this codebase therefore does NOT mean choosing
 * which physical host to send the HTTP request to (`devialet-driver.ts` always sends
 * to the SAME device the command was invoked against — no fan-out ever existed, so
 * there is no risk of it duplicating a request across stereo members to begin with).
 * It means: confirming the REQUIRED topology level (system for volume, group for
 * playback) is actually known for this device before sending anything — failing
 * cleanly and informatively when it isn't, per the D7 brief's explicit requirement —
 * and carrying the resolved id through for tracing/diagnostics. The resolved id is
 * NEVER substituted into the R1 request itself (see above).
 */

/** Which topology level an R1 operation is scoped to, per the doc: volume (+ up/down)
 * is system-level (`/systems/{systemId}/sources/current/soundControl/...`);
 * play/pause/stop/next/previous/mute/unmute/source-selection are group-level
 * (`/groups/{groupId}/sources/.../playback/...`). */
export type DevialetCommandLevel = "system" | "group";

/**
 * Maps a Supreme `CapabilityCommand` media `action` to its Devialet topology level.
 * `"unsupported"` covers every action with no real R1 mapping — including `"seek"`:
 * the R1 doc lists `"seek"` as a possible `availableOperations` VALUE but documents
 * NO endpoint or payload for actually performing it anywhere in this revision (§11 of
 * the D7 brief — "if the documentation does not fully specify a required detail, do
 * not guess... stop that sub-feature"). `"shuffle"`/`"repeat"`/`"advanced"` have no
 * R1 concept at all.
 */
export function devialetCommandLevelFor(action: string): DevialetCommandLevel | "unsupported" {
  switch (action) {
    case "volume":
      return "system";
    case "play":
    case "pause":
    case "stop":
    case "next":
    case "previous":
    case "mute":
    case "unmute":
    case "source":
      return "group";
    default:
      return "unsupported";
  }
}

export type DevialetCommandRoutingFailureReason =
  /** `refreshTopology()` has never successfully resolved this device's real
   * `deviceId` — there is no topology entry to consult at all yet. */
  | "identity-unknown"
  /** This device's Devialet identity IS known, but the specific level required
   * (`systemId` for a system-level command, `groupId` for a group-level one) hasn't
   * been established — e.g. an accessory with no system, or a speaker whose system is
   * known but group enrichment hasn't landed yet (§18 of the D7 brief — partial
   * topology). */
  | "topology-unavailable";

export interface DevialetCommandRoutingFailure {
  ok: false;
  level: DevialetCommandLevel;
  reason: DevialetCommandRoutingFailureReason;
}

export interface DevialetCommandRoutingSuccess {
  ok: true;
  level: DevialetCommandLevel;
  /** The resolved `systemId` (level `"system"`) or `groupId` (level `"group"`) —
   * carried for tracing/diagnostics ONLY. Never inserted into an R1 request path (see
   * this module's own doc comment — only the literal `"current"` is ever sent). */
  targetId: string;
  devialetId: string;
}

export type DevialetCommandRoutingResult = DevialetCommandRoutingSuccess | DevialetCommandRoutingFailure;

/**
 * Resolves the topology target for one command level, given this device's current
 * (possibly `null`) topology entry. Pure — no defaulting, no guessing: a `null`
 * `devialetId` or a `null` id at the required level both fail cleanly rather than
 * substituting anything (§16/§17/§18 of the D7 brief). Never consults
 * `leaderDeviceId`/`masterSystemId` (both always `null` per D6 — see that module's
 * doc comment) — command routing depends only on `systemId`/`groupId`.
 */
export function resolveDevialetCommandTarget(level: DevialetCommandLevel, devialetId: string | null, topology: DevialetDeviceTopology | null): DevialetCommandRoutingResult {
  if (!devialetId) return { ok: false, level, reason: "identity-unknown" };
  const targetId = level === "system" ? (topology?.systemId ?? null) : (topology?.groupId ?? null);
  if (!targetId) return { ok: false, level, reason: "topology-unavailable" };
  return { ok: true, level, targetId, devialetId };
}

/** Thrown by `devialet-driver.ts`'s `command()` when `resolveDevialetCommandTarget()`
 * fails — a structured, `instanceof`-checkable failure (matching `DevialetApiError`/
 * `DevialetCiSettingsError`'s existing convention) rather than a generic `Error`,
 * satisfying the D7 brief's "return a structured unavailable result" requirement
 * within `INativeProtocolDriver.command()`'s fixed `Promise<void>` contract (which
 * cannot return a discriminated result object — it must throw). */
export class DevialetCommandRoutingError extends Error {
  readonly level: DevialetCommandLevel;
  readonly reason: DevialetCommandRoutingFailureReason;
  readonly deviceId: DeviceId;

  constructor(level: DevialetCommandLevel, reason: DevialetCommandRoutingFailureReason, deviceId: DeviceId) {
    const detail = reason === "identity-unknown" ? "this device's Devialet identity is not yet established (refreshTopology() has not succeeded for it yet)" : `this device's ${level} topology is not yet known (refreshTopology() hasn't resolved its ${level === "system" ? "systemId" : "groupId"} yet)`;
    super(`devialet: cannot route a ${level}-level command for ${deviceId} — ${detail}`);
    this.name = "DevialetCommandRoutingError";
    this.level = level;
    this.reason = reason;
    this.deviceId = deviceId;
  }
}

/** Thrown when a documented `availableOperations`-gated action (currently only
 * `"next"`/`"previous"` — see `devialet-driver.ts`'s `command()`) is rejected BEFORE
 * being sent, because the current source's real, freshly-read `availableOperations`
 * doesn't include it (§9 of the D7 brief). Distinct from the R1 protocol's own
 * `"PlaybackOperationNotAvailable"` logical error (which can still occur regardless —
 * this is a pre-flight client-side check, not a replacement for it). */
export class DevialetOperationUnavailableError extends Error {
  readonly action: string;
  readonly deviceId: DeviceId;

  constructor(action: string, deviceId: DeviceId) {
    super(`devialet: "${action}" is not in the current source's availableOperations for ${deviceId} — not sent`);
    this.name = "DevialetOperationUnavailableError";
    this.action = action;
    this.deviceId = deviceId;
  }
}
