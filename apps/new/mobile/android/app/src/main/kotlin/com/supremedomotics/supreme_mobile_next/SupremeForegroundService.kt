package com.supremedomotics.supreme_mobile_next

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * SupremeOS Phase 13.3 - Android Foreground Service.
 *
 * A NATIVE Android construct only - it holds NO Dart isolate, NO FlutterEngine, and NO
 * SupremeOS semantic state (§"FLUTTER ENGINE / DART RUNTIME": "there must be one authoritative
 * runtime model per application process"). Its entire job is to raise this process's priority
 * and exempt it from most Doze/App-Standby network restrictions while the app is backgrounded,
 * so the EXISTING Flutter engine (cached across Activity recreation by
 * [MainActivity.provideFlutterEngine]/[MainActivity.shouldDestroyEngineWithHost]) keeps running
 * the SAME `RuntimeController`/`MobileRuntime` instance and its already-open
 * `HomeEventStreamSession`(s) uninterrupted. There is exactly ONE Dart runtime for the process;
 * this Service does not create, wrap, or duplicate it.
 *
 * Started/stopped ONLY by an explicit Dart-driven request via [MainActivity]'s
 * `com.supremeos/runtime` MethodChannel (`startBackgroundService`/`stopBackgroundService`) -
 * never by itself, never by a BroadcastReceiver, never automatically on boot (§"BOOT COMPLETED":
 * not implemented this phase - see that section's own note). `onStartCommand` returns
 * `START_NOT_STICKY` so Android never silently resurrects it without a fresh, explicit request.
 */
class SupremeForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.supremedomotics.supreme_mobile_next.action.START"
        const val ACTION_STOP = "com.supremedomotics.supreme_mobile_next.action.STOP"
        private const val CHANNEL_ID = "supremeos_home_connection"
        private const val NOTIFICATION_ID = 1001

        /** Process-wide flag [MainActivity] reads to answer `requestRuntimeStatus` and to avoid
         * issuing a redundant start Intent - not a substitute for Android's own service
         * lifecycle, just a cheap local mirror of it. */
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannelIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelfCleanly()
                return START_NOT_STICKY
            }
            else -> {
                RuntimeEventBridge.emitServiceStateChanged("starting")
                startForegroundCompat()
                isRunning = true
                RuntimeEventBridge.emitServiceStateChanged("running")
            }
        }
        // §"no uncontrolled always-running service" - if Android kills this process, the
        // Service is NOT automatically restarted; the Home connection resumes the normal way
        // (a fresh app launch, or the existing Phase 12 reconnect logic) once the app runs again.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        RuntimeEventBridge.emitServiceStateChanged("stopped")
        super.onDestroy()
    }

    private fun stopSelfCleanly() {
        RuntimeEventBridge.emitServiceStateChanged("stopping")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        // onDestroy() emits the final "stopped" state and clears isRunning.
    }

    /**
     * §"NOTIFICATION UX" - calm, professional, zero protocol/technical detail. Tapping it
     * simply reopens the app (existing MainActivity launch Intent) - no special deep link, no
     * SIP/device terminology.
     */
    private fun startForegroundCompat() {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SupremeOS")
            .setContentText("Keeping your Home connected")
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ (API 34) requires an explicit foreground service TYPE matching the
            // real work being done - `DATA_SYNC` fits "maintain an open connection to deliver
            // Home state," matching the AndroidManifest.xml service declaration's own type.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Home connection",
            NotificationManager.IMPORTANCE_LOW, // silent - never interrupts, per §"NOTIFICATION UX"
        )
        manager.createNotificationChannel(channel)
    }
}
