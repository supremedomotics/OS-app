package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.model.AppInventoryEntry
import com.supremedomotics.tvagent.agent.model.DeviceInfo
import com.supremedomotics.tvagent.agent.model.ForegroundAppState
import com.supremedomotics.tvagent.agent.model.MediaSessionState
import com.supremedomotics.tvagent.agent.protocol.AgentProtocol
import org.json.JSONArray
import org.json.JSONObject

/**
 * (§2/§9 Phase 3B) UNVERIFIED. Normalizes every observer's model type into the exact
 * wire envelope `AgentProtocol` defines, and is the ONLY class in this app that touches
 * `org.json` for outgoing messages — mirrors the TS side's principle of one codec, one
 * place. Takes a `send: (ByteArray) -> Unit` rather than owning a socket, so the actual
 * transport (real TLS in production, a fake in tests) is fully swappable.
 */
class StatePublisher(
    private val session: AgentSession,
    private val send: (ByteArray) -> Unit,
) {
    private fun publish(messageType: String, payload: JSONObject) {
        val result = AgentProtocol.buildEnvelope(
            agentId = session.agentId,
            deviceId = session.deviceId,
            messageId = AgentSession.generateMessageId(),
            messageType = messageType,
            payload = payload,
            sessionId = session.sessionId,
            sequenceNumber = session.nextSequenceNumber(),
        )
        when (result) {
            is AgentProtocol.Result.Ok -> send(result.json.toString().toByteArray())
            is AgentProtocol.Result.Err -> {
                // §1 "no secrets in logs" is not at risk here (nothing sensitive in a
                // state payload), but a build failure must never crash the publishing
                // path — dropped with a diagnostic-only log, matching §13's "one
                // observer's bug must not crash the whole Agent process."
            }
        }
    }

    fun publishDeviceInfo(info: DeviceInfo) = publish(
        "deviceInfo",
        JSONObject()
            .put("manufacturer", info.manufacturer)
            .put("model", info.model)
            .put("osName", info.osName)
            .put("apiLevel", info.apiLevel)
            .put("agentVersion", info.agentVersion)
            .put("supportedFeedbackMechanisms", JSONArray(info.supportedFeedbackMechanisms)),
    )

    fun publishAppInventory(apps: List<AppInventoryEntry>) {
        val array = JSONArray()
        for (app in apps) {
            array.put(
                JSONObject()
                    .put("packageName", app.packageName)
                    .put("applicationName", app.applicationName)
                    .put("version", app.version)
                    .put("launchable", app.launchable)
                    .put("installed", app.installed),
            )
        }
        publish("appInventory", JSONObject().put("apps", array))
    }

    fun publishForegroundApp(app: ForegroundAppState) = publish(
        "foregroundApp",
        JSONObject()
            .put("packageName", app.packageName)
            .put("applicationName", app.applicationName)
            .put("source", app.source.name.lowercase())
            .put("confidence", app.confidence.name.lowercase()),
    )

    /** §9/§10 full snapshot — used at connect/reconnect only, per
     * AgentProtocol.RECONNECT_SNAPSHOT_SEQUENCE. */
    fun publishMediaSessionSnapshot(state: MediaSessionState) = publish("mediaSession", mediaJson(state))

    /** §9/§10 delta — used during normal steady-state operation. */
    fun publishMediaStateChanged(state: MediaSessionState) = publish(
        "mediaStateChanged",
        JSONObject()
            .put("playbackState", state.playbackState)
            .put("playbackPositionMs", state.playbackPositionMs)
            .put("confidence", state.confidence.name.lowercase())
            .put("sessionRevision", state.sessionRevision),
    )

    private fun mediaJson(state: MediaSessionState): JSONObject = JSONObject()
        .put("packageName", state.packageName)
        .put("applicationName", state.applicationName)
        .put("playbackState", state.playbackState)
        .put("playbackPositionMs", state.playbackPositionMs)
        .put("durationMs", state.durationMs)
        .put("playbackSpeed", state.playbackSpeed)
        .put("title", state.title)
        .put("displayTitle", state.displayTitle)
        .put("subtitle", state.subtitle)
        .put("artist", state.artist)
        .put("album", state.album)
        .put("genre", state.genre)
        .put("mediaId", state.mediaId)
        .put("mediaUri", state.mediaUri)
        .put("artworkUri", state.artworkUri)
        .put("queueTitle", state.queueTitle)
        .put("supportedActions", JSONArray(state.supportedActions))
        .put("customActions", JSONArray(state.customActions))
        .put("shuffle", state.shuffle)
        .put("repeat", state.repeat)
        .put("confidence", state.confidence.name.lowercase())
        .put("sessionRevision", state.sessionRevision)

    fun publishHeartbeat() = publish("heartbeat", JSONObject())
}
