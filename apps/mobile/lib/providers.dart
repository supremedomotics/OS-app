import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

/// Riverpod wiring over the generated Supreme SDK (§11.3). Optimistic updates are
/// reconciled by the WSS state stream. State is held in Supreme terms only.

/// Appearance (§11.2 Themes): base palette mode (Luxury Black / White / Automatic) and
/// the accent ramp (Gold / Silver). Held in app state; the MaterialApp rebuilds on change.
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.dark);
final accentProvider = StateProvider<AureonAccent>((ref) => AureonAccent.gold);

/// The homeowner's custom scene order (ids), set in the Scenes "Edit" mode. In-memory
/// for now (persisting it is a small follow-up).
final sceneOrderProvider = StateProvider<List<String>>((ref) => const []);

/// Hub base URL. In production this is resolved automatically (mDNS LAN-direct or
/// cloud relay); for Phase-0 dev it points at the local gateway.
final hubBaseUrlProvider = Provider<String>((ref) => 'http://127.0.0.1:8080');
final hubWsUrlProvider = Provider<String>((ref) => 'ws://127.0.0.1:8080');

final clientProvider = Provider<SupremeClient>((ref) {
  return SupremeClient(baseUrl: ref.watch(hubBaseUrlProvider));
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
