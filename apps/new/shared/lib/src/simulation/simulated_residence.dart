/// A simulated residence that speaks the REAL Hub contract at the transport boundary — the same
/// REST reads (`/v1/home`, `/v1/devices`, `/v1/rooms/:id/devices`, `/v1/scenes`), the same command
/// routes (`POST /v1/devices/:id/command`, `POST /v1/scenes/:id/activate`) and the same
/// `/v1/stream` `state` frames (`{type, deviceId, roomId, state:{kind,…}, seq, ts}`).
///
/// It is NOT a Hub replacement and lives entirely client-side, so nothing above the transport can
/// tell it from a Hub: `ResidenceState`, `CommandTracker` and every screen are the production
/// code. (ADR-0023 removed the *silent* Hub-side simulator; this is explicit, opt-in, and
/// never reachable unless composed in.)
///
/// What makes it a real state flow rather than static data: a command is only *accepted* on the
/// route; the device then reports its new state some latency later as a stream frame — shades
/// travel through intermediate positions — and it can be told to misbehave (never report, go
/// offline, change on its own like a wall switch), which is how the failure paths are proven.
library;

import 'dart:async';
import 'dart:typed_data';

import '../connection/transport.dart';
import 'simulated_scene_runner.dart';
import '../residence/command_tracker.dart';
import '../runtime/event_stream_transport.dart';

class SimulatedResidence {
  final Schedule _schedule;
  final DateTime Function() _now;
  final Duration reportLatency;

  /// Time a shade takes per 10 percentage points of travel.
  final Duration shadeStep;

  final _rooms = <Map<String, dynamic>>[];
  final _devices = <String, Map<String, dynamic>>{};
  final _scenes = <Map<String, dynamic>>[];
  final _seq = <String, int>{};
  final _frames = StreamController<Map<String, dynamic>>.broadcast();
  final _silent = <String>{};
  final _heroImages = <String?, Uint8List>{}; // null key = the residence
  late final SimulatedSceneRunner _runner;

  SimulatedResidence({
    Schedule? schedule,
    DateTime Function()? now,
    this.reportLatency = const Duration(milliseconds: 450),
    this.shadeStep = const Duration(milliseconds: 500),
  })  : _schedule = schedule ?? ((d, f) => Timer(d, f)),
        _now = now ?? DateTime.now {
    _seedVilla();
    _runner = SimulatedSceneRunner(
      schedule: _schedule,
      now: _now,
      sendCommand: (id, cmd) {
        final d = _devices[id];
        if (d == null) throw StateError('device not found');
        if (d['status'] != 'online') throw StateError('device is ${d['status']}');
        _apply(id, cmd);
      },
      device: (id) => _devices[id],
      publish: (run) => _frames.add({
        'type': 'run',
        'run': run,
        'ts': _now().toUtc().toIso8601String(),
      }),
    );
  }

  late final SimulatedHubTransport transport = SimulatedHubTransport(this);
  late final SimulatedEventStream stream = SimulatedEventStream(_frames.stream);

  // ── fault injection (what a real residence does that a happy path never shows) ──────────

  /// The device accepts commands but never reports back.
  void setSilent(String deviceId, bool silent) =>
      silent ? _silent.add(deviceId) : _silent.remove(deviceId);

  /// Takes a device off the network. The stream has no reachability frame; a client learns this
  /// on its next snapshot read.
  void setReachability(String deviceId, String status) =>
      _devices[deviceId]!['status'] = status;

  /// Declares [capability] of [deviceId] as having NO feedback (a KNX actuator with no status
  /// address): its config says `feedback: none`, it accepts commands, and nothing is ever reported.
  void declareNoFeedback(String deviceId, String capability) {
    for (final c in (_devices[deviceId]!['capabilities'] as List).cast<Map<String, dynamic>>()) {
      if (c['kind'] == capability) c['config'] = <String, dynamic>{...Map<String, dynamic>.from(c['config'] as Map), 'feedback': 'none'};
    }
    _noFeedback.add('$deviceId:$capability');
  }

  /// Puts an arbitrary frame on the stream — for what a real Hub can send that this simulator's
  /// devices never do (a `commanded` or `assumed` state frame).
  void injectFrame(Map<String, dynamic> frame) => _frames.add(frame);

  final _noFeedback = <String>{};

  /// A change that did not come from a command — a wall switch, a manual override.
  void changePhysically(String deviceId, Map<String, dynamic> command) {
    _apply(deviceId, command, immediate: true);
  }

  Map<String, dynamic> deviceJson(String id) => _devices[id]!;

  // ── routes ────────────────────────────────────────────────────────────────────────────

  Map<String, dynamic> read(String path) {
    final p = path.startsWith('/') ? path.substring(1) : path;
    if (p == 'v1/home') {
      return {
        'home': {
          'id': 'sim-home',
          'name': 'Villa Son Vida',
          'address': null,
          'tier': 'signature',
          'masterUserId': 'sim-owner',
          'createdAt': '2026-01-01T00:00:00.000Z',
          'heroImageUrl': _heroUrl(null),
        },
        'rooms': _rooms,
      };
    }
    final run = RegExp(r'^v1/scenes/runs/([^/]+)$').firstMatch(p);
    if (run != null) {
      final r = _runner.get(run.group(1)!);
      if (r == null) throw StateError('run not found');
      return {'run': r};
    }
    if (p == 'v1/devices') return {'devices': _devices.values.toList()};
    if (p == 'v1/scenes') {
      return {
        'scenes': [for (final sc in _scenes) {...sc, 'roomIds': _roomsOf(sc)}]
      };
    }
    final m = RegExp(r'^v1/rooms/([^/]+)/devices$').firstMatch(p);
    if (m != null) {
      return {
        'devices': [
          for (final d in _devices.values)
            if (d['roomId'] == m.group(1)) d
        ]
      };
    }
    throw StateError('simulated Hub has no route GET $path');
  }

  Map<String, dynamic> command(String path, Map<String, dynamic> body) {
    final p = path.startsWith('/') ? path.substring(1) : path;
    final dev = RegExp(r'^v1/devices/([^/]+)/command$').firstMatch(p);
    if (dev != null) {
      final id = dev.group(1)!;
      final device = _devices[id];
      if (device == null) throw StateError('device not found');
      if (device['status'] != 'online') {
        throw StateError('device is ${device['status']}');
      }
      _apply(id, Map<String, dynamic>.from(body['command'] as Map));
      // The route's answer is the state BEFORE the device reports — never the outcome.
      return {'accepted': true, 'device': device};
    }
    final scene = RegExp(r'^v1/scenes/([^/]+)/activate$').firstMatch(p);
    if (scene != null) {
      final sc = _scenes.firstWhere((s) => s['id'] == scene.group(1),
          orElse: () => throw StateError('scene not found'));
      final spaces = [
        ...((body['spaceIds'] as List?) ?? const []).cast<String>()
      ];
      final run = _runner.start(sc, spaces);
      return {
        'activated': true,
        'steps': (run['steps'] as List)
            .where((st) => (st as Map)['state'] != 'skipped')
            .length,
        'run': run,
      };
    }
    throw StateError('simulated Hub has no route POST $path');
  }

  // ── device behaviour ──────────────────────────────────────────────────────────────────

  void _apply(String id, Map<String, dynamic> cmd, {bool immediate = false}) {
    final cap = cmd['capability'] as String;
    final device = _devices[id]!;
    if ((device['state'] as Map<String, dynamic>)[cap] == null) {
      return; // capability not on this device: nothing reports.
    }
    final after = immediate ? Duration.zero : reportLatency;
    if (!immediate && _noFeedback.contains('$id:$cap')) return; // accepted; nothing ever reports

    // The device applies the command to ITS state when it acts, not to the state it had when the
    // command was sent — two commands in flight compose, they do not overwrite each other.
    void report(Map<String, dynamic> Function(Map<String, dynamic> s) change) =>
        _schedule(after, () {
          if (_silent.contains(id) && !immediate) return;
          final now = Map<String, dynamic>.from(
              (device['state'] as Map<String, dynamic>)[cap] as Map<String, dynamic>)
            ..remove('kind');
          _publish(id, cap, change(now));
        });

    switch (cap) {
      case 'onoff':
        report((s) => {
              ...s,
              'on': cmd['action'] == 'on'
                  ? true
                  : cmd['action'] == 'off'
                      ? false
                      : !(s['on'] as bool)
            });
      case 'brightness':
        final a = cmd['action'];
        final lvl = (cmd['level'] as num?)?.toInt();
        if (a == 'off') {
          report((s) => {...s, 'on': false});
        } else if (a == 'on') {
          report((s) => {
                ...s,
                'on': true,
                if ((s['level'] as num) == 0) 'level': 100
              });
        } else if (lvl != null) {
          report((s) => {...s, 'on': lvl > 0, 'level': lvl});
        }
      case 'position':
        final target = switch (cmd['action']) {
          'open' => 100,
          'close' => 0,
          'set' => (cmd['position'] as num).toInt(),
          _ => null
        };
        if (target == null) return;
        _travel(id, target, after);
      case 'temperature':
        report((s) => {
              ...s,
              if (cmd['targetC'] != null)
                'targetC': (cmd['targetC'] as num).toDouble(),
              if (cmd['mode'] != null) 'mode': cmd['mode'],
            });
      case 'media':
        report((s) {
          final next = {...s};
          switch (cmd['action']) {
            case 'play':
              next['playback'] = 'playing';
            case 'pause':
              next['playback'] = 'paused';
            case 'stop':
              next['playback'] = 'stopped';
            case 'volume':
              next['volume'] = (cmd['volume'] as num).toInt();
            case 'mute':
              next['muted'] = true;
            case 'unmute':
              next['muted'] = false;
          }
          return next;
        });
    }
  }

  /// A shade is physical: it reports `moving` and passes through intermediate positions.
  void _travel(String id, int target, Duration lead) {
    Map<String, dynamic> current() => Map<String, dynamic>.from(
        (_devices[id]!['state'] as Map<String, dynamic>)['position']
            as Map<String, dynamic>)
      ..remove('kind');
    void step() {
      if (_silent.contains(id)) return;
      final from = current();
      var pos = (from['position'] as num).toInt();
      final delta = target - pos;
      if (delta == 0) {
        _publish(id, 'position', {...from, 'moving': false});
        return;
      }
      pos += delta.abs() <= 10 ? delta : (delta > 0 ? 10 : -10);
      final done = pos == target;
      _publish(id, 'position', {...from, 'position': pos, 'moving': !done});
      if (!done) _schedule(shadeStep, step);
    }

    _schedule(lead, step);
  }

  void _publish(String id, String cap, Map<String, dynamic> s) {
    final device = _devices[id]!;
    final full = {'kind': cap, ...s};
    (device['state'] as Map<String, dynamic>)[cap] = full;
    final seq = (_seq[id] ?? 0) + 1;
    _seq[id] = seq;
    _frames.add({
      'type': 'state',
      'homeId': 'sim-home',
      'roomId': device['roomId'],
      'deviceId': id,
      'state': full,
      'provenance': 'observed',
      'seq': seq,
      'ts': _now().toUtc().toIso8601String(),
    });
    // The device's frame goes out first; a run that concludes on it follows (as on the gateway).
    _runner.onReport(id, cap, full);
  }

  // ── the residence ─────────────────────────────────────────────────────────────────────

  void _seedVilla() {
    void room(String id, String name, int floor) => _rooms.add({
          'id': id,
          'homeId': 'sim-home',
          'name': name,
          'floor': floor,
          'building': null,
          'area': null,
          'areaType': 'other',
          'sortOrder': _rooms.length,
          'icon': null,
          'heroImageUrl': null,
          'parentRoomId': null,
        });
    void device(String id, String room, String name, String type,
        Map<String, Map<String, dynamic>> caps) {
      _devices[id] = {
        'id': id,
        'homeId': 'sim-home',
        'roomId': room,
        'name': name,
        'supremeType': type,
        'manufacturer': null,
        'model': null,
        'driverId': null,
        'status': 'online',
        'capabilities': [
          for (final e in caps.entries)
            {'kind': e.key, 'config': <String, dynamic>{}}
        ],
        'state': {
          for (final e in caps.entries) e.key: {'kind': e.key, ...e.value}
        },
        'metadata': <String, dynamic>{},
      };
    }

    Map<String, Map<String, dynamic>> dimmer(int level) => {
          'onoff': {'on': level > 0},
          'brightness': {'on': level > 0, 'level': level},
        };
    Map<String, dynamic> shade(int p) => {'position': p, 'moving': false};
    Map<String, dynamic> climate(double a, double t) =>
        {'ambientC': a, 'targetC': t, 'mode': 'auto'};
    Map<String, dynamic> media(bool playing) => {
          'playback': playing ? 'playing' : 'paused',
          'volume': 30,
          'muted': false,
          'title': playing ? 'Clair de Lune' : null,
          'artist': playing ? 'Debussy' : null,
          'album': null,
          'source': null,
          'artworkUrl': null,
          'durationSec': null,
          'positionSec': null,
          'advanced': null,
        };

    room('living', 'Living Room', 0);
    room('dining', 'Dining Room', 0);
    room('kitchen', 'Kitchen', 0);
    room('terrace', 'Terrace', 0);
    room('master', 'Master Bedroom', 1);

    device(
        'living-light', 'living', 'Living Room lights', 'dimmer', dimmer(60));
    device('living-shade', 'living', 'Living Room shades', 'cover',
        {'position': shade(100)});
    device('living-climate', 'living', 'Living Room climate', 'thermostat',
        {'temperature': climate(22.5, 22.0)});
    device('living-audio', 'living', 'Living Room speaker', 'media_player',
        {'media': media(true)});
    device(
        'dining-light', 'dining', 'Dining Room lights', 'dimmer', dimmer(40));
    device('dining-shade', 'dining', 'Dining Room shades', 'cover',
        {'position': shade(100)});
    device('kitchen-light', 'kitchen', 'Kitchen lights', 'dimmer', dimmer(0));
    device('terrace-light', 'terrace', 'Terrace lights', 'light', {
      'onoff': {'on': false}
    });
    device('terrace-audio', 'terrace', 'Terrace speaker', 'media_player',
        {'media': media(false)});
    device(
        'master-light', 'master', 'Master Bedroom lights', 'dimmer', dimmer(0));
    device('master-shade', 'master', 'Master Bedroom shades', 'cover',
        {'position': shade(0)});
    device('master-climate', 'master', 'Master Bedroom climate', 'thermostat',
        {'temperature': climate(21.0, 20.0)});

    Map<String, dynamic> step(String dev, String cap, Map<String, dynamic> v) =>
        {'deviceId': dev, 'capability': cap, 'values': v};
    void scene(String id, String name, String scope, String? roomId,
            List<Map<String, dynamic>> steps,
            {String? description, List<List<int>> phases = const []}) =>
        _scenes.add({
          'id': id,
          'homeId': 'sim-home',
          'name': name,
          'scope': scope,
          'roomId': roomId,
          'ownerUserId': null,
          'icon': null,
          'aiGenerated': false,
          'description': description,
          'phases': phases,
          'sourceDriverId': null,
          'sourceSceneId': null,
          'imported': false,
          'syncStatus': null,
          'steps': steps,
        });

    scene('relax', 'Relax', 'home', null, [
      step('living-light', 'brightness', {'action': 'set', 'level': 30}),
      step('living-shade', 'position', {'action': 'set', 'position': 60}),
      step('living-audio', 'media', {'action': 'play'}),
      step('dining-light', 'brightness', {'action': 'set', 'level': 20}),
    ],
        description: 'Soft, warm light and quiet music',
        // The curtains settle first; then the light and the music follow.
        phases: [
          [1],
          [0, 2, 3]
        ]);
    scene('dinner', 'Dinner', 'home', null, [
      step('dining-light', 'brightness', {'action': 'set', 'level': 55}),
      step('living-light', 'brightness', {'action': 'set', 'level': 15}),
      step('kitchen-light', 'brightness', {'action': 'set', 'level': 35}),
      step('living-audio', 'media', {'action': 'volume', 'volume': 18}),
    ]);
    scene('good-night', 'Good Night', 'home', null, [
      step('living-light', 'brightness', {'action': 'off'}),
      step('dining-light', 'brightness', {'action': 'off'}),
      step('kitchen-light', 'brightness', {'action': 'off'}),
      step('terrace-light', 'onoff', {'action': 'off'}),
      step('master-shade', 'position', {'action': 'close'}),
      step('living-audio', 'media', {'action': 'pause'}),
    ]);
  }

  List<String> _roomsOf(Map<String, dynamic> scene) => {
        for (final st in (scene['steps'] as List).cast<Map<String, dynamic>>())
          if (_devices[st['deviceId']]?['roomId'] is String)
            _devices[st['deviceId']]!['roomId'] as String
      }.toList();

  String? _heroUrl(String? roomId) {
    final b = _heroImages[roomId];
    if (b == null) return null;
    final path = roomId == null ? '/v1/home/hero-image' : '/v1/rooms/$roomId/hero-image';
    return '$path?v=${_hash(b)}';
  }

  static String _hash(Uint8List b) {
    // A stable content tag (the real Hub uses sha-256; only its stability matters here).
    var h = 0xcbf29ce484222325;
    for (final x in b) {
      h = ((h ^ x) * 0x100000001b3) & 0x7fffffffffffffff;
    }
    return h.toRadixString(16).padLeft(32, '0');
  }

  /// Gives the residence ([roomId] null) or a space a photograph, as the Hub's asset slot does.
  void setHeroImage(String? roomId, List<int> bytes) {
    _heroImages[roomId] = Uint8List.fromList(bytes);
    if (roomId != null) {
      final room = _rooms.firstWhere((r) => r['id'] == roomId);
      room['heroImageUrl'] = _heroUrl(roomId);
    }
  }

  /// Every asset path the Hub was asked for, exactly as asked (query included).
  final byteReads = <String>[];

  /// The content version currently in the URL of [roomId]'s (or the residence's) picture.
  String heroVersion(String? roomId) => _hash(_heroImages[roomId]!);

  /// The serving contract for assets: bytes + strong ETag, `notModified` on a matching tag.
  HubBytes readBytes(String path, {String? ifNoneMatch}) {
    byteReads.add(path);
    final p = (path.startsWith('/') ? path.substring(1) : path).split('?').first;
    String? room;
    if (p == 'v1/home/hero-image') {
      room = null;
    } else {
      final m = RegExp(r'^v1/rooms/([^/]+)/hero-image$').firstMatch(p);
      if (m == null) throw StateError('simulated Hub has no binary route $path');
      room = m.group(1);
    }
    final b = _heroImages[room];
    if (b == null) throw StateError('not_found');
    final etag = '"${_hash(b)}"';
    if (ifNoneMatch == etag) return HubBytes(notModified: true, etag: etag);
    return HubBytes(bytes: b, contentType: 'image/png', etag: etag);
  }

  Future<void> dispose() async => _frames.close();
}

class SimulatedHubTransport implements HubTransport {
  final SimulatedResidence _r;
  bool _up = false;
  SimulatedHubTransport(this._r);

  @override
  bool get isConnected => _up;
  @override
  Future<void> connect() async {}
  @override
  Future<void> authenticate() async => _up = true;
  @override
  Future<void> disconnect() async => _up = false;

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (!_up) throw StateError('not authenticated');
    return _r.read(path);
  }

  @override
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) async {
    if (!_up) throw StateError('not authenticated');
    return _r.command(path, body);
  }

  @override
  Future<HubBytes> getBytes(String path, {String? ifNoneMatch}) async {
    if (!_up) throw StateError('not authenticated');
    return _r.readBytes(path, ifNoneMatch: ifNoneMatch);
  }

  @override
  Stream<Map<String, dynamic>> events() => _r._frames.stream;
}

class SimulatedEventStream implements EventStreamTransport {
  final Stream<Map<String, dynamic>> _frames;
  SimulatedEventStream(this._frames);
  @override
  Stream<HubEventStreamState> get state =>
      Stream.value(HubEventStreamState.subscribed);
  @override
  Stream<Map<String, dynamic>> get frames => _frames;
  @override
  Future<void> connect() async {}
  @override
  Future<void> disconnect() async {}
  @override
  void send(Map<String, dynamic> frame) {}
  @override
  Future<void> dispose() async {}
}
