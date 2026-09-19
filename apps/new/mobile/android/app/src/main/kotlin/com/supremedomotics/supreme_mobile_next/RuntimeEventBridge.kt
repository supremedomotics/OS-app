package com.supremedomotics.supreme_mobile_next

import io.flutter.plugin.common.EventChannel

/**
 * SupremeOS Phase 13.3 - process-wide holder for the current `com.supremeos/runtime/events`
 * [EventChannel.EventSink], mirroring [PushChannelBridge]'s exact pattern. Needed because
 * [SupremeForegroundService] (a Service, not the Activity) must be able to report its own
 * lifecycle (`serviceStateChanged`) on the SAME channel [MainActivity] already owns for
 * `processStateChanged`. Silently no-ops when no engine is currently listening - same policy as
 * [PushChannelBridge].
 */
object RuntimeEventBridge {
    private var sink: EventChannel.EventSink? = null

    fun attach(sink: EventChannel.EventSink) {
        this.sink = sink
    }

    fun detach() {
        sink = null
    }

    fun emitProcessStateChanged(state: String) {
        sink?.success(mapOf("type" to "processStateChanged", "state" to state))
    }

    fun emitServiceStateChanged(state: String) {
        sink?.success(mapOf("type" to "serviceStateChanged", "state" to state))
    }
}
