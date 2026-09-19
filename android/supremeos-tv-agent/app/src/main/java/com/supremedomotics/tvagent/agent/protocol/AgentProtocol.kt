package com.supremedomotics.tvagent.agent.protocol

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.format.DateTimeParseException

/**
 * (§2 Phase 3B) Faithful Kotlin mirror of `services/protocols/src/tv-sdk/
 * tv-agent-protocol.ts` — the SAME wire contract, not a second protocol. Every constant,
 * field name, limit, and validation rule here MUST match that file exactly; if the two
 * ever diverge, this file is wrong, not the TypeScript one (TS is the protocol's
 * source of truth per Phase 3A). Uses `org.json` (built into the Android platform, API
 * 1+) rather than adding kotlinx.serialization or Gson — the ladder's "native platform
 * feature" rung: this message set is small, and pulling in a JSON library for what
 * `org.json` already does would be the exact kind of unneeded dependency Phase 2/3A's
 * hand-rolled TS validator (for the identical reason) already argued against.
 */
object AgentProtocol {
    const val PROTOCOL_VERSION = 1
    const val PROTOCOL_MINOR = 0

    /** §6 — identical values to AGENT_LIMITS in tv-agent-protocol.ts. */
    object Limits {
        const val MAX_MESSAGE_BYTES = 64 * 1024
        const val MAX_APP_INVENTORY_ENTRIES = 2000
        const val MAX_PACKAGE_NAME_LENGTH = 255
        const val MAX_APPLICATION_NAME_LENGTH = 255
        const val MAX_METADATA_FIELD_LENGTH = 500
        const val MAX_URI_LENGTH = 2048
        const val MAX_MEDIA_ID_LENGTH = 255
        const val MAX_SUPPORTED_ACTIONS_ENTRIES = 64
        const val MAX_CUSTOM_ACTIONS_ENTRIES = 64
    }

    /** §5 — major must match exactly; minor differences are always tolerated. Mirrors
     * `isCompatibleProtocolMajor` in tv-agent-protocol.ts. */
    fun isCompatibleProtocolMajor(theirMajor: Int): Boolean = theirMajor == PROTOCOL_VERSION

    private val MESSAGE_TYPES_WITHOUT_SESSION = setOf("hello", "pair")

    enum class Semantics { REQUEST, RESPONSE, SNAPSHOT, DELTA, NOTIFICATION }

    /** §9 — identical classification to MESSAGE_SEMANTICS in tv-agent-protocol.ts. */
    fun semanticsOf(messageType: String): Semantics = when (messageType) {
        "hello" -> Semantics.REQUEST
        "pair" -> Semantics.REQUEST
        "authenticated" -> Semantics.RESPONSE
        "heartbeat" -> Semantics.REQUEST
        "deviceInfo" -> Semantics.SNAPSHOT
        "appInventory" -> Semantics.SNAPSHOT
        "mediaSession" -> Semantics.SNAPSHOT
        "foregroundApp" -> Semantics.NOTIFICATION
        "mediaStateChanged" -> Semantics.DELTA
        "mediaMetadataChanged" -> Semantics.DELTA
        "mediaCapabilitiesChanged" -> Semantics.DELTA
        "volumeChanged" -> Semantics.NOTIFICATION
        "error" -> Semantics.NOTIFICATION
        "goodbye" -> Semantics.NOTIFICATION
        else -> throw IllegalArgumentException("unrecognized messageType \"$messageType\"")
    }

    /** §10 — identical order to AGENT_RECONNECT_SNAPSHOT_SEQUENCE in tv-agent-protocol.ts. */
    val RECONNECT_SNAPSHOT_SEQUENCE = listOf("deviceInfo", "appInventory", "foregroundApp", "mediaSession")

    /** Result of building/validating one outgoing envelope — mirrors ParsedAgentMessage's
     * ok/error shape so both directions of this channel share one mental model. */
    sealed class Result {
        data class Ok(val json: JSONObject) : Result()
        data class Err(val error: String) : Result()
    }

    /**
     * Builds and validates one outgoing wire envelope. `sessionId`/`sequenceNumber` are
     * required for every messageType except "hello"/"pair" (§4) — enforced here so a
     * caller cannot accidentally send a session-less message once a session exists.
     * Never throws for a caller mistake; returns `Result.Err` instead, since a bug in
     * one observer must not crash the whole Agent process (§13 lifecycle robustness).
     */
    fun buildEnvelope(
        agentId: String,
        deviceId: String,
        messageId: String,
        messageType: String,
        payload: JSONObject,
        sessionId: String?,
        sequenceNumber: Long?,
        protocolMinor: Int = PROTOCOL_MINOR,
    ): Result {
        if (agentId.isEmpty()) return Result.Err("agentId must be non-empty")
        if (deviceId.isEmpty()) return Result.Err("deviceId must be non-empty")
        if (messageId.isEmpty()) return Result.Err("messageId must be non-empty")
        if (!MESSAGE_TYPES_WITHOUT_SESSION.contains(messageType)) {
            if (sessionId.isNullOrEmpty()) return Result.Err("$messageType.sessionId required — every message after pairing must belong to an authenticated session")
            if (sequenceNumber == null || sequenceNumber < 0) return Result.Err("$messageType.sequenceNumber must be a non-negative integer")
        }
        val envelope = JSONObject()
        envelope.put("protocolVersion", PROTOCOL_VERSION)
        envelope.put("protocolMinor", protocolMinor)
        envelope.put("agentId", agentId)
        envelope.put("deviceId", deviceId)
        envelope.put("messageId", messageId)
        envelope.put("timestamp", Instant.now().toString())
        if (sessionId != null) envelope.put("sessionId", sessionId)
        if (sequenceNumber != null) envelope.put("sequenceNumber", sequenceNumber)
        envelope.put("messageType", messageType)
        envelope.put("payload", payload)

        val bytes = envelope.toString().toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > Limits.MAX_MESSAGE_BYTES) {
            return Result.Err("message size ${bytes.size} bytes exceeds maxMessageBytes (${Limits.MAX_MESSAGE_BYTES})")
        }
        return Result.Ok(envelope)
    }

    /** §6 wire entry point for INCOMING messages — checks byte size before ever calling
     * the JSON parser, mirroring `parseAgentMessageFromJson`'s discipline exactly (never
     * allocate the parsed object graph for an oversized/hostile payload). */
    fun parseIncoming(raw: ByteArray): Result {
        if (raw.size > Limits.MAX_MESSAGE_BYTES) {
            return Result.Err("message size ${raw.size} bytes exceeds maxMessageBytes (${Limits.MAX_MESSAGE_BYTES})")
        }
        val json = try {
            JSONObject(String(raw, StandardCharsets.UTF_8))
        } catch (e: JSONException) {
            return Result.Err("invalid JSON: ${e.message}")
        }
        validateEnvelope(json)?.let { return Result.Err(it) }
        val version = json.optInt("protocolVersion", -1)
        if (!isCompatibleProtocolMajor(version)) {
            return Result.Err("incompatible protocolVersion $version (this build speaks major $PROTOCOL_VERSION)")
        }
        return Result.Ok(json)
    }

    private fun validateEnvelope(json: JSONObject): String? {
        if (json.optInt("protocolVersion", -1) <= 0) return "protocolVersion must be a positive integer"
        if (json.optString("agentId").isEmpty()) return "agentId must be a non-empty string"
        if (json.optString("deviceId").isEmpty()) return "deviceId must be a non-empty string"
        if (json.optString("messageId").isEmpty()) return "messageId must be a non-empty string"
        val timestamp = json.optString("timestamp")
        try {
            Instant.parse(timestamp)
        } catch (e: DateTimeParseException) {
            return "timestamp must be an ISO-8601 string"
        }
        val messageType = json.optString("messageType")
        if (!MESSAGE_TYPES_WITHOUT_SESSION.contains(messageType)) {
            if (json.optString("sessionId").isEmpty()) return "$messageType.sessionId required"
            if (!json.has("sequenceNumber") || json.optLong("sequenceNumber", -1) < 0) return "$messageType.sequenceNumber must be a non-negative integer"
        }
        return null
    }

    /** §11/§12/§13 field-length/array-count bounds a payload string/array must satisfy —
     * identical thresholds to AGENT_LIMITS, checked client-side too (§20 "the Agent
     * MUST enforce these caps itself, not rely on SupremeOS to reject after the fact"). */
    fun checkLength(label: String, value: String?, max: Int): String? {
        if (value != null && value.length > max) return "$label exceeds maximum length $max (got ${value.length})"
        return null
    }

    fun checkArrayLength(label: String, value: JSONArray, max: Int): String? {
        if (value.length() > max) return "$label exceeds maximum entries $max (got ${value.length()})"
        return null
    }
}
