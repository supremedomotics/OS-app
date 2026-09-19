/**
 * (§2 Phase 3A — pairing state machine) Explicit, exhaustive states + legal transitions
 * for one Agent's relationship to SupremeOS — deliberately separate from
 * `TvSessionState` (tv-types.ts), which is the PRIMARY transport's (Remote v2/ADB)
 * connection lifecycle. An Agent can be `Revoked` while Remote v2 stays `connected`;
 * conflating the two state machines would make that impossible to represent.
 */
export type TvAgentPairingState =
  | "unknown"
  | "discovered"
  | "pairing_required"
  | "pairing"
  | "authenticated"
  | "connected"
  | "revoked"
  | "rejected"
  | "disabled";

/** The complete legal-transition table. Anything not listed here is illegal — callers
 * must go through `transitionAgentPairingState`, never assign the state directly, so
 * this table is the ONE place the state machine's shape lives (§2 "document legal
 * transitions"). */
const LEGAL_TRANSITIONS: Record<TvAgentPairingState, readonly TvAgentPairingState[]> = {
  unknown: ["discovered", "disabled"],
  discovered: ["pairing_required", "rejected", "disabled"],
  pairing_required: ["pairing", "rejected", "disabled"],
  pairing: ["authenticated", "rejected", "pairing_required", "disabled"],
  authenticated: ["connected", "revoked", "disabled"],
  connected: ["revoked", "pairing_required", "disabled"],
  // §2 "Revocation must prevent automatic reconnection until explicitly re-paired" —
  // the ONLY way out of `revoked` is back through `pairing_required` (a deliberate,
  // installer-initiated re-pair), never straight to `pairing`/`authenticated`/
  // `connected`. There is no automatic-recovery edge out of this state at all.
  revoked: ["pairing_required", "disabled"],
  rejected: ["pairing_required", "disabled"],
  // Re-enabling always restarts from the top — a disabled Agent's prior authentication
  // is never trusted implicitly, matching "credential rotation/revocation" being a
  // first-class concern (§1).
  disabled: ["discovered", "pairing_required"],
};

export interface TvAgentPairingTransitionResult {
  ok: boolean;
  state: TvAgentPairingState;
  /** Present only when `ok` is false — the transition that was refused. */
  error?: string;
}

/** The single authorized way to move an Agent's pairing state forward. Returns the
 * unchanged current state (with `ok: false`) for an illegal transition, rather than
 * throwing — a caller driving this off untrusted wire events (e.g. a confused/hostile
 * Agent claiming to already be `connected`) needs a value it can log and act on, not an
 * exception that could crash a hot event-handling path. */
export function transitionAgentPairingState(current: TvAgentPairingState, next: TvAgentPairingState): TvAgentPairingTransitionResult {
  if (current === next) return { ok: true, state: current }; // idempotent no-op, not an error
  const allowed = LEGAL_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    return { ok: false, state: current, error: `illegal pairing-state transition: ${current} -> ${next}` };
  }
  return { ok: true, state: next };
}

/** True only in `connected` — the one state where the Agent is both authenticated AND
 * currently reachable. Every other state (including `authenticated`, which is "session
 * established but not yet confirmed live/subscribed") must be treated as NOT usable for
 * feedback, per §4 Phase 2's "connection state must be truthful" principle applied here
 * to the Agent channel. */
export function isAgentUsable(state: TvAgentPairingState): boolean {
  return state === "connected";
}

/** True for states that must NEVER auto-reconnect without explicit installer action —
 * `revoked`/`rejected`/`disabled` all require a deliberate re-pair, matching §2's
 * revocation requirement generalized to every "someone decided this Agent is not
 * trusted" state. */
export function requiresExplicitRepair(state: TvAgentPairingState): boolean {
  return state === "revoked" || state === "rejected" || state === "disabled";
}
