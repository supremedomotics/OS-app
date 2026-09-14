import 'pairing.dart';

/// Per-Home authorization/session storage (§Phase12.2 §9/§10/§24) — deliberately SEPARATE
/// from [PairedHome] itself, which stays non-sensitive metadata only. A [MobileAuthorization]
/// (which carries the bearer `token`) is scoped to exactly one `hubId`; this store is the
/// thing that makes "Home A's credential can never authorize Home B" a structural property
/// rather than a discipline every caller has to remember (§10, §31: "a display name must
/// never become security-sensitive" — equally, one Home's token must never leak into
/// another's lookup by construction, not by convention).
///
/// HONEST STATUS: the in-memory implementation below is NOT persisted across app restarts —
/// deliberately. Phase 11 already documented that production secure storage for Mobile
/// identity/session material (Android Keystore / iOS Keychain) does not exist yet
/// (`SecretBytesStore`, PRODUCTION HARDENING REQUIRED); until it does, holding a per-Home
/// bearer token only in memory is the honest choice — the alternative (writing a real bearer
/// token into ordinary `SharedPreferences`, as `PairedHome`'s own metadata store uses) would
/// be a real regression Phase 12.2 explicitly must not introduce (§24: "do not store bearer
/// tokens... in the Home metadata SharedPreferences store"). The practical consequence: a
/// paired Home requires re-authentication after every app restart until a secure store lands
/// — this is bounded, honest, and testable, not silently unsafe.
abstract class PairedHomeAuthorizationStore {
  AuthorizedMobileSession? sessionFor(String hubId);
  void putSession(String hubId, AuthorizedMobileSession session);
  void clearSession(String hubId);
}

/// The only implementation today — process-memory only, gone on restart (see class doc above).
class InMemoryPairedHomeAuthorizationStore
    implements PairedHomeAuthorizationStore {
  final Map<String, AuthorizedMobileSession> _sessions = {};

  @override
  AuthorizedMobileSession? sessionFor(String hubId) => _sessions[hubId];

  @override
  void putSession(String hubId, AuthorizedMobileSession session) {
    _sessions[hubId] = session;
  }

  @override
  void clearSession(String hubId) {
    _sessions.remove(hubId);
  }
}
