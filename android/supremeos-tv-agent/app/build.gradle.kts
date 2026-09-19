plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.supremedomotics.tvagent"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.supremedomotics.tvagent"
        // Android TV / Google TV only — this Agent is not a phone/tablet app.
        minSdk = 24 // Android 7.0 (Nougat) — the oldest Android TV OS version still realistically deployed
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        // No Compose/View layer needed — this Agent is a background service with no
        // UI beyond a minimal pairing-code entry screen (not yet implemented; see
        // PairingManager.kt's doc comment).
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.security:security-crypto:1.1.0-alpha06") // Keystore-backed EncryptedSharedPreferences (§3)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
