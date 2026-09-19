// Standalone Gradle project — NOT nested under apps/mobile (that module is
// Flutter-owned; this is a native Kotlin Android TV background-service app, a
// different runtime shape, per Phase 3B's "adapt to repo convention but preserve
// architectural boundaries"). Kotlin/AGP versions match apps/mobile/android's pinned
// versions for consistency across the repo's two Android build setups.
plugins {
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
