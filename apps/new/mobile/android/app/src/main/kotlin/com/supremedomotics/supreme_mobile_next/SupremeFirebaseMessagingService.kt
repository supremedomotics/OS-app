package com.supremedomotics.supreme_mobile_next

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * SupremeOS Phase 13.2 - Push Foundation.
 *
 * Android's own entry point for FCM token refresh and received messages. Deliberately
 * minimal: forwards a new token / a received payload's `data` map to whichever
 * [PushChannelBridge] is currently registered (set by [MainActivity] while its Flutter engine
 * is alive) and does nothing else - no SupremeOS semantic logic here, no notification
 * construction, no automation.
 *
 * HONEST SCOPE LIMIT (§Phase13.2 stop condition): if no engine is currently registered - i.e.
 * the app process was not already running with an active Flutter engine when this message
 * arrived - the payload is dropped, not queued, not used to wake a headless engine. Waking a
 * headless Flutter engine to process a payload while the app is fully backgrounded/terminated
 * is real background-execution work, explicitly deferred to a later phase (this phase's own
 * scope control forbids "Android background WebSocket runtime" / background execution).
 */
class SupremeFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        PushChannelBridge.emitTokenRefreshed(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        // §Phase13.2 §5/§9 - forwarded ONLY if an engine happens to be registered right now
        // (PushChannelBridge silently no-ops otherwise). Never treated as authoritative device
        // state (§7) - Dart maps this through `mapPushEnvelopeToHomeEvent`, which itself never
        // claims device state, only routing.
        PushChannelBridge.emitPushReceived(message.data)
    }
}
