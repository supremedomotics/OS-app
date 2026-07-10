import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import 'cloud/multi_home.dart';
import 'room_image.dart';

/// The app's local key/value store, initialised once in main() and injected here so providers can
/// read a persisted value synchronously at creation. Overridden in ProviderScope; the fallback
/// throw makes a missing override a loud programmer error rather than silent data loss.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw StateError('sharedPreferencesProvider must be overridden in main()'),
);

/// Riverpod wiring over the generated Supreme SDK (§11.3). Optimistic updates are
/// reconciled by the WSS state stream. State is held in Supreme terms only.

/// Resolve a room's display photo: the hub-stored photo when present (identical everywhere), else a
/// real interior photo fetched client-side from Openverse. Null → the caller shows the designed
/// gradient. Keyed by the room's identity so it's cached and fetched once.
typedef RoomKey = ({String name, String? areaType, String? heroImageUrl});
final roomPhotoProvider = FutureProvider.family<String?, RoomKey>((ref, room) async {
  final client = ref.read(clientProvider);
  final hub = client.heroImageSrc(room.heroImageUrl);
  if (hub != null) return hub;
  return fetchRoomPhoto(room.name, room.areaType);
});

/// Appearance (§11.2 Themes): base palette mode (Luxury Black / White / Automatic) and
/// the accent ramp (Gold / Silver). Persisted to local prefs so the choice survives restarts; the
/// MaterialApp rebuilds on change. Read with watch(); change with read(provider.notifier).set(...).
class ThemeModeNotifier extends Notifier<ThemeMode> {
  @override
  ThemeMode build() {
    final saved = ref.watch(sharedPreferencesProvider).getString('appearance.themeMode');
    return ThemeMode.values.where((m) => m.name == saved).firstOrNull ?? ThemeMode.dark;
  }

  void set(ThemeMode mode) {
    state = mode;
    ref.read(sharedPreferencesProvider).setString('appearance.themeMode', mode.name);
  }
}

final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);

class AccentNotifier extends Notifier<AureonAccent> {
  @override
  AureonAccent build() {
    final saved = ref.watch(sharedPreferencesProvider).getString('appearance.accent');
    return AureonAccent.values.where((a) => a.name == saved).firstOrNull ?? AureonAccent.gold;
  }

  void set(AureonAccent accent) {
    state = accent;
    ref.read(sharedPreferencesProvider).setString('appearance.accent', accent.name);
  }
}

final accentProvider = NotifierProvider<AccentNotifier, AureonAccent>(AccentNotifier.new);

/// The homeowner's custom scene order (ids), set in the Scenes "Edit" mode. Persisted to local prefs
/// so the arrangement survives restarts. Read with watch(); change with notifier.set(...).
class SceneOrderNotifier extends Notifier<List<String>> {
  static const _key = 'scenes.order';

  @override
  List<String> build() => ref.watch(sharedPreferencesProvider).getStringList(_key) ?? const [];

  void set(List<String> ids) {
    state = ids;
    ref.read(sharedPreferencesProvider).setStringList(_key, ids);
  }
}

final sceneOrderProvider = NotifierProvider<SceneOrderNotifier, List<String>>(SceneOrderNotifier.new);

/// Hub base URL — resolved automatically from the ACTIVE home's connection (verified mDNS
/// LAN-direct when on the home's network, else the cloud Tunnel Broker route; blueprint §8,
/// §16). Falls back to the local gateway for Phase-0 dev / before any home is selected. Every
/// screen reads this, so switching homes or transports is transparent.
final hubBaseUrlProvider = Provider<String>((ref) {
  final conn = ref.watch(homeConnectionProvider);
  return conn?.baseUrl ?? 'http://127.0.0.1:8080';
});
final hubWsUrlProvider = Provider<String>((ref) {
  final conn = ref.watch(homeConnectionProvider);
  return conn?.wsUrl ?? 'ws://127.0.0.1:8080';
});

/// How the active home is currently reached (local / cloud / offline) — surfaced in the UI as
/// a small status affordance.
final connectionModeProvider = Provider<ConnectionMode>((ref) {
  return ref.watch(homeConnectionProvider)?.mode ?? ConnectionMode.offline;
});

/// Session persistence (§ "stay signed in"): the homeowner stays logged in across app restarts —
/// closing/reopening the app must NOT sign them out — until they explicitly log out. The access
/// token is short-lived (15 min) but the refresh token lasts 30 days and is what we persist; the SDK
/// refreshes-and-retries silently on every request. Refresh tokens are ROTATED server-side (each use
/// invalidates the old one), so [onTokensChanged] re-persists on every login AND every silent refresh
/// — not just at login — or a stale rotated-out token would get the session revoked on next launch.
const _kAccessTokenKey = 'auth.accessToken';
const _kRefreshTokenKey = 'auth.refreshToken';

final clientProvider = Provider<SupremeClient>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final client = SupremeClient(
    baseUrl: ref.watch(hubBaseUrlProvider),
    onTokensChanged: (accessToken, refreshToken) {
      prefs.setString(_kAccessTokenKey, accessToken);
      prefs.setString(_kRefreshTokenKey, refreshToken);
    },
    onSessionExpired: () {
      // The refresh token itself was rejected (revoked / truly expired) — the session is genuinely
      // over; only now do we drop to the login screen and clear the stale persisted pair.
      prefs.remove(_kAccessTokenKey);
      prefs.remove(_kRefreshTokenKey);
      ref.read(sessionActiveProvider.notifier).state = false;
    },
  );
  final savedAccess = prefs.getString(_kAccessTokenKey);
  final savedRefresh = prefs.getString(_kRefreshTokenKey);
  if (savedAccess != null && savedRefresh != null) {
    client.restoreTokens(accessToken: savedAccess, refreshToken: savedRefresh);
  }
  // Reuse the cloud session token across homes: when present, a client pointed at a newly
  // resolved hub (local or cloud) is already authenticated — no re-login on a home switch.
  final session = ref.watch(cloudSessionProvider);
  if (session != null) client.accessToken = session.accessToken;
  return client;
});

/// Sign out of this device: clears the in-memory session, the persisted token pair, and drops to
/// the login screen. The ONLY other way [sessionActiveProvider] goes false is a genuinely dead
/// refresh token (see `onSessionExpired` above) — never a routine access-token rotation.
Future<void> logOut(WidgetRef ref) async {
  ref.read(clientProvider).clearSession();
  final prefs = ref.read(sharedPreferencesProvider);
  await prefs.remove(_kAccessTokenKey);
  await prefs.remove(_kRefreshTokenKey);
  ref.read(sessionActiveProvider.notifier).state = false;
}

/// Holds the live WSS stream once authenticated.
final streamProvider = StateProvider<SupremeStream?>((ref) => null);

/// The signed-in user (for a personal greeting). Shape: { user: { displayName, email, … } }.
final meProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(clientProvider).me();
});

/// The home topology, loaded after login.
final homeProvider = FutureProvider<HomeView>((ref) async {
  final client = ref.watch(clientProvider);
  return client.home();
});

/// Devices in a room, kept fresh by merging WSS state deltas.
final roomDevicesProvider =
    FutureProvider.family<List<Device>, String>((ref, roomId) async {
  final client = ref.watch(clientProvider);
  return client.devicesInRoom(roomId);
});

/// Scenes available to the current user (§10).
final scenesProvider = FutureProvider<List<Scene>>((ref) async {
  return ref.watch(clientProvider).scenes();
});

/// Dashboard favorites (§11.3).
final favoritesProvider = FutureProvider<List<Favorite>>((ref) async {
  return ref.watch(clientProvider).favorites();
});

/// Notification history; live alerts also arrive over the WSS stream.
final notificationsProvider =
    FutureProvider<List<NotificationItem>>((ref) async {
  return ref.watch(clientProvider).notifications();
});

/// Security panel state (arm mode + triggered).
final securityProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(clientProvider).securityState();
});

/// Whether occupancy (vacation) simulation is running.
final occupancyProvider = FutureProvider<bool>((ref) async {
  return ref.watch(clientProvider).occupancyRunning();
});

/// The home's duration-based alert rules.
final alertRulesProvider =
    FutureProvider<List<Map<String, dynamic>>>((ref) async {
  return ref.watch(clientProvider).alertRules();
});

/// The home's scene schedules (time / sunrise / sunset).
final sceneSchedulesProvider =
    FutureProvider<List<Map<String, dynamic>>>((ref) async {
  return ref.watch(clientProvider).sceneSchedules();
});

/// The home's climate program (programmable-thermostat schedule), or null.
final climateProgramProvider =
    FutureProvider<Map<String, dynamic>?>((ref) async {
  return ref.watch(clientProvider).climateProgram();
});

/// The home's electricity-provider rate config (null until set up).
final energyProviderProvider =
    FutureProvider<Map<String, dynamic>?>((ref) async {
  return ref.watch(clientProvider).energyProvider();
});

/// Cost breakdown grouped by 'device' or 'room'.
final energyBreakdownProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, groupBy) async {
  return ref.watch(clientProvider).energyBreakdown(groupBy);
});

/// Cost history bucketed by 'day' | 'week' | 'month' | 'year'.
final energyHistoryProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, bucket) async {
  return ref.watch(clientProvider).energyHistory(bucket);
});

/// Rated wattage per device (deviceId → watts) for non-metered cost estimation.
final energyDeviceWattsProvider =
    FutureProvider<Map<String, double>>((ref) async {
  return ref.watch(clientProvider).energyDeviceWatts();
});

/// Hub diagnostics (version, backend health, counts, offline devices) — powers the Dashboard overview.
/// Whether a session is active. Flipped true on authentication and false on explicit logout / a
/// genuinely dead refresh token / account deletion, so the root routes between LoginScreen and
/// HomeShell. Initializes from a persisted session (see [clientProvider]) so an app relaunch with a
/// live 30-day refresh token goes straight to HomeShell — never a forced re-login just because the
/// app was closed.
final sessionActiveProvider = StateProvider<bool>((ref) {
  return ref.watch(sharedPreferencesProvider).getString(_kRefreshTokenKey) != null;
});

final diagnosticsProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).diagnostics());

/// Real host telemetry (CPU / memory / temperature / storage / uptime) for the dashboard.
final systemHealthProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).systemHealth());

/// Whether the hub is in Developer Mode — reveals the Developer section (§ Developer Mode).
final devModeProvider = FutureProvider<bool>((ref) async {
  final info = await ref.watch(clientProvider).licenseInfo();
  final service = info?['service'] as Map<String, dynamic>?;
  return service?['devMode'] == true;
});

/// The unified driver registry (every driver + install state + config schema).
final driverRegistryProvider =
    FutureProvider<List<Map<String, dynamic>>>((ref) async {
  return ref.watch(clientProvider).driverRegistry();
});

/// Monthly energy budget + live month-to-date projection.
final energyBudgetProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(clientProvider).energyBudget();
});

/// This-month-vs-last-month cost per 'device' or 'room' (each group has a deltaPct).
final energyCompareProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, groupBy) async {
  return ref.watch(clientProvider).energyCompare(groupBy);
});

// ── Supreme Intelligence Engine (ADR 0013) ──────────────────────────────────

/// Intelligence dashboard roll-up (today/month savings, occupancy, top devices).
final intelligenceDashboardProvider =
    FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(clientProvider).intelligenceDashboard();
});

/// Pending proactive suggestions awaiting the user's response.
final intelligenceSuggestionsProvider =
    FutureProvider<List<Map<String, dynamic>>>((ref) async {
  return ref.watch(clientProvider).intelligenceSuggestions();
});

/// The Auto Pilot settings ({mode, threshold?}).
final intelligenceSettingsProvider =
    FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(clientProvider).intelligenceSettings();
});

/// Cameras registered on the home (§11.1).
final camerasProvider = FutureProvider<List<Camera>>((ref) async {
  return ref.watch(clientProvider).cameras();
});

/// The device's push token + platform, supplied by the platform push SDK
/// (firebase_messaging on iOS/Android, the service-worker subscription on web). Null
/// until that SDK is wired — the hub-side pipeline + registration are already in place.
final pushTokenProvider =
    Provider<({String platform, String token})?>((ref) => null);

/// Register this device's push token with the hub after login, when one is available
/// (§13). Push is optional and degrades to on-LAN WSS delivery; failures never block.
Future<void> registerPushIfAvailable(WidgetRef ref) async {
  final t = ref.read(pushTokenProvider);
  if (t == null) return;
  try {
    await ref.read(clientProvider).registerPushToken(t.platform, t.token);
  } catch (_) {
    // Push delivery is best-effort; a registration failure must not block sign-in.
  }
}

/// Per-measure energy summary for the home.
final energyProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  return ref.watch(clientProvider).energySummary();
});

/// A sensible default time-of-use tariff until the homeowner configures their own
/// rate plan (peak 16:00–21:00, off-peak otherwise + a daily standing charge).
const defaultTariff = <String, dynamic>{
  'currency': 'USD',
  'standingChargePerDay': 0.5,
  'periods': [
    {'name': 'peak', 'ratePerKwh': 0.40, 'hours': [16, 17, 18, 19, 20]},
    {
      'name': 'off-peak',
      'ratePerKwh': 0.15,
      'hours': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23],
    },
  ],
};

/// Tariff-aware cost of the home's energy under [defaultTariff]. Null when the hub
/// has no energy data yet (the cost card hides).
final energyCostProvider =
    FutureProvider<Map<String, dynamic>?>((ref) async {
  try {
    return await ref.watch(clientProvider).energyCost(defaultTariff);
  } catch (_) {
    return null;
  }
});

/// Automations for the visual Builder (§10).
final automationsProvider =
    FutureProvider<List<AutomationSummary>>((ref) async {
  return ref.watch(clientProvider).automations();
});

/// Every device in the home (across rooms) — used by the Builder's pickers.
final allDevicesProvider = FutureProvider<List<Device>>((ref) async {
  final client = ref.watch(clientProvider);
  final home = await client.home();
  final devices = <Device>[];
  for (final room in home.rooms) {
    devices.addAll(await client.devicesInRoom(room.id));
  }
  return devices;
});
