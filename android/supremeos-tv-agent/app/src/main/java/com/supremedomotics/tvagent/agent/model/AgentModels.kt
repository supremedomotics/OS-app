package com.supremedomotics.tvagent.agent.model

/** (§5/§18/§19/§20 Phase 3B) Plain data holders normalized from Android framework
 * types, matching tv-agent-protocol.ts's payload shapes field-for-field. Kept separate
 * from `protocol/AgentProtocol.kt`'s JSON (de)serialization so observers never touch
 * `org.json` directly — only `StatePublisher` does. */

enum class MediaConfidence { EXACT, METADATA, APP_ONLY, UNKNOWN }
enum class ForegroundSource { AGENT_ACCESSIBILITY, PLATFORM_FOREGROUND_API, ADB, LAST_KNOWN }

data class MediaSessionState(
    val packageName: String,
    val applicationName: String?,
    val playbackState: String, // "playing"|"paused"|"stopped"|"idle"|"buffering"|"error"
    val playbackPositionMs: Long?,
    val durationMs: Long?,
    val playbackSpeed: Float?,
    val title: String?,
    val displayTitle: String?,
    val subtitle: String?,
    val artist: String?,
    val album: String?,
    val genre: String?,
    val mediaId: String?,
    val mediaUri: String?,
    val artworkUri: String?,
    val queueTitle: String?,
    val supportedActions: List<String>,
    val customActions: List<String>,
    val shuffle: Boolean?,
    val repeat: String?, // "off"|"all"|"one"
    val confidence: MediaConfidence,
    val sessionRevision: Long?,
)

data class ForegroundAppState(
    val packageName: String?,
    val applicationName: String?,
    val source: ForegroundSource,
    val confidence: MediaConfidence,
)

data class AppInventoryEntry(
    val packageName: String,
    val applicationName: String?,
    val version: String?,
    val launchable: Boolean,
    val installed: Boolean,
)

data class DeviceInfo(
    val manufacturer: String?,
    val model: String?,
    val osName: String, // "android_tv"|"google_tv"|"unknown"
    val apiLevel: Int?,
    val agentVersion: String,
    val supportedFeedbackMechanisms: List<String>,
)

/** §19 "do not silently report unknown as a detected app" — every observer surfaces
 * its OWN availability distinctly from the value it reports. */
enum class ObserverAvailability { AVAILABLE, UNAVAILABLE, PERMISSION_REQUIRED, DEGRADED }
