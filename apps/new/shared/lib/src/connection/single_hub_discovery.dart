import 'transport.dart';

/// Scopes an existing [HubDiscovery] to exactly one [HubIdentity.hubId] (§Phase12.2 §11/§12).
/// This is the "per-Home transport" piece Phase 12.1 left as PRODUCTION HARDENING REQUIRED:
/// each paired Home's [ConnectionManager] gets one of these (never the raw, multi-Hub-wide
/// discovery) so a LAN with several Hubs advertising `_supremeos._tcp` can never accidentally
/// connect Home A's session to Home B's Hub, or vice versa — the filter is on the CANONICAL
/// `hubId`, never a display name or address.
///
/// Deliberately a thin wrapper, not a new discovery mechanism (§Phase12.2 "do not redesign the
/// architecture") — every real discovery implementation (`MdnsHubDiscovery`,
/// `MockHubDiscovery`) is reused unchanged underneath.
class SingleHubDiscovery implements HubDiscovery {
  final HubDiscovery _inner;
  final String hubId;

  const SingleHubDiscovery(this._inner, this.hubId);

  @override
  Future<Uri?> discoverLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    final all = await _inner.discoverAllLan(timeout: timeout);
    for (final hub in all) {
      if (hub.identity.hubId == hubId) return hub.controlUri;
    }
    return null;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    final all = await _inner.discoverAllLan(timeout: timeout);
    return all.where((h) => h.identity.hubId == hubId).toList();
  }
}
