import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import 'cloud/multi_home.dart';

/// Riverpod wiring over the generated Supreme SDK (§11.3). Optimistic updates are
/// reconciled by the WSS state stream. State is held in Supreme terms only.

/// Appearance (§11.2 Themes): base palette mode (Luxury Black / White / Automatic) and
/// the accent ramp (Gold / Silver). Held in app state; the MaterialApp rebuilds on change.
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.dark);
final accentProvider = StateProvider<AureonAccent>((ref) => AureonAccent.gold);

/// The homeowner's custom scene order (ids), set in the Scenes "Edit" mode. In-memory
/// for now (persisting it is a small follow-up).
final sceneOrderProvider = StateProvider<List<String>>((ref) => const []);

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

final clientProvider = Provider<SupremeClient>((ref) {
  final client = SupremeClient(baseUrl: ref.watch(hubBaseUrlProvider));
  // Reuse the cloud session token across homes: when present, a client pointed at a newly
  // resolved hub (local or cloud) is already authenticated — no re-login on a home switch.
  final session = ref.watch(cloudSessionProvider);
  if (session != null) client.accessToken = session.accessToken;
  return client;
});

/// Holds the live WSS stream once authenticated.
final streamProvider = StateProvider<SupremeStream?>((ref) => null);

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
