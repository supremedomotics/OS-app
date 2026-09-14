import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Production secure storage (§Phase12.3 "SECURE STORAGE") — real Android Keystore / iOS
/// Keychain backing via `flutter_secure_storage`, which is the standard, widely-used Flutter
/// wrapper around exactly those two platform mechanisms (`EncryptedSharedPreferences`/Keystore
/// on Android, Keychain on iOS/macOS). This is what Phase 11's `SecretBytesStore` interface was
/// always waiting for — no change to that interface was needed, only a real implementation.
///
/// Replaces `InMemorySecretBytesStore` at the composition root for the Mobile private key
/// (`Ed25519MobileIdentity`). Bytes are stored base64-encoded since `flutter_secure_storage`'s
/// API is string-keyed/string-valued.
class SecureSecretBytesStore implements SecretBytesStore {
  final FlutterSecureStorage _storage;

  SecureSecretBytesStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  @override
  Future<Uint8List?> read(String key) async {
    final raw = await _storage.read(key: key);
    if (raw == null) return null;
    return base64Decode(raw);
  }

  @override
  Future<void> write(String key, Uint8List bytes) async {
    await _storage.write(key: key, value: base64Encode(bytes));
  }

  @override
  Future<void> delete(String key) async {
    await _storage.delete(key: key);
  }
}

/// Production secure storage for PER-HOME authorization/session material (§Phase12.2 §9/§24,
/// §Phase12.3 "SECURE STORAGE" — "per-Home authorization/session material"). Replaces
/// `InMemoryPairedHomeAuthorizationStore` at the composition root: a paired Home's bearer
/// token now survives an app restart, kept ONLY in the platform secure store — never in
/// `SharedPreferences` (which is where `PairedHome`'s own, deliberately non-sensitive,
/// metadata lives — see `SharedPrefsPairedHomeStore`'s own doc on that split).
///
/// Keyed by `hubId` (never display name) — the same isolation `InMemoryPairedHomeAuthorizationStore`
/// already enforced in memory now holds across restarts too.
class SecurePairedHomeAuthorizationStore
    implements PairedHomeAuthorizationStore {
  static const _keyPrefix = 'supreme_home_authorization_';
  final FlutterSecureStorage _storage;

  /// In-process cache so `sessionFor` can stay synchronous (matching the existing
  /// `PairedHomeAuthorizationStore` interface, which Phase 12.2 deliberately kept synchronous
  /// for simplicity) while writes still land in real secure storage. `hydrate()` fills this
  /// cache once at startup by reading every known Home's slot back from the platform store.
  final Map<String, AuthorizedMobileSession> _cache = {};

  SecurePairedHomeAuthorizationStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  /// Reads back whatever sessions the platform secure store already has for the given
  /// `hubId`s (call once at startup with the currently-paired Homes' ids — §Phase12.3
  /// "RESTART persistence").
  Future<void> hydrate(Iterable<String> hubIds) async {
    for (final hubId in hubIds) {
      final raw = await _storage.read(key: '$_keyPrefix$hubId');
      if (raw == null) continue;
      try {
        final json = jsonDecode(raw) as Map<String, dynamic>;
        _cache[hubId] = AuthorizedMobileSession(MobileAuthorization(
          mobileId: json['mobileId'] as String,
          hubId: json['hubId'] as String,
          projectId: json['projectId'] as String,
          token: json['token'] as String,
          issuedAt: DateTime.parse(json['issuedAt'] as String),
          expiresAt: json['expiresAt'] != null
              ? DateTime.parse(json['expiresAt'] as String)
              : null,
        ));
      } catch (_) {
        // A corrupt/unreadable slot is treated as "no session" — re-pairing is the honest
        // recovery, never a fabricated session.
      }
    }
  }

  @override
  AuthorizedMobileSession? sessionFor(String hubId) => _cache[hubId];

  @override
  void putSession(String hubId, AuthorizedMobileSession session) {
    _cache[hubId] = session;
    final a = session.authorization;
    unawaited(_storage.write(
      key: '$_keyPrefix$hubId',
      value: jsonEncode({
        'mobileId': a.mobileId,
        'hubId': a.hubId,
        'projectId': a.projectId,
        'token': a.token,
        'issuedAt': a.issuedAt.toIso8601String(),
        'expiresAt': a.expiresAt?.toIso8601String(),
      }),
    ));
  }

  @override
  void clearSession(String hubId) {
    _cache.remove(hubId);
    unawaited(_storage.delete(key: '$_keyPrefix$hubId'));
  }
}
