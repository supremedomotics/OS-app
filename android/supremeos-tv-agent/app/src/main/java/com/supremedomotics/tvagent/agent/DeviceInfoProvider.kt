package com.supremedomotics.tvagent.agent

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.supremedomotics.tvagent.agent.model.DeviceInfo

/**
 * (§8/§18/§17 Phase 3B) UNVERIFIED. Static-ish device facts via `android.os.Build` —
 * no unnecessary sensitive identifiers (no IMEI/serial/advertising ID — §8 "do not
 * expose unnecessary sensitive identifiers"). `osName` distinguishes Google TV from
 * plain Android TV via the `PackageManager` feature flag Google TV devices declare,
 * per §20 "record actual observed API behavior rather than assuming documentation" —
 * this flag's presence is Google's documented signal, but its accuracy across every
 * OEM build is exactly the kind of thing Phase 3B's hardware gate must confirm before
 * this is trusted (see completion report's platform-coverage note).
 */
class DeviceInfoProvider(private val context: Context) {
    fun current(agentVersion: String, supportedFeedbackMechanisms: List<String>): DeviceInfo {
        val pm = context.packageManager
        val isGoogleTv = pm.hasSystemFeature("com.google.android.feature.GOOGLE_BUILD") ||
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) && Build.MANUFACTURER.equals("Google", ignoreCase = true)
        return DeviceInfo(
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            osName = if (isGoogleTv) "google_tv" else "android_tv",
            apiLevel = Build.VERSION.SDK_INT,
            agentVersion = agentVersion,
            supportedFeedbackMechanisms = supportedFeedbackMechanisms,
        )
    }
}
