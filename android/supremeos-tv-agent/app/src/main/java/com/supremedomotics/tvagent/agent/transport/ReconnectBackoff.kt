package com.supremedomotics.tvagent.agent.transport

import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * (§3/§24 Phase 3B) Bounded exponential backoff with full jitter — a real Agent losing
 * its connection to SupremeOS must not hammer the hub with reconnect attempts (§24 "do
 * not build an unlimited offline event queue" applies to reconnect attempts too: an
 * unbounded RETRY rate is the same class of resource problem as an unbounded queue).
 * "Full jitter" (AWS's well-known scheme) rather than a fixed exponential ladder — at
 * scale (§17, 100 agents), a bare exponential backoff with no randomness would have
 * every Agent that lost connectivity at the same moment (e.g. a hub restart) retry in
 * lockstep, recreating a thundering-herd exactly when the hub is least able to absorb
 * one.
 */
class ReconnectBackoff(
    private val baseMs: Long = 1_000,
    private val maxMs: Long = 60_000,
) {
    private var attempt = 0

    fun nextDelayMs(): Long {
        val exp = min(maxMs.toDouble(), baseMs * 2.0.pow(attempt))
        attempt += 1
        return Random.nextDouble(0.0, exp).toLong()
    }

    fun reset() {
        attempt = 0
    }

    val attemptCount: Int get() = attempt
}
