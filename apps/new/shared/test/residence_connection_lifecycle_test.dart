import 'dart:async';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// The residence's first read runs while the Hub connection is still authenticating. These tests
/// pin that "not connected yet" is Loading while the connection is in progress, that the
/// connection failing outright is Unreachable, and that the connection becoming usable — and
/// usable again after a drop — re-reads the residence on its own.

class _Discovery implements HubDiscovery {
  _Discovery({this.present = true, this.hold});
  final bool present;

  /// When set, discovery does not answer until this completes (the connection stays in progress).
  final Future<void>? hold;

  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async {
    await hold;
    return present ? Uri.parse('http://hub.test:7272/') : null;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      const [];
}

/// A transport whose authentication finishes only when the test says so, reading from the
/// simulated residence's real route shapes.
class _GatedTransport implements HubTransport {
  _GatedTransport(this._read);
  final Map<String, dynamic> Function(String path) _read;
  final gate = Completer<void>();
  final reads = <String>[];
  var _connected = false;

  @override
  bool get isConnected => _connected;
  @override
  Future<void> connect() async {}
  @override
  Future<void> authenticate() async {
    await gate.future;
    _connected = true;
  }

  @override
  Future<void> disconnect() async => _connected = false;
  @override
  Future<Map<String, dynamic>> sendCommand(
          String path, Map<String, dynamic> body) async =>
      const {};
  @override
  Future<Map<String, dynamic>> get(String path) async {
    reads.add(path);
    return _read(path);
  }

  @override
  Future<HubBytes> getBytes(String path, {String? ifNoneMatch}) async =>
      const HubBytes();
  @override
  Stream<Map<String, dynamic>> events() => const Stream.empty();
}

/// The Hub refuses this Mobile's credentials.
class _RejectingTransport extends _GatedTransport {
  _RejectingTransport() : super((_) => const {});
  @override
  Future<void> authenticate() async =>
      throw const AuthenticationException('Hub rejected this Mobile\'s credentials');
}

const _discovering = HubConnectionState(ConnectionStatus.discoveringLan);
const _connecting = HubConnectionState(ConnectionStatus.connectingLocal);
const _authenticating = HubConnectionState(ConnectionStatus.authenticating);
const _connected = HubConnectionState(ConnectionStatus.connectedLocal);
const _reconnecting = HubConnectionState(ConnectionStatus.reconnecting);
const _offline = HubConnectionState(ConnectionStatus.offline);

/// Lets queued async work (connection events, the three reads) run, without a wall-clock wait
/// for a result that never comes.
Future<void> _until(bool Function() done) async {
  for (var i = 0; i < 200 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

Future<void> _settleBriefly() =>
    Future<void>.delayed(const Duration(milliseconds: 30));

void main() {
  group('startup race: the first read runs before the connection is usable', () {
    test(
        'stays Loading, then the connection becoming usable loads the residence — once',
        () async {
      final sim = SimulatedResidence();
      final transport = _GatedTransport(sim.read);
      final manager = ConnectionManager(
          discovery: _Discovery(), makeLanTransport: (_) => transport);
      unawaited(manager.start()); // as the app does: the connection starts, then the residence
      final link = ResidenceStreamLink(get: manager.get);
      link.followConnection(manager.state, initial: manager.current);
      addTearDown(() async {
        await link.dispose();
        await manager.dispose();
      });

      await link.state.start(); // the first read: authentication has not finished
      var s = link.state.snapshot;
      expect(s.loaded, isFalse);
      expect(s.reachable, isNull, reason: 'connecting is Loading, not unreachable');
      expect(transport.reads, isEmpty, reason: 'nothing could be asked yet');

      transport.gate.complete(); // authentication finishes → Connected
      await _until(() => link.state.snapshot.loaded);

      s = link.state.snapshot;
      expect(s.loaded, isTrue);
      expect(s.reachable, isTrue);
      expect(s.spaces.map((x) => x.name),
          containsAll(['Living Room', 'Dining Room', 'Master Bedroom']));
      expect(transport.reads, ['v1/home', 'v1/devices', 'v1/scenes'],
          reason: 'one refresh, three reads, in order');
    });
  });

  group('"not connected yet" is not "unreachable"', () {
    ResidenceState stateReading(Future<Map<String, dynamic>> Function(String) get) =>
        ResidenceState(get: get, frames: const Stream.empty());

    test('before the first load it stays Loading', () async {
      final s = stateReading((p) async => throw HubNotConnectedException('connecting'));
      await s.start();
      expect(s.snapshot.loaded, isFalse);
      expect(s.snapshot.reachable, isNull);
      expect(s.snapshot.spaces, isEmpty);
    });

    test('a genuine failure before the first load is unreachable, not Loading', () async {
      final s = stateReading((p) async => throw Exception('HTTP 500'));
      await s.start();
      expect(s.snapshot.loaded, isFalse);
      expect(s.snapshot.reachable, isFalse);
    });

    test('a Hub that answers nothing usable is unreachable', () async {
      final s = stateReading((p) async => const {});
      await s.start();
      expect(s.snapshot.reachable, isFalse);
    });

    test('a not-connected read next to a genuine failure is a failure', () async {
      final s = stateReading((p) async => p == 'v1/home'
          ? throw HubNotConnectedException('connecting')
          : throw Exception('HTTP 500'));
      await s.start();
      expect(s.snapshot.reachable, isFalse);
    });

    test('after a load, losing the connection keeps what was loaded and says unreachable',
        () async {
      final sim = SimulatedResidence();
      var down = false;
      final s = stateReading((p) async =>
          down ? throw HubNotConnectedException('reconnecting') : sim.read(p));
      await s.start();
      final before = s.snapshot.spaces.map((x) => x.name).toList();
      down = true;
      await s.refresh();
      expect(s.snapshot.loaded, isTrue);
      expect(s.snapshot.reachable, isFalse);
      expect(s.snapshot.spaces.map((x) => x.name), before);
      expect(s.snapshot.devices, isNotEmpty);
    });
  });

  group('the connection failing outright is unreachable', () {
    test('no Hub found: offline, so the residence is unreachable, not Loading forever',
        () async {
      final searching = Completer<void>();
      final manager = ConnectionManager(
          discovery: _Discovery(present: false, hold: searching.future),
          makeLanTransport: (_) => _GatedTransport((_) => const {}));
      unawaited(manager.start());
      final link = ResidenceStreamLink(get: manager.get);
      link.followConnection(manager.state, initial: manager.current);
      addTearDown(() async {
        await link.dispose();
        await manager.dispose();
      });

      await link.state.start();
      await _settleBriefly();
      expect(link.state.snapshot.reachable, isNull, reason: 'still discovering');
      searching.complete(); // discovery ends with no Hub
      await _until(() => link.state.snapshot.reachable == false);
      expect(link.state.snapshot.reachable, isFalse);
      expect(link.state.snapshot.loaded, isFalse);
    });

    test('credentials refused: authenticationFailed is unreachable', () async {
      final manager = ConnectionManager(
          discovery: _Discovery(), makeLanTransport: (_) => _RejectingTransport());
      unawaited(manager.start());
      final link = ResidenceStreamLink(get: manager.get);
      link.followConnection(manager.state, initial: manager.current);
      addTearDown(() async {
        await link.dispose();
        await manager.dispose();
      });

      await link.state.start();
      await _until(() => link.state.snapshot.reachable == false);
      expect(link.state.snapshot.reachable, isFalse);
    });

    test('a link attached after the connection already failed is unreachable at once', () async {
      for (final failed in [_offline, _reconnecting]) {
        final link = ResidenceStreamLink(
            get: (p) async => throw HubNotConnectedException('offline'));
        link.followConnection(const Stream.empty(), initial: failed);
        addTearDown(link.dispose);
        await link.state.start();
        expect(link.state.snapshot.reachable, isFalse, reason: '${failed.status}');
        expect(link.state.snapshot.loaded, isFalse);
      }
    });

    test('discovering, connecting and authenticating are not failures', () async {
      final link = ResidenceStreamLink(
          get: (p) async => throw HubNotConnectedException('connecting'));
      final conn = StreamController<HubConnectionState>.broadcast();
      link.followConnection(conn.stream, initial: _discovering);
      addTearDown(() async {
        await conn.close();
        await link.dispose();
      });
      await link.state.start();
      conn
        ..add(_discovering)
        ..add(_connecting)
        ..add(_authenticating);
      await _settleBriefly();
      expect(link.state.snapshot.reachable, isNull);
      expect(link.state.snapshot.loaded, isFalse);
    });
  });

  group('the connection becoming usable re-reads the residence', () {
    test('exactly one refresh per transition to connected; repeats do not re-read', () async {
      final sim = SimulatedResidence();
      var homeReads = 0;
      final link = ResidenceStreamLink(get: (p) async {
        if (p == 'v1/home') homeReads++;
        return sim.read(p);
      });
      final conn = StreamController<HubConnectionState>.broadcast();
      link.followConnection(conn.stream, initial: _authenticating);
      addTearDown(() async {
        await conn.close();
        await link.dispose();
      });
      await link.state.start();
      final base = homeReads;

      conn
        ..add(_connected)
        ..add(_connected)
        ..add(_connected);
      await _until(() => homeReads > base);
      await _settleBriefly();
      expect(homeReads, base + 1, reason: 'three connected events, one refresh');

      conn.add(_reconnecting);
      conn.add(_connected);
      await _until(() => homeReads > base + 1);
      await _settleBriefly();
      expect(homeReads, base + 2, reason: 'a reconnect is one more');
    });

    test('a link that starts already connected is not re-read for it', () async {
      final sim = SimulatedResidence();
      var homeReads = 0;
      final link = ResidenceStreamLink(get: (p) async {
        if (p == 'v1/home') homeReads++;
        return sim.read(p);
      });
      final conn = StreamController<HubConnectionState>.broadcast();
      link.followConnection(conn.stream, initial: _connected);
      addTearDown(() async {
        await conn.close();
        await link.dispose();
      });
      await link.state.start();
      final base = homeReads;
      conn.add(_connected);
      await _settleBriefly();
      expect(homeReads, base);
    });

    test(
        'reconnect: the last-known residence stays while down, then the reconnect shows what changed',
        () async {
      final sim = SimulatedResidence();
      var up = true;
      var withStudio = false;
      Map<String, dynamic> read(String p) {
        if (!up) throw HubNotConnectedException('reconnecting');
        final m = Map<String, dynamic>.from(sim.read(p));
        if (p == 'v1/home' && withStudio) {
          final rooms = List<dynamic>.from(m['rooms'] as List);
          rooms.add({
            ...Map<String, dynamic>.from(rooms.first as Map),
            'id': 'studio',
            'name': 'Studio',
          });
          m['rooms'] = rooms;
        }
        return m;
      }

      final conn = StreamController<HubConnectionState>.broadcast();
      final link = ResidenceStreamLink(get: (p) async => read(p));
      link.followConnection(conn.stream, initial: _connected);
      addTearDown(() async {
        await conn.close();
        await link.dispose();
      });

      await link.state.start();
      final names = link.state.snapshot.spaces.map((x) => x.name).toList();
      expect(names, isNot(contains('Studio')));

      up = false;
      conn.add(_reconnecting); // the connection dropped
      await _until(() => link.state.snapshot.reachable == false);
      expect(link.state.snapshot.spaces.map((x) => x.name), names,
          reason: 'what was loaded is kept');
      expect(link.state.snapshot.loaded, isTrue);
      expect(link.state.snapshot.reachable, isFalse);

      up = true;
      withStudio = true;
      conn.add(_connected); // reconnected
      await _until(() =>
          link.state.snapshot.spaces.any((x) => x.name == 'Studio'));
      expect(link.state.snapshot.spaces.map((x) => x.name), contains('Studio'));
      expect(link.state.snapshot.reachable, isTrue);
    });
  });

  group('ConnectionManager reports "not connected" as its own type', () {
    ConnectionManager idle() => ConnectionManager(
        discovery: _Discovery(),
        makeLanTransport: (_) => _GatedTransport((_) => const {}));

    test('get, getBytes and sendCommand throw HubNotConnectedException (still a StateError)',
        () {
      final m = idle();
      expect(() => m.get('v1/home'), throwsA(isA<HubNotConnectedException>()));
      expect(() => m.getBytes('v1/x'), throwsA(isA<HubNotConnectedException>()));
      expect(() => m.sendCommand('v1/x', {}), throwsA(isA<HubNotConnectedException>()));
      expect(() => m.get('v1/home'), throwsStateError);
    });
  });
}
