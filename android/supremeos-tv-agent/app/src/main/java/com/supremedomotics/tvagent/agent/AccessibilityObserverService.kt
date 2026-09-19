package com.supremedomotics.tvagent.agent

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import com.supremedomotics.tvagent.agent.model.ForegroundAppState
import com.supremedomotics.tvagent.agent.model.ForegroundSource
import com.supremedomotics.tvagent.agent.model.MediaConfidence

/**
 * (§5/§6/§19 Phase 3B) UNVERIFIED. The primary ForegroundAppObserver mechanism — an
 * `AccessibilityService` observing `TYPE_WINDOW_STATE_CHANGED` events, per §5 (never
 * OCR/screenshots/coordinate-based scraping, §5/§22 explicit prohibition). OPTIONAL:
 * the whole Agent (MediaSession feedback, device info, app inventory, connection
 * itself) must keep working with this service entirely absent/disabled — enforced
 * structurally by `ForegroundAppObserver` below never being a hard dependency of
 * `SupremeOsAgentService`, only an enhancement it queries if bound.
 *
 * This is a bound `AccessibilityService`, a separate Android component from
 * `SupremeOsAgentService` (a plain foreground Service) — the user enables it explicitly
 * via Settings > Accessibility, matching §6's "requires explicit user consent."
 */
class AccessibilityObserverService : AccessibilityService() {
    private var listener: ((ForegroundAppState) -> Unit)? = null

    fun setListener(l: (ForegroundAppState) -> Unit) {
        listener = l
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val packageName = event.packageName?.toString() ?: return
        // §5 "report the package name rather than inventing a friendly name" when only
        // the package is known — application-name resolution is StatePublisher's job
        // (via PackageManager), kept out of this observer to match §17's independence
        // requirement between observers.
        listener?.invoke(
            ForegroundAppState(
                packageName = packageName,
                applicationName = null,
                source = ForegroundSource.AGENT_ACCESSIBILITY,
                confidence = MediaConfidence.APP_ONLY,
            ),
        )
    }

    override fun onInterrupt() {
        // §22 "every registration has a matching unregister" — the platform itself
        // tears down this service's event stream on interrupt; nothing additional to
        // release here since this class holds no sockets/timers of its own.
    }
}

/** §19 the availability-reporting contract every ForegroundAppObserver caller checks
 * before treating this service's output as trustworthy — "unknown" is never silently
 * reported as a detected app. */
object ForegroundAppObserver {
    fun isAccessibilityServiceEnabled(context: android.content.Context, serviceComponent: android.content.ComponentName): Boolean {
        val enabledServices = android.provider.Settings.Secure.getString(
            context.contentResolver,
            android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabledServices.contains(serviceComponent.flattenToString())
    }
}
