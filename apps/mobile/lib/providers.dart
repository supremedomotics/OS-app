import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

/// Riverpod wiring over the generated Supreme SDK (§11.3). Optimistic updates are
/// reconciled by the WSS state stream. State is held in Supreme terms only.

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
