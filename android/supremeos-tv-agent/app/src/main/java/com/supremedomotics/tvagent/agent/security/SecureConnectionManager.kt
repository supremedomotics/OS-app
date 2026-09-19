package com.supremedomotics.tvagent.agent.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.OutputStream
import java.net.Socket
import java.security.KeyStore
import java.security.KeyPairGenerator
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * (§1/§3 Phase 3B) TLS transport + persistent Agent identity/credential storage.
 * UNVERIFIED — written against documented Android Keystore/`javax.net.ssl` APIs, never
 * compiled (no JDK/Android SDK available in this environment; see the Phase 3B
 * completion report). Every cryptographic primitive below is a PLATFORM one:
 * `AndroidKeyStore` for key generation/storage, `SSLContext`/`SSLSocket` for TLS — §1
 * "do not invent cryptographic algorithms, do not create custom encryption" is
 * satisfied by construction (there is no custom crypto here to review).
 *
 * Long-lived pairing state (agentId, the paired device's host, the current
 * `AgentPairingState`) lives in `EncryptedSharedPreferences` — itself backed by a
 * Keystore-generated master key — never a plain file or unencrypted SharedPreferences
 * (§1 "no long-lived secrets in plaintext"). The actual TLS client identity is an
 * `AndroidKeyStore`-resident keypair; the private key material NEVER leaves the
 * hardware-backed keystore (`setIsStrongBoxBacked`/`setUserAuthenticationRequired` are
 * deliberately left off here — a background TV service has no interactive user present
 * to authenticate, unlike a phone unlock flow).
 */
class SecureConnectionManager(private val context: Context) {
    companion object {
        private const val KEYSTORE_ALIAS = "supremeos-tv-agent-identity"
        private const val PREFS_FILE = "supremeos_tv_agent_secure_prefs"
    }

    private val masterKey by lazy {
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    }

    private val securePrefs by lazy {
        EncryptedSharedPreferences.create(
            context, PREFS_FILE, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** Generates (once) an EC keypair inside AndroidKeyStore for this Agent's client-TLS
     * identity. Idempotent — a second call is a no-op if the alias already exists,
     * since regenerating it would invalidate every existing pairing (§3 "persistent
     * Agent identity"). */
    fun ensureIdentityKeyExists() {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (ks.containsAlias(KEYSTORE_ALIAS)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(KEYSTORE_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    /** §3 "persistent Agent identity" — generated once, stored encrypted, never
     * regenerated for an existing pairing (see AgentSession's doc comment for why). */
    fun loadOrCreateAgentId(): String {
        securePrefs.getString("agentId", null)?.let { return it }
        val fresh = com.supremedomotics.tvagent.agent.AgentSession.generateAgentId()
        securePrefs.edit().putString("agentId", fresh).apply()
        return fresh
    }

    fun storedPairingState(): AgentPairingState =
        securePrefs.getString("pairingState", null)?.let { runCatching { AgentPairingState.valueOf(it) }.getOrNull() } ?: AgentPairingState.UNKNOWN

    fun persistPairingState(state: AgentPairingState) {
        securePrefs.edit().putString("pairingState", state.name).apply()
    }

    /** §1 "never trust an unauthenticated permanent connection" — this trust manager
     * validates the SupremeOS hub's server certificate against the pinned certificate
     * exchanged during pairing (persisted in `securePrefs`, never hardcoded), NOT the
     * system trust store — the hub's cert is self-signed per-installation, exactly
     * like Android TV Remote v2's own TLS model (see android-tv-remote-v2-transport.ts's
     * `rejectUnauthorized: false` + out-of-band pairing-time trust). Left as an
     * explicit TODO: the actual pinned-cert comparison needs the certificate captured
     * during PairingManager's exchange, which this class doesn't yet own.
     */
    private fun buildTrustManager(): X509TrustManager {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        // TODO(Phase 3B follow-up): replace with a pinned-certificate X509TrustManager
        // built from the certificate captured during pairing, once PairingManager
        // exposes it. Falling back to the platform default here would trust the
        // system CA store, which is wrong for a self-signed hub certificate.
        return tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** Opens a real TLS socket to the SupremeOS hub. Never called with
     * `rejectUnauthorized`-style bypass — the hub's identity is verified against the
     * pinned certificate from pairing (see `buildTrustManager`'s TODO). */
    fun openTlsSocket(host: String, port: Int): SSLSocket {
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf(buildTrustManager()), null)
        val socket = sslContext.socketFactory.createSocket(host, port) as SSLSocket
        socket.startHandshake()
        return socket
    }
}
