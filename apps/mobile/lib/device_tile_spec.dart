import 'package:flutter/material.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

/// A [DeviceControlTile]'s visual + interaction spec, derived from a device's LIVE (state +
/// stream-merged) values — shared by every device list in the app (room categories, the lighting
/// page, discovery, …) so a given device looks and behaves identically everywhere it appears.
class TileSpec {
  const TileSpec({required this.kind, required this.icon, required this.slidable, required this.fill, required this.on, required this.value});
  /// The capability this tile is primarily driven by — the toggle/drag handlers switch on this,
  /// never on [icon] (which is presentation only and could change independently).
  final String kind;
  final IconData icon;
  final bool slidable;
  final double fill;
  final bool on;
  final String value;
}

TileSpec tileSpec(Device d, Map<String, dynamic> state) {
  final caps = d.capabilities;
  if (caps.contains('brightness')) {
    final b = state['brightness'] as Map<String, dynamic>?;
    final c = state['color'] as Map<String, dynamic>?;
    final on = (b?['on'] as bool?) ?? (c?['on'] as bool?) ?? false;
    final level = (((b?['level'] as num?) ?? (c?['level'] as num?)) ?? (on ? 100 : 0)) / 100.0;
    return TileSpec(kind: 'brightness', icon: Icons.lightbulb_outline, slidable: true, fill: level, on: on, value: on ? '${(level * 100).round()}%' : 'Off');
  }
  if (caps.contains('position')) {
    final p = (state['position'] as Map<String, dynamic>?)?['position'] as num? ?? 0;
    return TileSpec(kind: 'position', icon: Icons.blinds_outlined, slidable: true, fill: p / 100.0, on: p > 0, value: '${p.round()}%');
  }
  if (caps.contains('media')) {
    final m = state['media'] as Map<String, dynamic>?;
    final playing = (m?['playback'] as String?) == 'playing';
    return TileSpec(kind: 'media', icon: Icons.music_note_outlined, slidable: false, fill: 0, on: playing, value: playing ? 'Playing' : 'Idle');
  }
  if (caps.contains('temperature')) {
    final t = state['temperature'] as Map<String, dynamic>?;
    final target = t?['targetC'] as num?;
    return TileSpec(kind: 'temperature', icon: Icons.thermostat_outlined, slidable: false, fill: 0, on: (t?['mode'] as String?) != 'off', value: target != null ? '${target.round()}°' : '—');
  }
  if (caps.contains('fan')) {
    final on = (state['fan'] as Map<String, dynamic>?)?['on'] as bool? ?? false;
    return TileSpec(kind: 'fan', icon: Icons.mode_fan_off_outlined, slidable: false, fill: 0, on: on, value: on ? 'On' : 'Off');
  }
  if (caps.contains('vacuum')) {
    final st = (state['vacuum'] as Map<String, dynamic>?)?['status'] as String? ?? 'idle';
    return TileSpec(kind: 'vacuum', icon: Icons.cleaning_services_outlined, slidable: false, fill: 0, on: st == 'cleaning', value: st[0].toUpperCase() + st.substring(1));
  }
  if (caps.contains('lock')) {
    final locked = (state['lock'] as Map<String, dynamic>?)?['locked'] as bool? ?? true;
    return TileSpec(kind: 'lock', icon: locked ? Icons.lock_outline : Icons.lock_open_outlined, slidable: false, fill: 0, on: !locked, value: locked ? 'Locked' : 'Unlocked');
  }
  if (caps.contains('sensor')) {
    final s = state['sensor'] as Map<String, dynamic>?;
    return TileSpec(kind: 'sensor', icon: Icons.sensors_outlined, slidable: false, fill: 0, on: false, value: '${(s?['value'] as num?) ?? '—'} ${(s?['unit'] as String?) ?? ''}'.trim());
  }
  final on = (state['onoff'] as Map<String, dynamic>?)?['on'] as bool? ?? false;
  return TileSpec(kind: 'onoff', icon: Icons.toggle_on_outlined, slidable: false, fill: on ? 1 : 0, on: on, value: on ? 'On' : 'Off');
}
