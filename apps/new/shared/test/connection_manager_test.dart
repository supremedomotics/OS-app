import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group('ConnectionManager', () {
    test('connects locally when Hub is discoverable on LAN', () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: true),
        makeLanTransport: (_) => MockHubTransport(),
      );

      final states = <ConnectionStatus>[];
      final sub = manager.state.listen((s) => states.add(s.status));

      await manager.start();

      expect(manager.current.status, ConnectionStatus.connectedLocal);
      expect(states, contains(ConnectionStatus.discoveringLan));
      expect(states, contains(ConnectionStatus.connectingLocal));

      await sub.cancel();
      await manager.dispose();
    });

    test(
        'stays offline when no LAN Hub and remote access is off by default (§14)',
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

    test('falls back to remote transport only when remote access is opted in',
        () async {
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

    test('sendCommand throws when nothing is connected', () {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => MockHubTransport(),
      );
      expect(() => manager.sendCommand('/x', {}), throwsStateError);
    });

    test(
        'passes through authenticating before landing on connectedLocal (§Phase9-15)',
        () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: true),
        makeLanTransport: (_) => MockHubTransport(),
      );
      final states = <ConnectionStatus>[];
      final sub = manager.state.listen((s) => states.add(s.status));

      await manager.start();

      expect(states, contains(ConnectionStatus.authenticating));
      expect(manager.current.status, ConnectionStatus.connectedLocal);

      await sub.cancel();
      await manager.dispose();
    });

    test(
        'a Hub that rejects credentials lands on authenticationFailed, not an endless retry '
        '(§ authentication boundary)', () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: true),
        makeLanTransport: (_) => MockHubTransport(rejectAuthentication: true),
      );

      await manager.start();

      expect(manager.current.status, ConnectionStatus.authenticationFailed);
      expect(manager.current.isConnected, isFalse);

      await manager.dispose();
    });

    test(
        'notifyNetworkChanged() re-discovers and reconnects without homeowner action '
        '(§Phase11-14)', () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: true),
        makeLanTransport: (_) => MockHubTransport(),
      );
      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedLocal);

      final reconnected = manager.state
          .firstWhere((s) => s.status == ConnectionStatus.connectedLocal);
      manager.notifyNetworkChanged();
      await reconnected;

      expect(manager.current.status, ConnectionStatus.connectedLocal);
      await manager.dispose();
    });
  });

  group('LAN <-> remote transition (§Phase12.11 §2/§3)', () {
    test(
        'LAN available -> LAN lost -> remote eligible -> reconnects remotely, with Remote Access ON',
        () async {
      final discovery = _MutableHubDiscovery(present: true);
      final manager = ConnectionManager(
        discovery: discovery,
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () => MockHubTransport(),
        remoteAccessEnabled: true,
      );

      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedLocal);

      // LAN disappears (Wi-Fi lost, Hub powered off, etc.) — the homeowner does nothing.
      discovery.present = false;
      final wentRemote = manager.state
          .firstWhere((s) => s.status == ConnectionStatus.connectedRemote);
      manager.notifyNetworkChanged();
      await wentRemote.timeout(const Duration(seconds: 5));

      expect(manager.current.status, ConnectionStatus.connectedRemote);
      await manager.dispose();
    });

    test(
        'remote connected -> LAN returns -> local is preferred again, never staying remote unnecessarily',
        () async {
      final discovery = _MutableHubDiscovery(present: false);
      final manager = ConnectionManager(
        discovery: discovery,
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () => MockHubTransport(),
        remoteAccessEnabled: true,
      );

      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedRemote);

      // LAN comes back (homeowner returns home) — the homeowner does nothing.
      discovery.present = true;
      final wentLocal = manager.state
          .firstWhere((s) => s.status == ConnectionStatus.connectedLocal);
      manager.notifyNetworkChanged();
      await wentLocal.timeout(const Duration(seconds: 5));

      expect(manager.current.status, ConnectionStatus.connectedLocal);
      await manager.dispose();
    });

    test(
        'LAN lost with Remote Access OFF stays offline — never a silent remote fallback (§4)',
        () async {
      final discovery = _MutableHubDiscovery(present: true);
      final manager = ConnectionManager(
        discovery: discovery,
        makeLanTransport: (_) => MockHubTransport(),
        makeRemoteTransport: () => MockHubTransport(),
        remoteAccessEnabled: false, // homeowner has NOT opted in
      );

      await manager.start();
      expect(manager.current.status, ConnectionStatus.connectedLocal);

      discovery.present = false;
      final wentOffline = manager.state
          .firstWhere((s) => s.status == ConnectionStatus.offline);
      manager.notifyNetworkChanged();
      await wentOffline.timeout(const Duration(seconds: 5));

      expect(manager.current.status, ConnectionStatus.offline);
      expect(manager.current.isConnected, isFalse);
      await manager.dispose();
    });
  });
}

/// A `HubDiscovery` whose LAN-presence answer can be flipped mid-test — `MockHubDiscovery`'s
/// `hubPresent` is deliberately `final` (§Phase9's own "discovery result is fixed for the
/// instance's lifetime" contract for simple tests), so this local fake exists purely to model
/// a REAL network transition without touching that shared, widely-used test double.
class _MutableHubDiscovery implements HubDiscovery {
  bool present;
  _MutableHubDiscovery({required this.present});

  static const _hub = DiscoveredHub(
    identity: HubIdentity(hubId: 'mock-hub-1', displayName: 'SupremeOS Hub'),
    address: '192.168.0.117',
    port: SupremeOSHubDefaults.defaultPort,
  );

  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async {
    await Future.delayed(const Duration(milliseconds: 20));
    return present ? _hub.controlUri : null;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    await Future.delayed(const Duration(milliseconds: 20));
    return present ? [_hub] : [];
  }
}
