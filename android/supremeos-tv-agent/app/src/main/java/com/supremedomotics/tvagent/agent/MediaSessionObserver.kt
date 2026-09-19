package com.supremedomotics.tvagent.agent

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import com.supremedomotics.tvagent.agent.model.MediaConfidence
import com.supremedomotics.tvagent.agent.model.MediaSessionState
import com.supremedomotics.tvagent.agent.model.ObserverAvailability

/**
 * (§4/§18 Phase 3B) UNVERIFIED — written against `android.media.session.*` per the
 * cited official docs, never compiled. Requires an enabled `NotificationListenerService`
 * component (Android's access-control gate for `getActiveSessions()` — a real project
 * needs that service declared in the manifest; omitted from this pass since it's a
 * one-file addition once compilation is possible). Registers `MediaController.Callback`
 * per active session (§6/§18 "register callbacks rather than relying on aggressive
 * polling") and unregisters on session destruction (§18 "unregister callbacks cleanly",
 * §22/§23 "no leaked listeners").
 */
class MediaSessionObserver(
    private val context: Context,
    private val notificationListenerComponent: ComponentName,
    private val onStateChanged: (MediaSessionState) -> Unit,
) {
    // Keyed by MediaSession.Token, NOT the MediaController instance: getActiveSessions()
    // returns a FRESH MediaController wrapper object on every single call (per AOSP's
    // MediaSessionManager implementation), even for the exact same underlying session,
    // and MediaController does not override equals()/hashCode() — an identity-keyed map
    // would treat every refresh as "all new sessions," permanently defeating this
    // class's own "idempotent, never double-registers" contract and churning
    // register/unregister every call. MediaSession.Token DOES implement structural
    // equality (it wraps the same underlying session), so it's the only correct key.
    private val activeCallbacks = mutableMapOf<MediaSession.Token, Pair<MediaController, MediaController.Callback>>()

    fun availability(): ObserverAvailability {
        val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager
            ?: return ObserverAvailability.UNAVAILABLE
        return try {
            manager.getActiveSessions(notificationListenerComponent)
            ObserverAvailability.AVAILABLE
        } catch (e: SecurityException) {
            // Notification-listener access not yet granted by the user — §19's
            // "permission_required" is exactly this case, not "unavailable".
            ObserverAvailability.PERMISSION_REQUIRED
        }
    }

    /** Enumerates every currently accessible session and registers a callback for each
     * one not already tracked — idempotent, so calling it again (e.g. after a
     * `onActiveSessionsChanged` broadcast) never double-registers. */
    fun refreshAndSubscribe() {
        val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager ?: return
        val sessions = try {
            manager.getActiveSessions(notificationListenerComponent)
        } catch (e: SecurityException) {
            return
        }
        val sessionTokens = sessions.map { it.sessionToken }.toSet()
        val stale = activeCallbacks.keys - sessionTokens
        for (token in stale) unregisterToken(token)
        for (controller in sessions) {
            val token = controller.sessionToken
            if (activeCallbacks.containsKey(token)) continue
            val callback = object : MediaController.Callback() {
                override fun onPlaybackStateChanged(state: PlaybackState?) {
                    emit(controller, controller.metadata, state)
                }
                override fun onMetadataChanged(metadata: MediaMetadata?) {
                    emit(controller, metadata, controller.playbackState)
                }
                override fun onSessionDestroyed() {
                    unregisterToken(token)
                }
            }
            controller.registerCallback(callback)
            activeCallbacks[token] = controller to callback
            emit(controller, controller.metadata, controller.playbackState)
        }
    }

    private fun unregisterToken(token: MediaSession.Token) {
        activeCallbacks.remove(token)?.let { (controller, callback) -> controller.unregisterCallback(callback) }
    }

    /** §5 "only transmit fields actually available" — every field below is read
     * directly from the platform object with no fallback/invention; a null stays null. */
    private fun emit(controller: MediaController, metadata: MediaMetadata?, state: PlaybackState?) {
        val playbackStateStr = when (state?.state) {
            PlaybackState.STATE_PLAYING -> "playing"
            PlaybackState.STATE_PAUSED -> "paused"
            PlaybackState.STATE_STOPPED -> "stopped"
            PlaybackState.STATE_BUFFERING -> "buffering"
            PlaybackState.STATE_ERROR -> "error"
            null -> "idle"
            else -> "idle"
        }
        val supportedActions = mutableListOf<String>()
        val actionBits = state?.actions ?: 0L
        if (actionBits and PlaybackState.ACTION_PLAY != 0L) supportedActions.add("play")
        if (actionBits and PlaybackState.ACTION_PAUSE != 0L) supportedActions.add("pause")
        if (actionBits and PlaybackState.ACTION_SKIP_TO_NEXT != 0L) supportedActions.add("skip_next")
        if (actionBits and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L) supportedActions.add("skip_previous")
        if (actionBits and PlaybackState.ACTION_SEEK_TO != 0L) supportedActions.add("seek")

        onStateChanged(
            MediaSessionState(
                packageName = controller.packageName,
                applicationName = null, // resolved by StatePublisher via PackageManager, kept out of this observer's concern
                playbackState = playbackStateStr,
                playbackPositionMs = state?.position,
                durationMs = metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION),
                playbackSpeed = state?.playbackSpeed,
                title = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE),
                displayTitle = metadata?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                subtitle = metadata?.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE),
                artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST),
                album = metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM),
                genre = metadata?.getString(MediaMetadata.METADATA_KEY_GENRE),
                mediaId = metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_ID),
                mediaUri = metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_URI),
                artworkUri = metadata?.getString(MediaMetadata.METADATA_KEY_ART_URI)
                    ?: metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI),
                queueTitle = controller.queueTitle?.toString(),
                supportedActions = supportedActions,
                customActions = state?.customActions?.map { it.action } ?: emptyList(),
                shuffle = null, // MediaController exposes shuffle mode via a separate, session-specific callback not wired in this pass
                repeat = null,
                // §12 confidence model: a real MediaSession callback with actual metadata
                // is "metadata," never "exact" (this observer cannot confirm canonical
                // content identity — see tv-agent-android-contract.ts's confidence notes).
                confidence = if (metadata != null) MediaConfidence.METADATA else MediaConfidence.APP_ONLY,
                sessionRevision = null, // MediaController exposes no monotonic sequence — left null, never fabricated
            ),
        )
    }

    /** §22 "every registration has a matching unregister" — called from
     * SupremeOsAgentService.onDestroy(). */
    fun stopAll() {
        for ((_, pair) in activeCallbacks) pair.first.unregisterCallback(pair.second)
        activeCallbacks.clear()
    }
}
