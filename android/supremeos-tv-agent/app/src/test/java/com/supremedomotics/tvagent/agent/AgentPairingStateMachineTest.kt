package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.security.AgentPairingState
import com.supremedomotics.tvagent.agent.security.AgentPairingStateMachine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** NOTE (Phase 3B): written but NOT RUN — see AgentProtocolTest.kt's header. Mirrors
 * tv-agent-pairing-state.test.ts's coverage. */
class AgentPairingStateMachineTest {
    @Test
    fun `happy path discovered to connected`() {
        var state = AgentPairingState.DISCOVERED
        for (next in listOf(AgentPairingState.PAIRING_REQUIRED, AgentPairingState.PAIRING, AgentPairingState.AUTHENTICATED, AgentPairingState.CONNECTED)) {
            val result = AgentPairingStateMachine.transition(state, next)
            assertTrue(result.ok)
            state = result.state
        }
        assertEquals(AgentPairingState.CONNECTED, state)
    }

    @Test
    fun `revoked cannot go straight back to connected`() {
        assertTrue(AgentPairingStateMachine.transition(AgentPairingState.CONNECTED, AgentPairingState.REVOKED).ok)
        assertFalse(AgentPairingStateMachine.transition(AgentPairingState.REVOKED, AgentPairingState.CONNECTED).ok)
        assertTrue(AgentPairingStateMachine.transition(AgentPairingState.REVOKED, AgentPairingState.PAIRING_REQUIRED).ok)
    }

    @Test
    fun `isUsable is true only for connected`() {
        assertTrue(AgentPairingStateMachine.isUsable(AgentPairingState.CONNECTED))
        assertFalse(AgentPairingStateMachine.isUsable(AgentPairingState.AUTHENTICATED))
    }

    @Test
    fun `requiresExplicitRepair is true for revoked rejected disabled only`() {
        assertTrue(AgentPairingStateMachine.requiresExplicitRepair(AgentPairingState.REVOKED))
        assertTrue(AgentPairingStateMachine.requiresExplicitRepair(AgentPairingState.REJECTED))
        assertTrue(AgentPairingStateMachine.requiresExplicitRepair(AgentPairingState.DISABLED))
        assertFalse(AgentPairingStateMachine.requiresExplicitRepair(AgentPairingState.CONNECTED))
    }
}
