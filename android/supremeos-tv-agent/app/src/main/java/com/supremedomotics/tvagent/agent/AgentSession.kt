package com.supremedomotics.tvagent.agent

import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * (§3/§4/§8 Phase 3B) The Agent's own identity + the current authenticated session's
 * outgoing sequence counter. `agentId` is generated ONCE on first pairing and persisted
 * in Keystore-backed storage (see SecureConnectionManager) — never re-derived from
 * network address (§3 "IP address is merely a transport locator"), and never regenerated
 * on reconnect (a regenerated agentId would look like a brand new Agent to SupremeOS's
 * `TvAgentSessionRegistry`, breaking the device-binding continuity §3 exists to provide).
 */
class AgentSession(
    val agentId: String,
    val deviceId: String,
) {
    @Volatile var sessionId: String? = null
        private set
    private val sequence = AtomicLong(0)

    /** Called once per successful (re)authentication — a fresh `sessionId` from
     * SupremeOS always resets the sequence counter to 0 (matching the server-side
     * registry's per-session, not per-agent, sequence tracking). */
    fun beginSession(newSessionId: String) {
        sessionId = newSessionId
        sequence.set(0)
    }

    fun endSession() {
        sessionId = null
    }

    /** Strictly increasing per session — never reused, never decremented (§4). */
    fun nextSequenceNumber(): Long = sequence.getAndIncrement()

    companion object {
        fun generateAgentId(): String = "agent-${UUID.randomUUID()}"
        fun generateMessageId(): String = UUID.randomUUID().toString()
    }
}
