package com.supremedomotics.tvagent.agent.security

import com.supremedomotics.tvagent.agent.AgentSession

/**
 * (§2/§3 Phase 3B) UNVERIFIED. Drives `AgentPairingStateMachine` through an explicit,
 * auditable pairing flow — never lets the installer's pairing intent be skipped, and
 * never silently reconnects a revoked identity (§3). Owns no socket itself: pairing's
 * actual `hello`/`pair` wire exchange is `SecureConnectionManager`'s job; this class is
 * purely the STATE authority (mirrors how `AndroidTvRemoteV2Transport`'s `PairingSession`
 * is a separate concern from the control-channel transport in Phase 2's own codebase).
 *
 * No pairing-code entry UI exists in this pass — that's a small Activity a follow-up
 * change adds (a TV remote-navigable numeric-entry screen); this class's `submitCode`
 * is the boundary that UI will eventually call.
 */
class PairingManager(private val secureConnectionManager: SecureConnectionManager) {
    @Volatile var state: AgentPairingState = secureConnectionManager.storedPairingState()
        private set

    fun onDiscovered() = applyTransition(AgentPairingState.DISCOVERED)

    fun onPairingRequired() = applyTransition(AgentPairingState.PAIRING_REQUIRED)

    fun beginPairing(): Boolean = applyTransition(AgentPairingState.PAIRING)

    /** Called once the installer has entered the pairing code shown on-screen and the
     * SupremeOS hub has acknowledged it — never invoked speculatively. */
    fun onAuthenticated(): Boolean = applyTransition(AgentPairingState.AUTHENTICATED)

    fun onConnected(): Boolean = applyTransition(AgentPairingState.CONNECTED)

    fun onRevoked(): Boolean = applyTransition(AgentPairingState.REVOKED)

    fun onRejected(): Boolean = applyTransition(AgentPairingState.REJECTED)

    fun onDisabled(): Boolean = applyTransition(AgentPairingState.DISABLED)

    /** §3/§11 "never silently reconnect a revoked identity" — the ONLY gate a real
     * `SecureConnectionManager.openTlsSocket` reconnect attempt must check first. */
    fun canAutoReconnect(): Boolean = AgentPairingStateMachine.isUsable(state) || state == AgentPairingState.AUTHENTICATED

    fun requiresExplicitRepair(): Boolean = AgentPairingStateMachine.requiresExplicitRepair(state)

    private fun applyTransition(next: AgentPairingState): Boolean {
        val result = AgentPairingStateMachine.transition(state, next)
        if (result.ok) {
            state = result.state
            secureConnectionManager.persistPairingState(state)
        }
        return result.ok
    }
}
