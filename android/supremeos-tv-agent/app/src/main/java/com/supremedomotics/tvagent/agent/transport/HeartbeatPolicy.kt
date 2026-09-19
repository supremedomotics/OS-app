package com.supremedomotics.tvagent.agent.transport

/**
 * (§7/§12 Phase 3B) Faithful mirror of `tv-agent-heartbeat.ts` — the SAME default
 * interval/timeout SupremeOS enforces server-side. Pure policy, no timer of its own —
 * `HeartbeatManager` owns actual scheduling (a single `Handler`/coroutine, per §12 "do
 * not create hidden/unbounded timers").
 */
data class HeartbeatPolicy(val intervalMs: Long, val timeoutMs: Long)

object DefaultHeartbeatPolicy {
    val VALUE = HeartbeatPolicy(intervalMs = 15_000, timeoutMs = 45_000)
}

fun isHeartbeatHealthy(lastHeartbeatAtMs: Long, nowMs: Long, policy: HeartbeatPolicy = DefaultHeartbeatPolicy.VALUE): Boolean =
    nowMs - lastHeartbeatAtMs < policy.timeoutMs
