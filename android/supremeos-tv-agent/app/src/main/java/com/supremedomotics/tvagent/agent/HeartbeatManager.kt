package com.supremedomotics.tvagent.agent

import com.supremedomotics.tvagent.agent.transport.DefaultHeartbeatPolicy
import com.supremedomotics.tvagent.agent.transport.HeartbeatPolicy
import com.supremedomotics.tvagent.agent.transport.isHeartbeatHealthy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * (§7/§12 Phase 3B) UNVERIFIED. Exactly ONE coroutine job for the heartbeat loop — §12
 * "do not create hidden/unbounded timers," and `stop()` cancels it unconditionally, so
 * a repeated start()/stop() cycle (§13/§23's lifecycle tests) can never accumulate
 * concurrent loops. `sendHeartbeat` is injected rather than this class owning a socket,
 * so it stays testable (a fake sender) without any real transport.
 */
class HeartbeatManager(
    private val scope: CoroutineScope,
    private val policy: HeartbeatPolicy = DefaultHeartbeatPolicy.VALUE,
    private val sendHeartbeat: suspend () -> Unit,
    private val onUnhealthy: () -> Unit,
) {
    private var job: Job? = null
    @Volatile private var lastHeartbeatAt: Long = System.currentTimeMillis()

    fun start() {
        stop() // idempotent — never double-starts a second loop
        job = scope.launch {
            while (true) {
                delay(policy.intervalMs)
                sendHeartbeat()
                lastHeartbeatAt = System.currentTimeMillis()
                if (!isHeartbeatHealthy(lastHeartbeatAt, System.currentTimeMillis(), policy)) onUnhealthy()
            }
        }
    }

    /** Called whenever ANY message arrives from SupremeOS — not just heartbeat acks —
     * so the health window reflects genuine liveness, not merely "our own heartbeat
     * loop is still scheduled" (a stalled receive path should still be caught). */
    fun recordActivity() {
        lastHeartbeatAt = System.currentTimeMillis()
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
