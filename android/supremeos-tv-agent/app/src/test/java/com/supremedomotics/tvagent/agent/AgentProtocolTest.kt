package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.protocol.AgentProtocol
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * NOTE (Phase 3B): this test file is WRITTEN but NOT RUN in this session — the build
 * environment has no JDK/Gradle available (see the Phase 3B completion report), so this
 * is unverified source, not a passing test suite. It mirrors
 * tv-agent-protocol.test.ts's coverage so the same behavior is specified on both sides
 * of the wire.
 */
class AgentProtocolTest {
    @Test
    fun `builds a well-formed heartbeat envelope`() {
        val result = AgentProtocol.buildEnvelope(
            agentId = "agent-1", deviceId = "tv-1", messageId = "msg-1",
            messageType = "heartbeat", payload = JSONObject(),
            sessionId = "session-1", sequenceNumber = 0L,
        )
        assertTrue(result is AgentProtocol.Result.Ok)
    }

    @Test
    fun `rejects heartbeat missing sessionId`() {
        val result = AgentProtocol.buildEnvelope(
            agentId = "agent-1", deviceId = "tv-1", messageId = "msg-1",
            messageType = "heartbeat", payload = JSONObject(),
            sessionId = null, sequenceNumber = 0L,
        )
        assertTrue(result is AgentProtocol.Result.Err)
    }

    @Test
    fun `hello may omit sessionId and sequenceNumber`() {
        val result = AgentProtocol.buildEnvelope(
            agentId = "agent-1", deviceId = "tv-1", messageId = "msg-1",
            messageType = "hello", payload = JSONObject().put("agentVersion", "1.0.0"),
            sessionId = null, sequenceNumber = null,
        )
        assertTrue(result is AgentProtocol.Result.Ok)
    }

    @Test
    fun `parseIncoming rejects an oversized message before parsing`() {
        val huge = ByteArray(AgentProtocol.Limits.MAX_MESSAGE_BYTES + 1)
        val result = AgentProtocol.parseIncoming(huge)
        assertTrue(result is AgentProtocol.Result.Err)
    }

    @Test
    fun `parseIncoming rejects an incompatible major protocol version`() {
        val json = JSONObject()
            .put("protocolVersion", AgentProtocol.PROTOCOL_VERSION + 1)
            .put("agentId", "a").put("deviceId", "d").put("messageId", "m")
            .put("timestamp", java.time.Instant.now().toString())
            .put("sessionId", "s").put("sequenceNumber", 0)
            .put("messageType", "heartbeat").put("payload", JSONObject())
        val result = AgentProtocol.parseIncoming(json.toString().toByteArray())
        assertTrue(result is AgentProtocol.Result.Err)
    }

    @Test
    fun `semanticsOf classifies every documented message type`() {
        assertTrue(AgentProtocol.semanticsOf("mediaSession") == AgentProtocol.Semantics.SNAPSHOT)
        assertTrue(AgentProtocol.semanticsOf("mediaStateChanged") == AgentProtocol.Semantics.DELTA)
        assertTrue(AgentProtocol.semanticsOf("foregroundApp") == AgentProtocol.Semantics.NOTIFICATION)
    }

    @Test
    fun `isCompatibleProtocolMajor accepts only the exact major`() {
        assertTrue(AgentProtocol.isCompatibleProtocolMajor(AgentProtocol.PROTOCOL_VERSION))
        assertFalse(AgentProtocol.isCompatibleProtocolMajor(AgentProtocol.PROTOCOL_VERSION + 1))
    }
}
