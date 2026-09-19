package com.supremedomotics.tvagent.agent

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.supremedomotics.tvagent.agent.model.AppInventoryEntry
import com.supremedomotics.tvagent.agent.protocol.AgentProtocol

/**
 * (§7/§8/§20 Phase 3B) UNVERIFIED. `PackageManager`-backed inventory — bounded to
 * `AgentProtocol.Limits.MAX_APP_INVENTORY_ENTRIES` client-side (§20 "do not rebuild the
 * entire inventory unnecessarily on every foreground event" — `snapshot()` is called
 * only at connect/reconnect (§9/§10) and on a debounced package-changed broadcast, never
 * per foreground-app change). No hardcoded allowlist of "major streaming apps" — every
 * installed application is reported (§8/§20 explicit rule), truncated (never silently
 * expanded past the limit) if a device genuinely has more than the protocol allows.
 */
class AppInventoryProvider(private val context: Context) {
    fun snapshot(): List<AppInventoryEntry> {
        val pm = context.packageManager
        val installed: List<ApplicationInfo> = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        val entries = installed.mapNotNull { appInfo ->
            val packageName = appInfo.packageName
            if (packageName.length > AgentProtocol.Limits.MAX_PACKAGE_NAME_LENGTH) return@mapNotNull null // never silently truncate identity — drop, don't corrupt
            val label = runCatching { pm.getApplicationLabel(appInfo).toString() }.getOrNull()
                ?.take(AgentProtocol.Limits.MAX_APPLICATION_NAME_LENGTH) // §8 "not every package has a friendly label" — null is honest, never invented
            val launchIntent: Intent? = pm.getLaunchIntentForPackage(packageName)
            AppInventoryEntry(
                packageName = packageName,
                applicationName = label,
                version = runCatching { pm.getPackageInfo(packageName, 0).versionName }.getOrNull(),
                launchable = launchIntent != null,
                installed = true,
            )
        }
        // §7/§11 bounded — truncation (never an unbounded array) if a device somehow
        // exceeds the protocol's limit; SupremeOS never sees more than it can safely accept.
        return entries.take(AgentProtocol.Limits.MAX_APP_INVENTORY_ENTRIES)
    }

    /** §20 "handle package install/removal/update" without rebuilding on every
     * foreground event — a real implementation registers a `BroadcastReceiver` for
     * `ACTION_PACKAGE_ADDED`/`REMOVED`/`REPLACED` and debounces bursts (e.g. a Play
     * Store batch-update) before calling `snapshot()` again. Left as an explicit
     * follow-up: the receiver registration/unregistration needs a `Context` lifecycle
     * this class doesn't yet own (see SupremeOsAgentService's TODO). */
    fun registerPackageChangeListener(onChanged: () -> Unit): AutoCloseable {
        // TODO(Phase 3B follow-up): real BroadcastReceiver registration + debounce timer.
        return AutoCloseable { }
    }
}
