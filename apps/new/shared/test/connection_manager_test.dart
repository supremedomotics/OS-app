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
}
