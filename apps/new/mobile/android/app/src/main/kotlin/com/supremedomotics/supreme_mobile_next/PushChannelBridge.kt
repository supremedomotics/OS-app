package com.supremedomotics.supreme_mobile_next

import io.flutter.plugin.common.EventChannel

/**
 * SupremeOS Phase 13.2 - Push Foundation.
 *
 * A tiny process-wide holder for the CURRENT `com.supremeos/push/events` [EventChannel.EventSink],
 * so [SupremeFirebaseMessagingService] (an Android component the Flutter engine does not own)
 * can forward a token refresh or a received message to whichever engine [MainActivity] is
 * currently running. Deliberately holds nothing else - no SupremeOS semantic state, no queue,
 * no persistence. Emitting is a silent no-op whenever no engine is listening
 * (backgrounded/terminated app) - see [SupremeFirebaseMessagingService]'s own HONEST SCOPE
 * LIMIT doc for why that case is not handled here.
 */
object PushChannelBridge {
    private var sink: EventChannel.EventSink? = null

    fun attach(sink: EventChannel.EventSink) {
        this.sink = sink
    }

    fun detach() {
        sink = null
    }

    fun emitTokenRefreshed(token: String) {
        sink?.success(mapOf("type" to "tokenRefreshed", "token" to token))
    }

    fun emitPushReceived(data: Map<String, String>) {
        sink?.success(mapOf("type" to "pushReceived", "data" to data))
    }
}
