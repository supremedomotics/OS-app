/// Multi-Hub Mobile/Tablet Home management (§Phase12.1). Deliberately Mobile/Tablet-only —
/// nothing here is imported by `apps/new/touchpanel`, which remains a fixed, Hub-authoritative
/// endpoint with no concept of "multiple paired Homes" (§20).
///
/// The load-bearing distinction this file exists to enforce (§2, §8): [PairedHome.hubId] and
/// [PairedHome.projectId] are the CANONICAL, security-relevant identity — the same values
/// `HubIdentity` (`transport.dart`) and every authorization/broker/routing check already use.
/// [PairedHome.displayName] is a purely local, user-editable alias with NO security meaning —
/// it is never compared, hashed, or sent anywhere that decides access. Renaming a Home is a
/// `copyWith` that touches nothing else.
library;

/// One Home the Mobile/Tablet has paired with. Holds only non-sensitive relationship
/// metadata (§7) — no private key, no bearer token. The actual Mobile cryptographic identity
/// stays under `Ed25519MobileIdentity`/`SecretBytesStore` (Phase 11); the actual per-Home
/// session token stays wherever `AuthorizedMobileSession` for that Home is held (a future,
/// still-PRODUCTION-HARDENING-REQUIRED secure per-Home token store — seeSESSION_HANDOFF.md).
class PairedHome {
  /// Canonical Hub identity (matches `HubIdentity.hubId`) — NEVER derived from or equal to
  /// [displayName], and never itself shown as the primary UI label.
  final String hubId;
  final String projectId;

  /// Local, user-editable presentation alias. Security-irrelevant by construction: nothing in
  /// this file (or anywhere in the connection/authorization stack) reads this field to decide
  /// access, routing, or identity.
  final String displayName;

  final DateTime pairedAt;
  final DateTime? lastUsedAt;

  /// §Phase12.10 — the homeowner's own explicit choice for THIS Home, OFF by default (§3: never
  /// silently enabled). Non-sensitive (no broker URL/public key/token lives here — those stay
  /// in `AuthorizedMobileSession`/`RemoteHubConfig`), so it is safe to persist alongside the
  /// rest of this non-sensitive relationship metadata.
  final bool remoteAccessEnabled;

  const PairedHome({
    required this.hubId,
    required this.projectId,
    required this.displayName,
    required this.pairedAt,
    this.lastUsedAt,
    this.remoteAccessEnabled = false,
  });

  PairedHome copyWith(
          {String? displayName,
          DateTime? lastUsedAt,
          bool? remoteAccessEnabled}) =>
      PairedHome(
        hubId: hubId,
        projectId: projectId,
        displayName: displayName ?? this.displayName,
        pairedAt: pairedAt,
        lastUsedAt: lastUsedAt ?? this.lastUsedAt,
        remoteAccessEnabled: remoteAccessEnabled ?? this.remoteAccessEnabled,
      );

  Map<String, dynamic> toJson() => {
        'hubId': hubId,
        'projectId': projectId,
        'displayName': displayName,
        'pairedAt': pairedAt.toIso8601String(),
        'lastUsedAt': lastUsedAt?.toIso8601String(),
        'remoteAccessEnabled': remoteAccessEnabled,
      };

  static PairedHome fromJson(Map<String, dynamic> json) => PairedHome(
        hubId: json['hubId'] as String,
        projectId: json['projectId'] as String,
        displayName: json['displayName'] as String,
        pairedAt: DateTime.parse(json['pairedAt'] as String),
        lastUsedAt: json['lastUsedAt'] != null
            ? DateTime.parse(json['lastUsedAt'] as String)
            : null,
        // Absent in any Home persisted before §Phase12.10 → OFF, never silently ON.
        remoteAccessEnabled: json['remoteAccessEnabled'] as bool? ?? false,
      );
}

/// Validates/sanitizes a user-entered Home display name (§6: "validate empty names, trim
/// whitespace, reasonable maximum length, prevent accidental whitespace-only names").
class HomeNameValidation {
  static const maxLength = 40;

  /// Returns a human-readable error, or null if [raw] (after trimming) is acceptable.
  static String? validate(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return 'Home name cannot be empty';
    if (trimmed.length > maxLength)
      return 'Home name is too long (max $maxLength characters)';
    return null;
  }

  static String sanitize(String raw) => raw.trim();
}

/// Persists the paired-Home list and the active Home selection. Deliberately NOT the place
/// sensitive credentials live (§7/§21) — implementations back this with ordinary local
/// storage (e.g. `shared_preferences` in `apps/new/mobile`, not shown here since this package
/// stays pure Dart / Flutter-free).
abstract class PairedHomeStore {
  Future<List<PairedHome>> loadAll();
  Future<void> saveAll(List<PairedHome> homes);
  Future<String?> loadActiveHomeId();
  Future<void> saveActiveHomeId(String? hubId);
}

/// NOT persisted across process restarts — for tests and pre-platform-store composition,
/// same pattern as `InMemorySecretBytesStore`/`InMemoryDeviceIdentityStore`.
class InMemoryPairedHomeStore implements PairedHomeStore {
  List<PairedHome> _homes = [];
  String? _activeHomeId;

  @override
  Future<List<PairedHome>> loadAll() async => List.unmodifiable(_homes);

  @override
  Future<void> saveAll(List<PairedHome> homes) async {
    _homes = List.of(homes);
  }

  @override
  Future<String?> loadActiveHomeId() async => _activeHomeId;

  @override
  Future<void> saveActiveHomeId(String? hubId) async {
    _activeHomeId = hubId;
  }
}

/// The Mobile/Tablet-side source of truth for "which Homes am I paired with, and which one
/// is active right now" (§9/§10/§11). Pure logic — no Flutter, no networking — so it is fully
/// unit-testable and reusable identically by Mobile and Tablet (§18: "use the same core model
/// and storage abstraction").
///
/// Deliberately does NOT own a `ConnectionManager` or any transport concept (§25): the
/// composition root reads [activeHome] and constructs/points the existing `ConnectionManager`
/// at that Home's `hubId` — this class only ever answers "which Home," never "how connected."
class PairedHomeManager {
  final PairedHomeStore store;
  List<PairedHome> _homes = [];
  String? _activeHomeId;

  PairedHomeManager(this.store);

  List<PairedHome> get homes => List.unmodifiable(_homes);

  /// Never a display name (§10) — always the canonical `hubId`, or null if no Home has ever
  /// been selected (§23: no fabricated default Home).
  String? get activeHomeId => _activeHomeId;

  PairedHome? get activeHome {
    final id = _activeHomeId;
    if (id == null) return null;
    for (final h in _homes) {
      if (h.hubId == id) return h;
    }
    return null;
  }

  /// Loads persisted state. Never auto-selects a different Home than what was persisted
  /// (§22: "the selected Home remains selected") — if the previously-active Home was removed
  /// since the last run, [activeHome] simply returns null; nothing here guesses a substitute.
  Future<void> load() async {
    _homes = List.of(await store.loadAll());
    _activeHomeId = await store.loadActiveHomeId();
  }

  bool isPaired(String hubId) => _homes.any((h) => h.hubId == hubId);

  /// Registers a Home this Mobile has ALREADY completed a real pairing ceremony for (§13: "the
  /// pairing operation must create a genuine authorization relationship" — that authorization
  /// itself happens elsewhere, via Phase 11/12's `PairingClient`/`AuthorizedMobileSession`;
  /// this method only records the resulting relationship for the Home switcher/list).
  Future<PairedHome> addHome({
    required String hubId,
    required String projectId,
    required String displayName,
  }) async {
    if (isPaired(hubId)) {
      throw StateError('This Home is already paired on this device');
    }
    final error = HomeNameValidation.validate(displayName);
    final home = PairedHome(
      hubId: hubId,
      projectId: projectId,
      displayName:
          error == null ? HomeNameValidation.sanitize(displayName) : 'Home',
      pairedAt: DateTime.now(),
    );
    _homes = [..._homes, home];
    await store.saveAll(_homes);
    // First-ever paired Home becomes active automatically (reasonable default — still never a
    // FABRICATED Home, §23, since it only fires once a genuine pairing has succeeded).
    if (_activeHomeId == null) {
      await setActiveHome(hubId);
    }
    return home;
  }

  Future<void> renameHome(String hubId, String newDisplayName) async {
    final error = HomeNameValidation.validate(newDisplayName);
    if (error != null) throw ArgumentError(error);
    if (!isPaired(hubId)) throw StateError('Unknown Home');
    _homes = [
      for (final h in _homes)
        if (h.hubId == hubId)
          h.copyWith(displayName: HomeNameValidation.sanitize(newDisplayName))
        else
          h,
    ];
    await store.saveAll(_homes);
  }

  /// "Forget this Home on this device" (§15) — local removal only. Deliberately does NOT call
  /// any Hub-side revocation API; that is a separate, explicit, authenticated action the UI
  /// layer offers on its own (§15/§16), never implied by this method.
  Future<void> removeHome(String hubId) async {
    _homes = _homes.where((h) => h.hubId != hubId).toList();
    await store.saveAll(_homes);
    if (_activeHomeId == hubId) {
      _activeHomeId = null;
      await store.saveActiveHomeId(null);
    }
  }

  /// §Phase12.10 §3 — the ONLY way this flag ever changes: an explicit homeowner action for
  /// THIS Home. Nothing in the connection/runtime layer ever calls this on the homeowner's
  /// behalf (never a silent/automatic enable).
  Future<void> setRemoteAccessEnabled(String hubId, bool enabled) async {
    if (!isPaired(hubId)) throw StateError('Unknown Home');
    _homes = [
      for (final h in _homes)
        if (h.hubId == hubId) h.copyWith(remoteAccessEnabled: enabled) else h,
    ];
    await store.saveAll(_homes);
  }

  Future<void> setActiveHome(String hubId) async {
    if (!isPaired(hubId)) throw StateError('Unknown Home');
    _activeHomeId = hubId;
    _homes = [
      for (final h in _homes)
        if (h.hubId == hubId) h.copyWith(lastUsedAt: DateTime.now()) else h,
    ];
    await store.saveAll(_homes);
    await store.saveActiveHomeId(hubId);
  }
}
