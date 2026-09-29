/// The canonical Residence State as this client knows it (§ ADR "the Hub is authoritative").
///
/// This is a READ MODEL of the Hub's own records — `Room`, `Device` (with `state`), `Scene` from
/// `packages/domain-model` — hydrated from the real REST reads (`/v1/home`, `/v1/devices`,
/// `/v1/scenes`) and kept current by the real `/v1/stream` state deltas. It owns no truth of its
/// own: nothing here is ever written by a control, only by the Hub's report. A homeowner action
/// goes through `CommandTracker`, which never edits this state either.
///
/// Every field on [DeviceRecord] is 1:1 with the domain-model `Device`
/// (`test/residence_contract_parity_test.dart` reads the TS schema and fails on drift).
library;

import 'dart:async';

import '../capabilities.dart';
import '../experiences.dart';
import '../semantic_model.dart';

enum DeviceReachability { online, offline, unavailable }

class DeviceRecord {
  final String id;
  final String? roomId;
  final String name;
  final String supremeType;
  final DeviceReachability reachability;

  /// Declared capabilities, kind → config (the Hub's `capabilities[].{kind, config}`).
  final Map<String, Map<String, dynamic>> capabilities;

  /// Last authoritative state per capability kind (the Hub's `state`).
  final Map<String, Map<String, dynamic>> state;

  /// When the Hub last REPORTED this device over the stream (the frame's `ts`). Null means the
  /// state came from a snapshot read only — its age is unknown, and the UI must not imply
  /// freshness it cannot prove.
  final DateTime? reportedAt;

  /// Per-device stream sequence of the last applied report (0 = none since (re)connect).
  final int seq;

  const DeviceRecord({
    required this.id,
    required this.roomId,
    required this.name,
    required this.supremeType,
    required this.reachability,
    required this.capabilities,
    required this.state,
    this.reportedAt,
    this.seq = 0,
  });

  bool get isOnline => reachability == DeviceReachability.online;

  bool declares(CapabilityKind kind) => capabilities.containsKey(kind.name);

  DeviceRecord copyWith({
    Map<String, Map<String, dynamic>>? state,
    DateTime? reportedAt,
    int? seq,
    DeviceReachability? reachability,
  }) =>
      DeviceRecord(
        id: id,
        roomId: roomId,
        name: name,
        supremeType: supremeType,
        reachability: reachability ?? this.reachability,
        capabilities: capabilities,
        state: state ?? this.state,
        reportedAt: reportedAt ?? this.reportedAt,
        seq: seq ?? this.seq,
      );

  static DeviceRecord? fromJson(Map<String, dynamic> j) {
    final id = j['id'];
    final name = j['name'];
    if (id is! String || name is! String) return null;
    final caps = <String, Map<String, dynamic>>{};
    for (final c in (j['capabilities'] as List<dynamic>? ?? const [])) {
      if (c is Map<String, dynamic> && c['kind'] is String) {
        caps[c['kind'] as String] =
            (c['config'] as Map<String, dynamic>?) ?? const {};
      }
    }
    final st = <String, Map<String, dynamic>>{};
    (j['state'] as Map<String, dynamic>? ?? const {}).forEach((k, v) {
      if (v is Map<String, dynamic>) st[k] = v;
    });
    return DeviceRecord(
      id: id,
      roomId: j['roomId'] as String?,
      name: name,
      supremeType: j['supremeType'] as String? ?? 'unknown',
      reachability: switch (j['status']) {
        'offline' => DeviceReachability.offline,
        'unavailable' => DeviceReachability.unavailable,
        _ => DeviceReachability.online,
      },
      capabilities: caps,
      state: st,
    );
  }
}

/// An immutable point-in-time view. Widgets read this; they never hold a copy of it.
class ResidenceSnapshot {
  final bool loaded;

  /// Whether the last snapshot read reached the Hub: null before the first attempt, false when
  /// it failed (the last known state below is then kept, not blanked).
  final bool? reachable;

  /// The residence's own name, as the Hub reports it (`/v1/home`). Empty until first read.
  final String name;
  final List<Space> spaces;
  final Map<String, DeviceRecord> devices;
  final List<Experience> experiences;

  /// Set when a snapshot read last succeeded — the age of anything with no `reportedAt`.
  final DateTime? loadedAt;

  const ResidenceSnapshot({
    this.loaded = false,
    this.reachable,
    this.name = '',
    this.spaces = const [],
    this.devices = const {},
    this.experiences = const [],
    this.loadedAt,
  });

  Space? space(String id) {
    for (final s in spaces) {
      if (s.id == id) return s;
    }
    return null;
  }

  List<DeviceRecord> devicesIn(String spaceId) => [
        for (final d in devices.values)
          if (d.roomId == spaceId) d
      ];

  ResidenceSnapshot _with({
    bool? loaded,
    bool? reachable,
    String? name,
    List<Space>? spaces,
    Map<String, DeviceRecord>? devices,
    List<Experience>? experiences,
    DateTime? loadedAt,
  }) =>
      ResidenceSnapshot(
        loaded: loaded ?? this.loaded,
        reachable: reachable ?? this.reachable,
        name: name ?? this.name,
        spaces: spaces ?? this.spaces,
        devices: devices ?? this.devices,
        experiences: experiences ?? this.experiences,
        loadedAt: loadedAt ?? this.loadedAt,
      );
}

/// One accepted authoritative device report — what `CommandTracker` confirms against.
class DeviceReport {
  final String deviceId;
  final String capability;
  final Map<String, dynamic> state;
  final DateTime reportedAt;
  const DeviceReport(
      this.deviceId, this.capability, this.state, this.reportedAt);
}

typedef ResidenceGet = Future<Map<String, dynamic>> Function(String path);

class ResidenceState {
  final ResidenceGet _get;
  final Stream<Map<String, dynamic>> _frames;
  final DateTime Function() _now;

  ResidenceSnapshot _snapshot = const ResidenceSnapshot();
  StreamSubscription<Map<String, dynamic>>? _sub;
  final _changes = StreamController<ResidenceSnapshot>.broadcast();
  final _reports = StreamController<DeviceReport>.broadcast();
  bool _disposed = false;
  int _refreshing = 0;
  final _touchedDuringRefresh = <String>{};

  /// Frames received for a device this client has no record of — evidence the snapshot is
  /// stale; triggers a refresh instead of being silently applied.
  int unknownDeviceFrames = 0;

  ResidenceState({
    required ResidenceGet get,
    required Stream<Map<String, dynamic>> frames,
    DateTime Function()? now,
  })  : _get = get,
        _frames = frames,
        _now = now ?? DateTime.now;

  ResidenceSnapshot get snapshot => _snapshot;
  Stream<ResidenceSnapshot> get changes => _changes.stream;
  Stream<DeviceReport> get reports => _reports.stream;

  /// Begins listening to the live stream and performs the first snapshot read.
  Future<void> start() async {
    _sub ??= _frames.listen(_onFrame);
    await refresh();
  }

  /// The stream (re)connected: its per-device sequence numbers restart, and anything that
  /// changed while it was down is only recoverable from a snapshot.
  Future<void> streamRestarted() async {
    _snapshot = _snapshot._with(devices: {
      for (final e in _snapshot.devices.entries) e.key: e.value.copyWith(seq: 0)
    });
    await refresh();
  }

  Future<void> refresh() async {
    _touchedDuringRefresh.clear();
    _refreshing++;
    try {
      await _refresh();
    } finally {
      _refreshing--;
    }
  }

  Future<void> _refresh() async {
    // An unreachable Hub (no connection yet, a dropped socket) is "no data yet", never a crash:
    // the caller learns why from [ResidenceSnapshot.reachable].
    Future<Map<String, dynamic>> read(String path) async {
      try {
        return await _get(path);
      } catch (_) {
        return const {};
      }
    }

    final home = await read('v1/home');
    final devicesRes = await read('v1/devices');
    final scenesRes = await read('v1/scenes');
    if (_disposed) return;

    final rooms = home['rooms'];
    final rawDevices = devicesRes['devices'];
    // An unreachable Hub yields empty maps from the transport: keep what we know rather than
    // replacing real state with nothing.
    if (rooms is! List || rawDevices is! List) {
      _snapshot = _snapshot._with(reachable: false);
      _emit();
      return;
    }

    final previous = _snapshot.devices;
    final devices = <String, DeviceRecord>{};
    for (final raw in rawDevices.whereType<Map<String, dynamic>>()) {
      final d = DeviceRecord.fromJson(raw);
      if (d == null) continue;
      final known = previous[d.id];
      // A live report that landed while this read was in flight is newer than the snapshot
      // (tracked by arrival, not by comparing the Hub's clock to ours).
      devices[d.id] = known != null && _touchedDuringRefresh.contains(d.id)
          ? d.copyWith(
              state: known.state, reportedAt: known.reportedAt, seq: known.seq)
          : d;
    }

    _snapshot = ResidenceSnapshot(
      loaded: true,
      reachable: true,
      name: home['name'] as String? ?? _snapshot.name,
      spaces: _spaces(rooms.whereType<Map<String, dynamic>>(), devices.values),
      devices: devices,
      experiences: _experiences(scenesRes['scenes']),
      loadedAt: _now(),
    );
    _emit();
  }

  void _emit() {
    if (!_disposed) _changes.add(_snapshot);
  }

  void _onFrame(Map<String, dynamic> f) {
    if (_disposed || f['type'] != 'state') return;
    final id = f['deviceId'];
    final st = f['state'];
    final seq = f['seq'];
    final ts = f['ts'];
    if (id is! String || st is! Map<String, dynamic> || ts is! String) return;
    final kind = st['kind'];
    if (kind is! String) return;
    final at = DateTime.tryParse(ts);
    if (at == null) return;
    final device = _snapshot.devices[id];
    if (device == null) {
      unknownDeviceFrames++;
      unawaited(refresh());
      return;
    }
    if (_refreshing > 0) _touchedDuringRefresh.add(id);
    final s = seq is int ? seq : 0;
    if (s != 0 && s <= device.seq)
      return; // stale / out-of-order — the contract says drop it.

    final next = {...device.state, kind: st};
    _snapshot = _snapshot._with(devices: {
      ..._snapshot.devices,
      id: device.copyWith(state: next, reportedAt: at, seq: s),
    });
    _emit();
    if (!_disposed) _reports.add(DeviceReport(id, kind, st, at));
  }

  static List<Space> _spaces(
      Iterable<Map<String, dynamic>> rooms, Iterable<DeviceRecord> devices) {
    final domains = <String, Set<HomeDomain>>{};
    for (final d in devices) {
      final r = d.roomId;
      if (r == null) continue;
      final set = domains.putIfAbsent(r, () => {});
      for (final kind in d.capabilities.keys) {
        final dom = _domainOf(kind);
        if (dom != null) set.add(dom);
      }
    }
    return [
      for (final r in rooms)
        if (r['id'] is String && r['name'] is String)
          Space(
            id: r['id'] as String,
            name: r['name'] as String,
            floorId: (r['floor'] as num?)?.toString(),
            imageUrl: r['heroImageUrl'] as String?,
            domains: domains[r['id']] ?? const {},
          )
    ];
  }

  static HomeDomain? _domainOf(String kind) {
    for (final e in domainCapabilities.entries) {
      if (e.value.any((k) => k.name == kind)) return e.key;
    }
    return null;
  }

  static List<Experience> _experiences(Object? raw) {
    if (raw is! List) return const [];
    return [
      for (final s in raw.whereType<Map<String, dynamic>>())
        if (s['id'] is String && s['name'] is String)
          Experience(
            id: s['id'] as String,
            name: s['name'] as String,
            iconName: s['icon'] as String?,
            spaceIds: [
              ...(s['roomIds'] as List<dynamic>? ?? const []).cast<String>(),
              if (s['roomId'] is String) s['roomId'] as String,
            ],
            steps: [
              for (final st in (s['steps'] as List<dynamic>? ?? const [])
                  .whereType<Map<String, dynamic>>())
                if (st['deviceId'] is String && st['capability'] is String)
                  ExperienceStep(
                    deviceId: st['deviceId'] as String,
                    capability: st['capability'] as String,
                    values: (st['values'] as Map<String, dynamic>?) ?? const {},
                  )
            ],
          )
    ];
  }

  Future<void> dispose() async {
    _disposed = true;
    await _sub?.cancel();
    await _changes.close();
    await _reports.close();
  }
}
