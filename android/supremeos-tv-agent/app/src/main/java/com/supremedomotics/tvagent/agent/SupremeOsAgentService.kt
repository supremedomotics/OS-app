package com.supremedomotics.tvagent.agent

import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.supremedomotics.tvagent.agent.protocol.AgentProtocol
import com.supremedomotics.tvagent.agent.security.PairingManager
import com.supremedomotics.tvagent.agent.security.SecureConnectionManager
import com.supremedomotics.tvagent.agent.transport.MediaPositionCoalescer
import com.supremedomotics.tvagent.agent.transport.ReconnectBackoff
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * (§1/§11/§12/§13 Phase 3B) UNVERIFIED. The top-level component wiring every other
 * piece together — deliberately thin: it owns lifecycle (start/stop/reconnect), not
 * business logic (that lives in the individual observers/managers it holds). §11
 * "Agent connection loss must be independent from Remote v2" is enforced by
 * CONSTRUCTION here: this service has no reference to, and never touches, anything
 * Android TV Remote v2-related — Remote v2 is a completely separate SupremeOS-hub-side
 * concern this Agent doesn't even know exists.
 *
 * §13/§23 lifecycle discipline: `onDestroy()` is the ONE place every component's
 * `stop()`/`unregister`/`cancel()` is called — repeated start/stop cycles (§13's test
 * list) must never leak a listener/socket/coroutine because every acquisition here has
 * exactly one matching release, in this one method.
 */
class SupremeOsAgentService : Service() {
    private val scope = CoroutineScope(SupervisorJob())
    private val backoff = ReconnectBackoff()
    private val positionCoalescer = MediaPositionCoalescer()

    private lateinit var secureConnectionManager: SecureConnectionManager
    private lateinit var pairingManager: PairingManager
    private lateinit var session: AgentSession
    private lateinit var localCache: LocalStateCache
    private var heartbeatManager: HeartbeatManager? = null
    private var mediaObserver: MediaSessionObserver? = null
    private var appInventoryProvider: AppInventoryProvider? = null
    private var deviceInfoProvider: DeviceInfoProvider? = null
    private var statePublisher: StatePublisher? = null

    override fun onBind(intent: Intent?): IBinder? = null // not a bound service — no client needs a live binder

    override fun onCreate() {
        super.onCreate()
        secureConnectionManager = SecureConnectionManager(applicationContext)
        pairingManager = PairingManager(secureConnectionManager)
        val agentId = secureConnectionManager.loadOrCreateAgentId()
        // TODO(Phase 3B follow-up): deviceId comes from the pairing exchange (the
        // SupremeOS-side device this Agent is bound to) — not yet wired since pairing
        // UI doesn't exist in this pass. Placeholder until PairingManager exposes it.
        session = AgentSession(agentId = agentId, deviceId = "unbound")
        localCache = LocalStateCache()
        deviceInfoProvider = DeviceInfoProvider(applicationContext)
        appInventoryProvider = AppInventoryProvider(applicationContext)
    }

    /** §9/§10 — the exact reconnect snapshot sequence, in order, before any delta. */
    private fun sendReconnectSnapshotSequence() {
        val publisher = statePublisher ?: return
        for (messageType in AgentProtocol.RECONNECT_SNAPSHOT_SEQUENCE) {
            when (messageType) {
                "deviceInfo" -> deviceInfoProvider?.current(agentVersion = "0.1.0", supportedFeedbackMechanisms = listOf("media_session", "app_inventory"))
                    ?.let { publisher.publishDeviceInfo(it) }
                "appInventory" -> appInventoryProvider?.snapshot()?.let { publisher.publishAppInventory(it) }
                "foregroundApp" -> localCache.currentForegroundApp()?.let { publisher.publishForegroundApp(it) }
                "mediaSession" -> localCache.currentMedia()?.let { publisher.publishMediaSessionSnapshot(it) }
            }
        }
    }

    override fun onDestroy() {
        // §12/§13/§22/§23 — every acquisition this service or its children made is
        // released here, exactly once, regardless of how far startup got.
        heartbeatManager?.stop()
        mediaObserver?.stopAll()
        scope.cancel()
        super.onDestroy()
    }
}
