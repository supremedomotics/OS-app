package com.supremedomotics.tvagent.agent.transport

/**
 * (§10 Phase 3B) Agent-SIDE counterpart to `TvDeviceSession`'s server-side coalescing
 * (tv-device-session.ts's `offerMediaState`/`DEFAULT_MEDIA_POSITION_COALESCING_MS`) —
 * throttling at the SOURCE reduces the inbound event rate SupremeOS has to arbitrate at
 * 100-agent scale, rather than relying solely on the server to absorb it. The policy
 * value itself MUST come from SupremeOS (negotiated at `hello`/`authenticated`, with
 * `DEFAULT_MS` as the fallback before that response arrives) — §10's explicit
 * instruction "do not hardcode a second 250 ms policy in Android" is satisfied by
 * treating this constant as ONLY the pre-negotiation fallback, never a fixed policy.
 *
 * Same rule as the server side: a position-ONLY change is throttled; any other field
 * changing (title, playbackState, artwork, etc.) always passes immediately.
 */
class MediaPositionCoalescer(private var coalesceMs: Long = DEFAULT_MS) {
    private var lastEmittedPositionMs: Long? = null
    private var lastEmittedOtherFieldsHash: Int? = null
    private var lastEmitAt: Long = 0

    /** Updates the policy once SupremeOS has told the Agent what it actually wants
     * (§10 "the policy must come from the established SupremeOS contract"). */
    fun updatePolicy(newCoalesceMs: Long) {
        coalesceMs = newCoalesceMs
    }

    /**
     * @param positionMs the new playback position, or null if this update doesn't carry one.
     * @param otherFieldsHash a hash of every OTHER field in the update (title, playbackState,
     *   artist, etc.) — if this differs from the last emission, the update always passes
     *   through immediately, regardless of the coalescing window.
     * @param nowMs current time, injected for deterministic unit testing.
     * @return true if this update should be sent now; false if it should be dropped
     *   (a later update will supersede it — the Agent's own LocalStateCache still holds
     *   the latest value for the next snapshot, so nothing is lost, only de-duplicated
     *   on the wire).
     */
    fun shouldEmit(positionMs: Long?, otherFieldsHash: Int, nowMs: Long): Boolean {
        val isFirstEmission = lastEmittedOtherFieldsHash == null
        val otherFieldsChanged = lastEmittedOtherFieldsHash != otherFieldsHash
        val positionOnlyChange = !isFirstEmission && !otherFieldsChanged

        if (isFirstEmission || otherFieldsChanged) {
            lastEmittedPositionMs = positionMs
            lastEmittedOtherFieldsHash = otherFieldsHash
            lastEmitAt = nowMs
            return true
        }
        if (positionOnlyChange && nowMs - lastEmitAt < coalesceMs) return false
        lastEmittedPositionMs = positionMs
        lastEmitAt = nowMs
        return true
    }

    companion object {
        /** Pre-negotiation fallback ONLY — see class doc comment. Matches
         * DEFAULT_MEDIA_POSITION_COALESCING_MS in tv-device-session.ts exactly. */
        const val DEFAULT_MS = 250L
    }
}
