pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
    // §Phase13.2 §5 — declared here (not applied) per the standard Flutter/Gradle plugin
    // pattern; applied in app/build.gradle.kts. REQUIRES a real android/app/google-services.json
    // from an actual Firebase project — none exists in this repository (no credentials were
    // fabricated to satisfy this). Until one is added, any Android Gradle sync/build will fail
    // at this plugin's apply step — that is Firebase's own standard, correct behavior for a
    // real integration, not a bug introduced here.
    id("com.google.gms.google-services") version "4.4.2" apply false
}

include(":app")
