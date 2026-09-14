import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// A Mobile device's persistent cryptographic identity (§Phase11-5). The
/// private key never appears here — only what the Hub/broker are allowed to
/// see: a stable [deviceId] and the Ed25519 [publicKeyBase64].
class MobileIdentity {
  final String deviceId;
  final String publicKeyBase64;

  const MobileIdentity({required this.deviceId, required this.publicKeyBase64});
}

/// Raw-bytes secret storage, injected so this pure-Dart package never
/// imports a platform API directly (§Phase11-5: "the pure Dart core must
/// not import Android/iOS platform APIs directly").
///
/// A real Flutter app supplies a platform-backed implementation:
///   - Android: Android Keystore (e.g. via a platform channel or
///     `flutter_secure_storage`, which itself delegates to Keystore).
///   - iOS: Keychain (Secure Enclave-backed where the key type allows it).
///
/// HONEST STATUS: no such adapter exists in this repo yet — only the
/// interface and a deterministic, clearly-labeled [InMemorySecretBytesStore]
/// for tests/dev. That is PRODUCTION HARDENING REQUIRED, not fabricated.
abstract class SecretBytesStore {
  Future<Uint8List?> read(String key);
  Future<void> write(String key, Uint8List bytes);
  Future<void> delete(String key);
}

/// NOT production storage — plain in-memory bytes, gone on process restart.
/// Exists only so tests and pre-platform-adapter composition can run.
class InMemorySecretBytesStore implements SecretBytesStore {
  final Map<String, Uint8List> _bytes = {};

  @override
  Future<Uint8List?> read(String key) async => _bytes[key];

  @override
  Future<void> write(String key, Uint8List bytes) async {
    _bytes[key] = bytes;
  }

  @override
  Future<void> delete(String key) async {
    _bytes.remove(key);
  }
}

/// Generates, persists (via [SecretBytesStore]), and uses a REAL Ed25519
/// keypair (§Phase11-6: "do not fake cryptography"). Signing/verification
/// here uses `package:cryptography`'s real Ed25519 implementation — this is
/// not a deterministic stand-in like [DeterministicHmacConfigVerifier].
///
/// What IS still a production gap (honestly, not silently): WHERE the
/// private key bytes live is determined entirely by the [SecretBytesStore]
/// implementation handed in at construction. Until a Flutter app wires a
/// Keystore/Keychain-backed store, private key material sits wherever that
/// store puts it (in-memory in tests, or a caller-provided store in a real
/// app) — see [SecretBytesStore] doc.
class Ed25519MobileIdentity {
  static final _algorithm = Ed25519();
  static const _privateKeyStorageKey = 'mobile_identity_private_key_v1';
  static const _deviceIdStorageKey = 'mobile_identity_device_id_v1';

  final SecretBytesStore _store;
  final String Function()? _idGenerator;

  Ed25519MobileIdentity(this._store, {String Function()? idGenerator})
      : _idGenerator = idGenerator;

  SimpleKeyPair? _cachedKeyPair;

  /// Loads the existing identity, or null if this device has never
  /// generated one.
  Future<MobileIdentity?> load() async {
    final privateBytes = await _store.read(_privateKeyStorageKey);
    final deviceIdBytes = await _store.read(_deviceIdStorageKey);
    if (privateBytes == null || deviceIdBytes == null) return null;

    final keyPair = await _algorithm.newKeyPairFromSeed(privateBytes);
    _cachedKeyPair = keyPair;
    final publicKey = await keyPair.extractPublicKey();
    return MobileIdentity(
      deviceId: utf8.decode(deviceIdBytes),
      publicKeyBase64: base64Encode(publicKey.bytes),
    );
  }

  /// Generates a NEW real Ed25519 keypair and persists it. A real app must
  /// call this at most once per device lifetime — calling it again produces
  /// a genuinely different identity, which is correct behavior (a fresh
  /// install IS a new device from the Hub's perspective), not a bug.
  Future<MobileIdentity> generateAndPersist() async {
    final keyPair = await _algorithm.newKeyPair();
    final seed = await keyPair.extractPrivateKeyBytes();
    final publicKey = await keyPair.extractPublicKey();
    final deviceId = _idGenerator?.call() ??
        'mobile-${DateTime.now().microsecondsSinceEpoch}';

    await _store.write(_privateKeyStorageKey, Uint8List.fromList(seed));
    await _store.write(
        _deviceIdStorageKey, Uint8List.fromList(utf8.encode(deviceId)));
    _cachedKeyPair = keyPair;

    return MobileIdentity(
      deviceId: deviceId,
      publicKeyBase64: base64Encode(publicKey.bytes),
    );
  }

  /// Signs [message] with the real private key. Throws [StateError] if no
  /// identity has been loaded/generated yet.
  Future<String> sign(List<int> message) async {
    final keyPair = _cachedKeyPair;
    if (keyPair == null) {
      throw StateError(
          'no Mobile identity loaded — call load() or generateAndPersist() first');
    }
    final signature = await _algorithm.sign(message, keyPair: keyPair);
    return base64Encode(signature.bytes);
  }

  /// Verifies a signature against a known public key — used by tests to
  /// prove the signing path is real, and mirrors what a real Hub/broker
  /// verifier does server-side (§Phase11-9/10, SERVER-SIDE REQUIRED there).
  static Future<bool> verify(
      {required List<int> message,
      required String signatureBase64,
      required String publicKeyBase64}) async {
    final publicKey = SimplePublicKey(base64Decode(publicKeyBase64),
        type: KeyPairType.ed25519);
    final signature =
        Signature(base64Decode(signatureBase64), publicKey: publicKey);
    return _algorithm.verify(message, signature: signature);
  }
}
