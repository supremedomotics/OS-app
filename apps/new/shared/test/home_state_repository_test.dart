import 'dart:async';

import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// A minimal fake `HubTransport` that answers the REAL Hub REST contract
/// (`services/gateway/src/routes/{home,devices,scenes}.ts`, §Phase12.8) — scoped per-instance
/// so two instances can represent two completely independent Hubs (state isolation).
class _FakeHubTransport implements HubTransport {
  final Map<String, Map<String, dynamic>> getResponses;
  final List<MapEntry<String, Map<String, dynamic>>> commandsReceived = [];
  bool _connected = true;

  _FakeHubTransport(this.getResponses);

  @override
  bool get isConnected => _connected;

  @override
  Future<void> connect() async {}

  @override
  Future<void> authenticate() async {}

  @override
  Future<void> disconnect() async => _connected = false;

  @override
  Future<Map<String, dynamic>> get(String path) async =>
      getResponses[path] ?? const {};

  @override
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) async {
    commandsReceived.add(MapEntry(path, body));
    return const {'accepted': true};
  }

  @override
  Stream<Map<String, dynamic>> events() => const Stream.empty();
}

ConnectionManager _managerFor(_FakeHubTransport transport) {
  return ConnectionManager(
    discovery: const MockHubDiscovery(hubPresent: true),
    makeLanTransport: (_) => transport,
  );
}

Map<String, dynamic> _deviceWithOnoff(String id, String roomId,
        {bool on = false}) =>
    {
      'id': id,
      'roomId': roomId,
      'capabilities': [
        {'kind': 'onoff'}
      ],
      'state': {
        'onoff': {'on': on}
      },
    };

void main() {
  group('HubHomeStateRepository — real Hub REST contract (§Phase12.8)', () {
    test(
        'spaces() parses /v1/home + /v1/devices into rooms with real capability-derived domains',
        () async {
      final transport = _FakeHubTransport({
        'v1/home': {
          'rooms': [
            {'id': 'living-room', 'name': 'Living Room', 'floor': 0},
          ],
        },
        'v1/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room')],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      final spaces = await repo.spaces();

      expect(spaces, hasLength(1));
      expect(spaces.single.id, 'living-room');
      expect(spaces.single.domains, {HomeDomain.lighting});
      await manager.dispose();
    });

    test(
        'lighting() returns null (never a fabricated value) when the Hub has no matching device',
        () async {
      final transport =
          _FakeHubTransport({'v1/rooms/living-room/devices': const {}});
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      expect(await repo.lighting('living-room'), isNull);
      await manager.dispose();
    });

    test(
        'lighting() parses a real device\'s onoff state from /v1/rooms/:id/devices',
        () async {
      final transport = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room', on: true)],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      final state = await repo.lighting('living-room');

      expect(state!.value.on, isTrue);
      expect(state.confirmation, ConfirmationState.confirmed);
      await manager.dispose();
    });

    test(
        'setLighting() finds the real device id and sends the real /v1/devices/:id/command shape',
        () async {
      final transport = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room')],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      await repo.setLighting('living-room', on: true);

      expect(transport.commandsReceived.last.key, 'v1/devices/dev-1/command');
      expect(transport.commandsReceived.last.value, {
        'command': {'capability': 'onoff', 'action': 'on'}
      });
      await manager.dispose();
    });

    test(
        'a read never throws even when the Hub is unreachable — surfaces as null, not a crash',
        () async {
      final manager = ConnectionManager(
        discovery: const MockHubDiscovery(hubPresent: false),
        makeLanTransport: (_) => _FakeHubTransport({}),
      );
      await manager.start(); // stays offline — no Hub found
      final repo = HubHomeStateRepository(manager);

      expect(await repo.lighting('living-room'), isNull);
      expect(await repo.spaces(), isEmpty);
      await manager.dispose();
    });
  });

  group(
      'semantic device resolution — no first-match heuristic (§Phase12.9)',
      () {
    test('a room with zero matching devices resolves to null, as before',
        () async {
      final transport =
          _FakeHubTransport({'v1/rooms/living-room/devices': const {}});
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      expect(await repo.lighting('living-room'), isNull);
      await manager.dispose();
    });

    test(
        'a room with exactly one matching device resolves deterministically (unchanged)',
        () async {
      final transport = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room', on: true)],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      final state = await repo.lighting('living-room');

      expect(state!.value.on, isTrue);
      await manager.dispose();
    });

    test(
        'a room with TWO devices sharing a capability throws AmbiguousDeviceResolutionException — never silently picks one',
        () async {
      final transport = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [
            _deviceWithOnoff('dev-1', 'living-room', on: true),
            _deviceWithOnoff('dev-2', 'living-room', on: false),
          ],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      expect(
        () => repo.lighting('living-room'),
        throwsA(isA<AmbiguousDeviceResolutionException>()
            .having((e) => e.roomId, 'roomId', 'living-room')
            .having((e) => e.capabilityKind, 'capabilityKind', 'onoff')
            .having((e) => e.deviceIds, 'deviceIds', ['dev-1', 'dev-2'])),
      );
      await manager.dispose();
    });

    test(
        'setLighting() on an ambiguous room throws before sending any command — never guesses which device to control',
        () async {
      final transport = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [
            _deviceWithOnoff('dev-1', 'living-room'),
            _deviceWithOnoff('dev-2', 'living-room'),
          ],
        },
      });
      final manager = _managerFor(transport);
      await manager.start();
      final repo = HubHomeStateRepository(manager);

      await expectLater(
        repo.setLighting('living-room', on: true),
        throwsA(isA<AmbiguousDeviceResolutionException>()),
      );
      expect(transport.commandsReceived, isEmpty);
      await manager.dispose();
    });
  });

  group(
      'Home A / Home B state isolation (§Phase12.8 — two repositories, two Hubs)',
      () {
    test(
        'identical room ids on two different Hubs never cross between repositories',
        () async {
      final transportA = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room', on: true)],
        },
      });
      final transportB = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room', on: false)],
        },
      });
      final managerA = _managerFor(transportA);
      final managerB = _managerFor(transportB);
      await managerA.start();
      await managerB.start();
      final repoA = HubHomeStateRepository(managerA);
      final repoB = HubHomeStateRepository(managerB);

      final stateA = await repoA.lighting('living-room');
      final stateB = await repoB.lighting('living-room');

      expect(stateA!.value.on, isTrue);
      expect(stateB!.value.on, isFalse);

      await managerA.dispose();
      await managerB.dispose();
    });

    test(
        'a command sent to Home A\'s repository never reaches Home B\'s transport',
        () async {
      final transportA = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-1', 'living-room')],
        },
      });
      final transportB = _FakeHubTransport({});
      final managerA = _managerFor(transportA);
      final managerB = _managerFor(transportB);
      await managerA.start();
      await managerB.start();
      final repoA = HubHomeStateRepository(managerA);

      await repoA.setLighting('living-room', on: true);

      expect(transportA.commandsReceived, hasLength(1));
      expect(transportB.commandsReceived, isEmpty);

      await managerA.dispose();
      await managerB.dispose();
    });
  });

  group('Home-switch stale-response race (§Phase12.11 §8)', () {
    test(
        'a delayed read started on Home A, released AFTER Home B is already in use, resolves '
        'with Home A\'s own data and never touches Home B\'s transport',
        () async {
      final gate = Completer<void>();
      final transportA = _DelayedFakeHubTransport(
        gate: gate.future,
        responses: {
          'v1/rooms/living-room/devices': {
            'devices': [_deviceWithOnoff('dev-1', 'living-room', on: true)],
          },
        },
      );
      final transportB = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-2', 'living-room', on: false)],
        },
      });
      final managerA = _managerFor(transportA);
      final managerB = _managerFor(transportB);
      await managerA.start();
      await managerB.start();
      final repoA = HubHomeStateRepository(managerA);
      final repoB = HubHomeStateRepository(managerB);

      // 1. Start a Home A read — it blocks on `gate` before returning, exactly like a real
      //    slow/in-flight network call still pending when the homeowner switches Homes.
      final pendingA = repoA.lighting('living-room');

      // 2. "Switch active Home to B" — a completely independent repository/transport is used
      //    immediately, with no dependency on A's outstanding call. The canonical identity
      //    (which ConnectionManager/transport each repo is bound to) traveled with each
      //    repository at construction time, never re-derived from "whichever Home is active
      //    right now."
      final stateB = await repoB.lighting('living-room');
      expect(stateB!.value.on, isFalse); // Home B's own real state

      // 3. Release Home A's delayed response only AFTER Home B has already been read.
      gate.complete();
      final stateA = await pendingA;

      // 4. The stale-but-now-resolved A response carries ONLY Home A's data — never B's —
      //    and never touched B's transport.
      expect(stateA!.value.on, isTrue);
      expect(transportB.commandsReceived, isEmpty);

      await managerA.dispose();
      await managerB.dispose();
    });

    test(
        'a delayed command on Home A, released after Home B issues its own command, never '
        'reaches Home B\'s transport and Home B\'s command never reaches Home A\'s',
        () async {
      final gate = Completer<void>();
      final transportA = _DelayedFakeHubTransport(
        gate: gate.future,
        responses: {
          'v1/rooms/living-room/devices': {
            'devices': [_deviceWithOnoff('dev-1', 'living-room')],
          },
        },
      );
      final transportB = _FakeHubTransport({
        'v1/rooms/living-room/devices': {
          'devices': [_deviceWithOnoff('dev-2', 'living-room')],
        },
      });
      final managerA = _managerFor(transportA);
      final managerB = _managerFor(transportB);
      await managerA.start();
      await managerB.start();
      final repoA = HubHomeStateRepository(managerA);
      final repoB = HubHomeStateRepository(managerB);

      // Home A's command is in flight (delayed) when the homeowner switches to Home B and
      // issues a real command there.
      final pendingSetA = repoA.setLighting('living-room', on: true);
      await repoB.setLighting('living-room', on: true);

      expect(transportB.commandsReceived, hasLength(1));
      expect(transportB.commandsReceived.single.key, 'v1/devices/dev-2/command');
      expect(transportA.commandsReceived, isEmpty); // A's command hasn't landed yet — still gated

      gate.complete();
      await pendingSetA;

      expect(transportA.commandsReceived, hasLength(1));
      expect(transportA.commandsReceived.single.key, 'v1/devices/dev-1/command');
      // B's transport never saw a trace of A's delayed command.
      expect(transportB.commandsReceived, hasLength(1));

      await managerA.dispose();
      await managerB.dispose();
    });
  });
}

/// A `_FakeHubTransport` whose every real response is held behind [gate] before resolving —
/// models a genuinely slow/in-flight network call still pending when the homeowner switches
/// Homes (§Phase12.11 §8), rather than an instantaneous fake that could never race in practice.
class _DelayedFakeHubTransport extends _FakeHubTransport {
  final Future<void> gate;
  _DelayedFakeHubTransport({required this.gate, required Map<String, Map<String, dynamic>> responses})
      : super(responses);

  @override
  Future<Map<String, dynamic>> get(String path) async {
    await gate;
    return super.get(path);
  }

  @override
  Future<Map<String, dynamic>> sendCommand(String path, Map<String, dynamic> body) async {
    await gate;
    return super.sendCommand(path, body);
  }
}
