import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// A discovery fake independent of [MockHubDiscovery] — this file tests the
/// PLATFORM-INDEPENDENT contract (§12: "place it behind an interface and
/// test the application-level discovery behavior using deterministic
/// fakes") rather than any one implementation, including representing
/// multiple simultaneous Hubs and a custom (non-default) port.
class _FakeDiscovery implements HubDiscovery {
  final List<DiscoveredHub> hubs;
  const _FakeDiscovery(this.hubs);

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
  group('SupremeOSHubDefaults (§ platform port convention)', () {
    test('the default Hub port is 7272', () {
      expect(SupremeOSHubDefaults.defaultPort, 7272);
    });

    test('a discovery result uses 7272 when no custom port is specified', () {
      const hub = DiscoveredHub(
        identity: HubIdentity(hubId: 'hub-1', displayName: 'SupremeOS Hub'),
        address: '192.168.1.50',
      );
      expect(hub.port, 7272);
      expect(hub.controlUri.port, 7272);
    });

    test('a custom port on one Hub does not change the shared default constant',
        () {
      const hub = DiscoveredHub(
        identity: HubIdentity(hubId: 'hub-1', displayName: 'SupremeOS Hub'),
        address: '192.168.1.50',
        port: 9999,
      );
      expect(hub.port, 9999);
      expect(SupremeOSHubDefaults.defaultPort, 7272); // unaffected
    });
  });

  group('multiple Hubs on the LAN (§ multiple Hubs)', () {
    test('discovery can represent more than one Hub at once', () async {
      const discovery = _FakeDiscovery([
        DiscoveredHub(
          identity: HubIdentity(
              hubId: 'hub-1',
              displayName: 'Living Room Hub',
              projectId: 'proj-a'),
          address: '192.168.1.10',
        ),
        DiscoveredHub(
          identity: HubIdentity(
              hubId: 'hub-2',
              displayName: 'Guest House Hub',
              projectId: 'proj-b'),
          address: '192.168.1.20',
        ),
      ]);

      final all = await discovery.discoverAllLan();
      expect(all, hasLength(2));
      expect(all.map((h) => h.identity.hubId), containsAll(['hub-1', 'hub-2']));
    });

    test('discoverLan takes the single-Hub view for the common case', () async {
      const discovery = _FakeDiscovery([
        DiscoveredHub(
          identity: HubIdentity(hubId: 'hub-1', displayName: 'Hub'),
          address: '192.168.1.10',
        ),
      ]);
      final uri = await discovery.discoverLan();
      expect(uri, isNotNull);
      expect(uri!.port, 7272);
    });
  });

  group('Hub identity is independent of network address (§ Hub identity)', () {
    test('the same Hub identity compares equal across different addresses', () {
      const before = HubIdentity(
          hubId: 'hub-1', displayName: 'Living Room Hub', projectId: 'proj-a');
      const after = HubIdentity(
          hubId: 'hub-1', displayName: 'Living Room Hub', projectId: 'proj-a');
      expect(before, equals(after));
    });

    test(
        'reconnect after an address change recognizes it as the same Hub (§ reconnect)',
        () {
      const beforeMove = DiscoveredHub(
        identity: HubIdentity(
            hubId: 'hub-1', displayName: 'Hub', projectId: 'proj-a'),
        address: '192.168.1.10',
      );
      // DHCP handed out a new address after a router reboot.
      const afterMove = DiscoveredHub(
        identity: HubIdentity(
            hubId: 'hub-1', displayName: 'Hub', projectId: 'proj-a'),
        address: '192.168.1.77',
      );

      expect(beforeMove.identity, equals(afterMove.identity));
      expect(beforeMove.address, isNot(afterMove.address));
    });

    test('two different Hubs are never considered the same identity', () {
      const hubA = HubIdentity(
          hubId: 'hub-1', displayName: 'Hub A', projectId: 'proj-a');
      const hubB = HubIdentity(
          hubId: 'hub-2', displayName: 'Hub B', projectId: 'proj-a');
      expect(hubA, isNot(equals(hubB)));
    });
  });

  group(
      'LAN-first connection behavior still holds with the new discovery model',
      () {
    test('ConnectionManager connects locally using the discovered Hub (7272)',
        () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(),
        makeLanTransport: (_) => MockHubTransport(),
      );
      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedLocal);
      await manager.dispose();
    });

    test('local Hub still takes priority over remote when both are available',
        () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: true),
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () => MockHubTransport(),
        remoteAccessEnabled: true,
      );
      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedLocal);
      await manager.dispose();
    });

    test('remote stays disabled by default even when no local Hub is found',
        () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => MockHubTransport(),
      );
      expect(manager.remoteAccessEnabled, isFalse);
      await manager.start();
      expect(manager.current.status, ConnectionStatus.offline);
      await manager.dispose();
    });

    test('remote is selected only once explicitly enabled', () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () => MockHubTransport(),
        remoteAccessEnabled: true,
      );
      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedRemote);
      await manager.dispose();
    });
  });
}
