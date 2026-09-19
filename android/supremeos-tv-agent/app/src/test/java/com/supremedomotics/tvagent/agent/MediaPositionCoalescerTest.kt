package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.transport.MediaPositionCoalescer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** NOTE (Phase 3B): written but NOT RUN — see AgentProtocolTest.kt's header. Mirrors
 * the §8/§10 coverage in tv-agent-integration.test.ts on the SupremeOS side. */
class MediaPositionCoalescerTest {
    @Test
    fun `first emission always passes`() {
        val c = MediaPositionCoalescer(coalesceMs = 250)
        assertTrue(c.shouldEmit(0, otherFieldsHash = 1, nowMs = 0))
    }

    @Test
    fun `rapid position-only updates within the window are coalesced away`() {
        val c = MediaPositionCoalescer(coalesceMs = 250)
        assertTrue(c.shouldEmit(0, otherFieldsHash = 1, nowMs = 0))
        assertFalse(c.shouldEmit(1000, otherFieldsHash = 1, nowMs = 10))
        assertFalse(c.shouldEmit(2000, otherFieldsHash = 1, nowMs = 20))
    }

    @Test
    fun `a changed otherFieldsHash (metadata or playback transition) always passes immediately`() {
        val c = MediaPositionCoalescer(coalesceMs = 250)
        assertTrue(c.shouldEmit(0, otherFieldsHash = 1, nowMs = 0))
        assertTrue(c.shouldEmit(1000, otherFieldsHash = 2, nowMs = 10)) // e.g. playing -> paused, well within the window
    }

    @Test
    fun `low-frequency updates spaced beyond the window are never dropped`() {
        val c = MediaPositionCoalescer(coalesceMs = 1)
        assertTrue(c.shouldEmit(0, otherFieldsHash = 1, nowMs = 0))
        assertTrue(c.shouldEmit(1000, otherFieldsHash = 1, nowMs = 100))
        assertTrue(c.shouldEmit(2000, otherFieldsHash = 1, nowMs = 200))
    }

    @Test
    fun `updatePolicy changes the effective window without reconstructing the coalescer`() {
        val c = MediaPositionCoalescer(coalesceMs = 1)
        assertTrue(c.shouldEmit(0, otherFieldsHash = 1, nowMs = 0))
        c.updatePolicy(10_000)
        assertFalse(c.shouldEmit(1000, otherFieldsHash = 1, nowMs = 50))
    }
}
