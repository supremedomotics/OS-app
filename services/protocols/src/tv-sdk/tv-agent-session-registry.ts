import type { AgentMessage } from "./tv-agent-protocol.js";

/**
 * (§3/§4/§14/§15 Phase 3A — device binding + message authenticity) The authorization
 * boundary a real Agent wire transport must sit behind before ANY parsed `AgentMessage`
 * is allowed to reach `TvDeviceSession`. Distinct from `tv-agent-pairing-state.ts` (that
 * file is per-agent pairing lifecycle; this file is the many-agents-at-once authority
 * that decides whether a given, already-schema-valid message is even allowed to claim
 * the (agentId, deviceId) identity it says it has).
 *
 * §3 "IP address is merely a transport locator" — this registry never stores or checks
 * an IP/host at all; identity is `agentId` alone, bound once to a `deviceId` at pairing
 * time and never re-derived from network location, so a device changing IP (DHCP
 * renewal, Wi-Fi roam) can never be mistaken for a different logical Agent, and — just
 * as importantly — an Agent can never claim a DIFFERENT device merely by connecting
 * from a plausible-looking address.
 *
 * §4 replay/duplicate/stale protection is sequence-number-based, not timestamp-based
 * (a clock-skewed or replayed-with-adjusted-timestamp message must still be caught): a
 * session's `sequenceNumber` must be strictly increasing; anything at or below the last
 * accepted value for that session is rejected as stale/duplicate/replayed, in one check.
 */
export type AgentAuthorizationRejection =
  | "unknown_agent"
  | "device_mismatch"
  | "unknown_session"
  | "revoked"
  | "stale_or_duplicate_sequence";

export type AgentAuthorizationResult = { ok: true } | { ok: false; reason: AgentAuthorizationRejection };

interface BoundAgent {
  deviceId: string;
  sessionId: string;
  revoked: boolean;
  lastAcceptedSequence: number;
}

export class TvAgentSessionRegistry {
  private readonly agents = new Map<string, BoundAgent>();

  /** Called once at successful pairing/reconnect-authentication — establishes (or
   * re-establishes, e.g. after a reconnect with a fresh `sessionId`) the ONE device an
   * `agentId` is authorized to speak for. Rebinding the SAME `agentId` to a DIFFERENT
   * `deviceId` is refused outright (throws) — that would silently reassign an already-
   * paired Agent's identity, which must always be an explicit unbind-then-rebind, never
   * an implicit side effect of a bind call. */
  bind(agentId: string, deviceId: string, sessionId: string): void {
    const existing = this.agents.get(agentId);
    if (existing && existing.deviceId !== deviceId) {
      throw new Error(`tv-agent-session-registry: agent ${agentId} is already bound to device ${existing.deviceId}, refusing rebind to ${deviceId} without an explicit unbind() first`);
    }
    this.agents.set(agentId, { deviceId, sessionId, revoked: false, lastAcceptedSequence: -1 });
  }

  /** §2 revocation — the agent stays known (so a later, explicit re-pair can rebind
   * it), but every message it sends is rejected until then. Distinct from `unbind`,
   * which forgets the agent entirely (installer removed the device/uninstalled the
   * Agent) — matching the pairing-state machine's revoked-vs-disabled split. */
  revoke(agentId: string): void {
    const bound = this.agents.get(agentId);
    if (bound) bound.revoked = true;
  }

  /** Forgets an agent entirely — used on device removal/Agent uninstall, never as a
   * routine reconnect path (a reconnect re-uses `bind()` with the existing deviceId). */
  unbind(agentId: string): void {
    this.agents.delete(agentId);
  }

  isBound(agentId: string): boolean {
    const bound = this.agents.get(agentId);
    return !!bound && !bound.revoked;
  }

  /** The single authorization gate every incoming `AgentMessage` must pass before its
   * payload is allowed to reach the state cache/session. Checks, in order: agent known,
   * not revoked, claims the device it's actually bound to, belongs to the currently
   * bound session, and carries a sequence number strictly greater than the last one
   * accepted for that session (§4 — covers stale, duplicate, and replayed messages in
   * one check, without needing an unbounded seen-messageId set). On acceptance, updates
   * the session's high-water mark; a rejected message never advances it. */
  authorize(message: AgentMessage): AgentAuthorizationResult {
    const bound = this.agents.get(message.agentId);
    if (!bound) return { ok: false, reason: "unknown_agent" };
    if (bound.revoked) return { ok: false, reason: "revoked" };
    if (bound.deviceId !== message.deviceId) return { ok: false, reason: "device_mismatch" };
    if (message.sessionId !== undefined && message.sessionId !== bound.sessionId) return { ok: false, reason: "unknown_session" };
    const seq = message.sequenceNumber ?? -1;
    if (seq <= bound.lastAcceptedSequence) return { ok: false, reason: "stale_or_duplicate_sequence" };
    bound.lastAcceptedSequence = seq;
    return { ok: true };
  }

  /** Diagnostic-only snapshot — never exposes anything credential-shaped (§1 "no
   * secrets in logs"), just the authorization-relevant facts. */
  describe(agentId: string): { deviceId: string; revoked: boolean; lastAcceptedSequence: number } | null {
    const bound = this.agents.get(agentId);
    return bound ? { deviceId: bound.deviceId, revoked: bound.revoked, lastAcceptedSequence: bound.lastAcceptedSequence } : null;
  }

  /** §9 resource accounting — total bound agents, for leak/scale tests. */
  get size(): number {
    return this.agents.size;
  }
}
