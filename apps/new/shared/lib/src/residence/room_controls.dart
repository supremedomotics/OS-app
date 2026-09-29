/// The controls a set of devices can honestly offer, and the commands they send — derived from
/// the Residence State and the command lifecycle, holding nothing of their own.
///
/// Capability-driven (§ Development principles): a control exists only where a device DECLARES
/// the capability AND that capability's command has a verifiable effect (`expectationOf`). A
/// room with two lighting circuits gets one Lights control that commands both — the Golden
/// Master's aggregate — so the old "ambiguous device" dead end no longer exists.
///
/// Every value has two faces, exactly as the Golden Master's grammar has them: what the devices
/// REPORT (`level`, `position`, …) and what has been REQUESTED but not yet reported
/// (`pendingLevel`, …, from in-flight commands). Nothing here ever merges them.
library;

import 'command_tracker.dart';
import 'residence_state.dart';

class DeviceCommand {
  final String deviceId;
  final Map<String, dynamic> command;
  const DeviceCommand(this.deviceId, this.command);
}

double? _avg(Iterable<num> v) =>
    v.isEmpty ? null : v.reduce((a, b) => a + b) / v.length;

Iterable<CommandRecord> _for(Iterable<CommandRecord> all, Set<String> ids, String cap) =>
    all.where((c) => c.inFlight && c.capability == cap && ids.contains(c.deviceId));

/// The most recent failed command for a control, for the sentence that says it was not done.
CommandFailure? failedRecently(
    CommandTracker tracker, Iterable<String> deviceIds, String capability) {
  for (final id in deviceIds) {
    final r = tracker.latestFor(id, capability);
    if (r != null && r.phase == CommandPhase.failed) return r.failure;
  }
  return null;
}

// ── lights ────────────────────────────────────────────────────────────────────────────────

class RoomLights {
  final List<DeviceRecord> lights;
  final List<DeviceRecord> online;

  /// true = all on, false = all off, null = some on.
  final bool? allOn;
  final int onCount;
  final bool dimmable;

  /// Mean reported level of the lights that are on; null when none is.
  final int? level;

  /// Mean requested level while a brightness command is in flight.
  final int? pendingLevel;

  /// A power command is in flight.
  final bool pendingPower;
  final List<String> unresponsive;

  const RoomLights._(this.lights, this.online, this.allOn, this.onCount,
      this.dimmable, this.level, this.pendingLevel, this.pendingPower, this.unresponsive);

  static bool _isLight(DeviceRecord d) =>
      d.capabilities.containsKey('brightness') ||
      (d.capabilities.containsKey('onoff') &&
          (d.supremeType == 'light' ||
              d.supremeType == 'dimmer' ||
              d.supremeType == 'color_light'));

  static bool _on(DeviceRecord d) =>
      (d.state['brightness']?['on'] ?? d.state['onoff']?['on']) == true;

  /// Null when [devices] hold no light — the control is then not drawn at all.
  static RoomLights? of(
      Iterable<DeviceRecord> devices, Iterable<CommandRecord> inFlight) {
    final lights = devices.where(_isLight).toList();
    if (lights.isEmpty) return null;
    final online = lights.where((d) => d.isOnline).toList();
    final on = online.where(_on).toList();
    final ids = {for (final l in online) l.id};
    final dim = online.where((d) => d.capabilities.containsKey('brightness')).toList();
    final levels = [
      for (final d in on)
        if (d.state['brightness'] != null)
          (d.state['brightness']!['level'] as num?) ?? 100
    ];
    final pl = _avg([
      for (final c in _for(inFlight, ids, 'brightness'))
        if (c.command['level'] is num) c.command['level'] as num
    ]);
    return RoomLights._(
      lights,
      online,
      online.isEmpty ? false : on.isEmpty ? false : on.length == online.length ? true : null,
      on.length,
      dim.isNotEmpty,
      _avg(levels)?.round(),
      pl?.round(),
      _for(inFlight, ids, 'onoff').isNotEmpty ||
          _for(inFlight, ids, 'brightness').any((c) => c.command['action'] != 'set'),
      [for (final d in lights) if (!d.isOnline) d.name],
    );
  }

  Map<String, dynamic> _power(DeviceRecord d, bool on) =>
      d.capabilities.containsKey('brightness')
          ? {'capability': 'brightness', 'action': on ? 'on' : 'off'}
          : {'capability': 'onoff', 'action': on ? 'on' : 'off'};

  /// Mixed → all on (the Golden Master's tri-state convention).
  List<DeviceCommand> toggle() {
    final target = allOn != true;
    return [for (final d in online) DeviceCommand(d.id, _power(d, target))];
  }

  /// Sets the dimmable lights that are on (or every dimmable light when none is).
  List<DeviceCommand> setLevel(int level) {
    final dim = online.where((d) => d.capabilities.containsKey('brightness')).toList();
    final lit = dim.where(_on).toList();
    return [
      for (final d in lit.isEmpty ? dim : lit)
        DeviceCommand(d.id,
            {'capability': 'brightness', 'action': 'set', 'level': level.clamp(1, 100)})
    ];
  }
}

// ── curtains & shades ─────────────────────────────────────────────────────────────────────

class RoomShades {
  final List<DeviceRecord> shades;
  final List<DeviceRecord> online;
  final int? position;
  final int? pendingPosition;
  final bool moving;
  final List<String> unresponsive;

  const RoomShades._(this.shades, this.online, this.position,
      this.pendingPosition, this.moving, this.unresponsive);

  static RoomShades? of(
      Iterable<DeviceRecord> devices, Iterable<CommandRecord> inFlight) {
    final shades = devices.where((d) => d.capabilities.containsKey('position')).toList();
    if (shades.isEmpty) return null;
    final online = shades.where((d) => d.isOnline).toList();
    final ids = {for (final s in online) s.id};
    final pp = _avg([
      for (final c in _for(inFlight, ids, 'position'))
        switch (c.command['action']) {
          'open' => 100,
          'close' => 0,
          _ => (c.command['position'] as num?) ?? 0
        }
    ]);
    return RoomShades._(
      shades,
      online,
      _avg([for (final d in online) (d.state['position']?['position'] as num?) ?? 0])?.round(),
      pp?.round(),
      online.any((d) => d.state['position']?['moving'] == true),
      [for (final d in shades) if (!d.isOnline) d.name],
    );
  }

  List<DeviceCommand> to(int position) => [
        for (final d in online)
          DeviceCommand(d.id, position >= 100
              ? {'capability': 'position', 'action': 'open'}
              : position <= 0
                  ? {'capability': 'position', 'action': 'close'}
                  : {'capability': 'position', 'action': 'set', 'position': position})
      ];
}

// ── climate (one zone per thermostat) ─────────────────────────────────────────────────────

class RoomClimate {
  final DeviceRecord device;
  final double? ambientC;
  final double? targetC;
  final double? pendingTargetC;
  final String? mode;
  final bool on;
  final bool pendingPower;
  final double minC, maxC, step;
  final List<String> modes;

  const RoomClimate._(this.device, this.ambientC, this.targetC, this.pendingTargetC,
      this.mode, this.on, this.pendingPower, this.minC, this.maxC, this.step, this.modes);

  bool get online => device.isOnline;
  bool get canSetTarget => targetC != null;

  static List<RoomClimate> allOf(
      Iterable<DeviceRecord> devices, Iterable<CommandRecord> inFlight) {
    final out = <RoomClimate>[];
    for (final d in devices) {
      if (!d.capabilities.containsKey('temperature')) continue;
      final s = d.state['temperature'];
      final cfg = d.capabilities['temperature'] ?? const {};
      final range = cfg['temperatureRange'] as Map<String, dynamic>?;
      final mine = inFlight.where(
          (c) => c.inFlight && c.deviceId == d.id && c.capability == 'temperature');
      double? pt;
      var pp = false;
      for (final c in mine) {
        if (c.command['targetC'] is num) pt = (c.command['targetC'] as num).toDouble();
        if (c.command['mode'] != null) pp = true;
      }
      final mode = s?['mode'] as String?;
      out.add(RoomClimate._(
        d,
        (s?['ambientC'] as num?)?.toDouble(),
        (s?['targetC'] as num?)?.toDouble(),
        pt,
        mode,
        mode != null && mode != 'off',
        pp,
        (range?['minC'] as num?)?.toDouble() ?? 16,
        (range?['maxC'] as num?)?.toDouble() ?? 30,
        // The contract's own conservative default is 1°; a unit that reports a finer step wins.
        (range?['step'] as num?)?.toDouble() ?? 1,
        [
          for (final m in (cfg['modes'] as List<dynamic>? ?? const []))
            if (m is String) m
        ],
      ));
    }
    return out;
  }

  /// [direction] is +1 / −1; steps from the requested target when one is in flight.
  DeviceCommand? stepped(int direction) {
    final base = pendingTargetC ?? targetC;
    if (base == null || !online) return null;
    final next = (base + direction * step).clamp(minC, maxC).toDouble();
    if (next == base) return null;
    return DeviceCommand(device.id, {'capability': 'temperature', 'targetC': next});
  }

  DeviceCommand power(bool turnOn) => DeviceCommand(device.id,
      {'capability': 'temperature', 'mode': turnOn ? 'auto' : 'off'});
}

// ── music ─────────────────────────────────────────────────────────────────────────────────

class RoomMusic {
  final DeviceRecord device;
  final bool playing;
  final String? title;
  final String? artist;
  final int? volume;
  final int? pendingVolume;
  final bool? pendingPlaying;

  const RoomMusic._(this.device, this.playing, this.title, this.artist,
      this.volume, this.pendingVolume, this.pendingPlaying);

  bool get online => device.isOnline;

  static List<RoomMusic> allOf(
      Iterable<DeviceRecord> devices, Iterable<CommandRecord> inFlight) {
    final out = <RoomMusic>[];
    for (final d in devices) {
      if (!d.capabilities.containsKey('media')) continue;
      final s = d.state['media'];
      final mine = inFlight
          .where((c) => c.inFlight && c.deviceId == d.id && c.capability == 'media');
      int? pv;
      bool? pp;
      for (final c in mine) {
        switch (c.command['action']) {
          case 'volume':
            pv = (c.command['volume'] as num).toInt();
          case 'play':
            pp = true;
          case 'pause':
            pp = false;
        }
      }
      out.add(RoomMusic._(
        d,
        s?['playback'] == 'playing',
        s?['title'] as String?,
        s?['artist'] as String?,
        (s?['volume'] as num?)?.toInt(),
        pv,
        pp,
      ));
    }
    return out;
  }

  DeviceCommand toggle() => DeviceCommand(device.id, {
        'capability': 'media',
        'action': (pendingPlaying ?? playing) ? 'pause' : 'play'
      });

  DeviceCommand setVolume(int v) => DeviceCommand(device.id,
      {'capability': 'media', 'action': 'volume', 'volume': v.clamp(0, 100)});
}
