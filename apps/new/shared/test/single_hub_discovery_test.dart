import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

class _FakeMultiHubDiscovery implements HubDiscovery {
  final List<DiscoveredHub> hubs;
  const _FakeMultiHubDiscovery(this.hubs);

  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs.isEmpty ? null : hubs.first.controlUri;

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs;
}

void main() {
  group(
      'SingleHubDiscovery — scopes a multi-Hub LAN to exactly one Home (§Phase12.2 §11/§12)',
      () {
    final hubA = const DiscoveredHub(
        identity: HubIdentity(hubId: 'hub-a', displayName: 'A'),
        address: '10.0.0.1');
    final hubB = const DiscoveredHub(
        identity: HubIdentity(hubId: 'hub-b', displayName: 'B'),
        address: '10.0.0.2');

    test('discoverLan returns only the address of the targeted hubId',
        () async {
      final scoped =
          SingleHubDiscovery(_FakeMultiHubDiscovery([hubA, hubB]), 'hub-b');
      final uri = await scoped.discoverLan();
      expect(uri, hubB.controlUri);
    });

    test('discoverLan returns null when the targeted hub is not on this LAN',
        () async {
      final scoped =
          SingleHubDiscovery(_FakeMultiHubDiscovery([hubA]), 'hub-b');
      expect(await scoped.discoverLan(), isNull);
    });

    test(
        'discoverAllLan filters to exactly the targeted hubId, never leaking others',
        () async {
      final scoped =
          SingleHubDiscovery(_FakeMultiHubDiscovery([hubA, hubB]), 'hub-a');
      final all = await scoped.discoverAllLan();
      expect(all, hasLength(1));
      expect(all.single.identity.hubId, 'hub-a');
    });

    test('an empty underlying discovery never fabricates a match', () async {
      final scoped =
          const SingleHubDiscovery(_FakeMultiHubDiscovery([]), 'hub-a');
      expect(await scoped.discoverLan(), isNull);
      expect(await scoped.discoverAllLan(), isEmpty);
    });
  });
}
