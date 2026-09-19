package com.supremedomotics.supreme_mobile_next

import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * SupremeOS Phase 13.1/13.2/13.3 - Mobile Runtime Foundation + Push Foundation + Android
 * Background Execution.
 *
 * Registers the native side of the `com.supremeos/runtime` MethodChannel and
 * `com.supremeos/runtime/events` EventChannel that [NativeRuntimeBridge] (Dart side,
 * `apps/new/mobile/lib/runtime/native_runtime_bridge.dart`) speaks against (Phase 13.1), plus
 * the `com.supremeos/push` / `com.supremeos/push/events` pair `NativePushTokenSource` speaks
 * against (Phase 13.2 - see [configurePushChannel]).
 *
 * §Phase13.3 "ONE authoritative runtime model per process": the FlutterEngine created here is
 * CACHED ([FlutterEngineCache]) and this Activity does NOT destroy it when the Activity itself
 * is destroyed ([shouldDestroyEngineWithHost] returns `false`) - the SAME Dart isolate, and
 * therefore the SAME `RuntimeController`/`MobileRuntime` instance, keeps running across Activity
 * recreation/backgrounding. [SupremeForegroundService] never creates a second engine; it exists
 * purely as a native OS construct that keeps this ONE process alive/prioritized so that engine
 * keeps executing. If this Activity is ever relaunched, [provideFlutterEngine] returns the
 * SAME cached engine instead of creating a new one - no duplicate runtime is ever created.
 *
 * The Hub remains the sole authority for device state/automation/protocols; this class knows
 * nothing about KNX/Casambi/Matter/SIP and never will - it only bridges OS lifecycle signals to
 * the existing Dart runtime, which is itself unaware of Android as a platform.
 */
class MainActivity : FlutterActivity() {
    private val methodChannelName = "com.supremeos/runtime"
    private val eventChannelName = "com.supremeos/runtime/events"

    companion object {
        private const val CACHED_ENGINE_ID = "supreme_os_main_engine"
    }

    override fun provideFlutterEngine(context: Context): FlutterEngine {
        FlutterEngineCache.getInstance().get(CACHED_ENGINE_ID)?.let { return it }
        val engine = super.provideFlutterEngine(context)
        FlutterEngineCache.getInstance().put(CACHED_ENGINE_ID, engine)
        return engine
    }

    override fun shouldDestroyEngineWithHost(): Boolean = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, methodChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "initialize" -> result.success(null)
                    "notifyUiLifecycleChanged" -> {
                        // Recorded for future native-side bookkeeping only (§Phase13.1 §7) -
                        // this Activity does not react to it.
                        result.success(null)
                    }
                    "requestRuntimeStatus" -> {
                        result.success(
                            mapOf(
                                "processState" to currentProcessState(),
                                "platformVersion" to "android-${Build.VERSION.RELEASE}",
                            )
                        )
                    }
                    "startBackgroundService" -> {
                        startForegroundServiceCompat(SupremeForegroundService.ACTION_START)
                        result.success(null)
                    }
                    "stopBackgroundService" -> {
                        startForegroundServiceCompat(SupremeForegroundService.ACTION_STOP)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, eventChannelName)
            .setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                        RuntimeEventBridge.attach(sink)
                    }

                    override fun onCancel(arguments: Any?) {
                        RuntimeEventBridge.detach()
                    }
                }
            )

        configurePushChannel(flutterEngine)
    }

    /**
     * §Phase13.2 §5 - the `com.supremeos/push` MethodChannel + `com.supremeos/push/events`
     * EventChannel [NativePushTokenSource] (Dart side) speaks against. Deliberately minimal:
     * `initialize()` initializes Firebase and nothing else; `currentToken()` requests a real FCM
     * token; token refresh and received messages are forwarded from
     * [SupremeFirebaseMessagingService] via [PushChannelBridge], since those callbacks fire on
     * an Android component this Activity does not own.
     *
     * HONEST STATUS: this REQUIRES a real `google-services.json` (none exists in this
     * repository - see build.gradle.kts's own note). Without one, `FirebaseApp.initializeApp`
     * throws at RUNTIME (not build time) and `initialize()` reports that failure back to Dart
     * as a normal method-channel exception rather than crashing the app.
     */
    private fun configurePushChannel(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.supremeos/push")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "initialize" -> {
                        try {
                            if (FirebaseApp.getApps(applicationContext).isEmpty()) {
                                FirebaseApp.initializeApp(applicationContext)
                            }
                            result.success(null)
                        } catch (e: Exception) {
                            result.error(
                                "firebase_init_failed",
                                "Firebase could not be initialized - see class doc for why " +
                                    "(likely: no real google-services.json configured).",
                                e.message,
                            )
                        }
                    }
                    "currentToken" -> {
                        FirebaseMessaging.getInstance().token
                            .addOnSuccessListener { token -> result.success(token) }
                            .addOnFailureListener { e ->
                                result.error("fcm_token_failed", e.message, null)
                            }
                    }
                    else -> result.notImplemented()
                }
            }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.supremeos/push/events")
            .setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                        PushChannelBridge.attach(sink)
                    }

                    override fun onCancel(arguments: Any?) {
                        PushChannelBridge.detach()
                    }
                }
            )
    }

    /**
     * §Phase13.3 "ANDROID FOREGROUND SERVICE" - a real `startForegroundService()`/plain
     * `startService()` call, chosen per the real Android 8+ (API 26+) requirement that a
     * service intending to call `startForeground()` must itself be started via
     * `startForegroundService()`, not `startService()`, on those versions.
     */
    private fun startForegroundServiceCompat(action: String) {
        val intent = Intent(this, SupremeForegroundService::class.java).setAction(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun currentProcessState(): String {
        // No reliable way to distinguish "just cold-started" from "resumed after background"
        // purely from this Activity - Dart's own `ProcessState.starting` default covers cold
        // start; this method only answers "right now."
        return "foreground"
    }

    override fun onStart() {
        super.onStart()
        RuntimeEventBridge.emitProcessStateChanged("foreground")
    }

    override fun onStop() {
        // §Phase13.1 §9 - this Activity itself still does NOT start the foreground service on
        // its own initiative; that remains an explicit Dart-driven decision
        // (`startBackgroundService()`, called from `main.dart`'s lifecycle wiring). This only
        // reports the transition so the Dart runtime's `ProcessState` reflects reality.
        RuntimeEventBridge.emitProcessStateChanged("background")
        super.onStop()
    }

    // FUTURE EXTENSION POINTS (documented, not implemented, per this phase's own scope control):
    //  - BOOT_COMPLETED restore is explicitly NOT implemented this phase - see
    //    SESSION_HANDOFF.md's Phase 13.3 section for the rationale (no user-facing "keep
    //    connected after reboot" setting exists yet to gate it).
    //  - Phase 13.4/13.5: an incoming-call event surfaced via ConnectionService, forwarded
    //    through a NEW event type on `com.supremeos/runtime/events` (`incomingCall`), never
    //    replacing `processStateChanged`/`serviceStateChanged`.
}
