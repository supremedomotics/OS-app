package com.supremedomotics.tvagent.agent.security

/**
 * (§2/§11 Phase 3B) Faithful Kotlin mirror of `tv-agent-pairing-state.ts` — the SAME
 * state machine SupremeOS enforces server-side, not a second one. Kept exhaustive and
 * table-driven for the same reason as the TS original: every legal transition is
 * visible in one place, and `transition()` is the ONLY sanctioned way to move state
 * forward (never assign `PairingManager.state` directly from calling code).
 */
enum class AgentPairingState {
    UNKNOWN, DISCOVERED, PAIRING_REQUIRED, PAIRING, AUTHENTICATED, CONNECTED, REVOKED, REJECTED, DISABLED
}

data class PairingTransitionResult(val ok: Boolean, val state: AgentPairingState, val error: String? = null)

object AgentPairingStateMachine {
    private val LEGAL_TRANSITIONS: Map<AgentPairingState, Set<AgentPairingState>> = mapOf(
        AgentPairingState.UNKNOWN to setOf(AgentPairingState.DISCOVERED, AgentPairingState.DISABLED),
        AgentPairingState.DISCOVERED to setOf(AgentPairingState.PAIRING_REQUIRED, AgentPairingState.REJECTED, AgentPairingState.DISABLED),
        AgentPairingState.PAIRING_REQUIRED to setOf(AgentPairingState.PAIRING, AgentPairingState.REJECTED, AgentPairingState.DISABLED),
        AgentPairingState.PAIRING to setOf(AgentPairingState.AUTHENTICATED, AgentPairingState.REJECTED, AgentPairingState.PAIRING_REQUIRED, AgentPairingState.DISABLED),
        AgentPairingState.AUTHENTICATED to setOf(AgentPairingState.CONNECTED, AgentPairingState.REVOKED, AgentPairingState.DISABLED),
        AgentPairingState.CONNECTED to setOf(AgentPairingState.REVOKED, AgentPairingState.PAIRING_REQUIRED, AgentPairingState.DISABLED),
        // §2 "revocation must prevent automatic reconnection until explicitly re-paired"
        // — the ONLY way out of REVOKED is back through PAIRING_REQUIRED.
        AgentPairingState.REVOKED to setOf(AgentPairingState.PAIRING_REQUIRED, AgentPairingState.DISABLED),
        AgentPairingState.REJECTED to setOf(AgentPairingState.PAIRING_REQUIRED, AgentPairingState.DISABLED),
        AgentPairingState.DISABLED to setOf(AgentPairingState.DISCOVERED, AgentPairingState.PAIRING_REQUIRED),
    )

    fun transition(current: AgentPairingState, next: AgentPairingState): PairingTransitionResult {
        if (current == next) return PairingTransitionResult(ok = true, state = current)
        val allowed = LEGAL_TRANSITIONS[current] ?: emptySet()
        if (!allowed.contains(next)) {
            return PairingTransitionResult(ok = false, state = current, error = "illegal pairing-state transition: $current -> $next")
        }
        return PairingTransitionResult(ok = true, state = next)
    }

    /** True only in CONNECTED — mirrors `isAgentUsable` in tv-agent-pairing-state.ts. */
    fun isUsable(state: AgentPairingState): Boolean = state == AgentPairingState.CONNECTED

    /** §3/§11 "never silently reconnect a revoked identity" — `SecureConnectionManager`
     * MUST check this before ever attempting `reconnectWithStoredCredentials()`. */
    fun requiresExplicitRepair(state: AgentPairingState): Boolean =
        state == AgentPairingState.REVOKED || state == AgentPairingState.REJECTED || state == AgentPairingState.DISABLED
}
