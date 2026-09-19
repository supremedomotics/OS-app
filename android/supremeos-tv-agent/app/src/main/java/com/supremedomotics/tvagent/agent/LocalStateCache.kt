package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.model.ForegroundAppState
import com.supremedomotics.tvagent.agent.model.MediaSessionState

/**
 * (§9/§24/§25 Phase 3B) Bounded current-state cache — NOT a history/event log (§25 "the
 * Agent should primarily report current state, not build a viewing-history database").
 * Holds exactly the latest media/foreground-app snapshot, nothing more; this is what
 * seeds the reconnect snapshot sequence (§9/§10) and what a genuinely offline Agent
 * retains (§24 "retain only bounded local state" — this class structurally cannot grow
 * beyond two fields, so there is no unbounded-queue failure mode to even reach).
 */
class LocalStateCache {
    @Volatile private var media: MediaSessionState? = null
    @Volatile private var foregroundApp: ForegroundAppState? = null

    fun updateMedia(state: MediaSessionState) {
        media = state
    }

    fun updateForegroundApp(state: ForegroundAppState) {
        foregroundApp = state
    }

    fun currentMedia(): MediaSessionState? = media
    fun currentForegroundApp(): ForegroundAppState? = foregroundApp

    /** §24 explicit bound — always exactly 2 possible retained entries, never more. */
    val maxRetainedEntries: Int = 2
}
