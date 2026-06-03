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
