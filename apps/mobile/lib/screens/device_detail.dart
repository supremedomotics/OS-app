import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// Rich, capability-routed device detail (§11.1): climate setpoints, media
/// transport, cover position, or a lock slide-to-confirm — chosen by the device's
/// Supreme capabilities, never by any backend type.
class DeviceDetailScreen extends ConsumerWidget {
  const DeviceDetailScreen({super.key, required this.device});

  final Device device;

  Future<void> _cmd(WidgetRef ref, Map<String, dynamic> command) {
    return ref.read(clientProvider).command(device.id, command);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: Text(device.name)),
      body: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: _buildControl(context, ref),
      ),
    );
  }

  Widget _buildControl(BuildContext context, WidgetRef ref) {
    if (device.capabilities.contains('temperature')) {
      final t = device.state['temperature'] as Map<String, dynamic>?;
      return ClimateCard(
        ambientC: ((t?['ambientC'] as num?) ?? 21).toDouble(),
        targetC: (t?['targetC'] as num?)?.toDouble(),
        mode: (t?['mode'] as String?) ?? 'auto',
        onTarget: (v) => _cmd(ref, {'capability': 'temperature', 'targetC': v}),
        onMode: (m) => _cmd(ref, {'capability': 'temperature', 'mode': m}),
      );
    }
    if (device.capabilities.contains('media')) {
      final m = device.state['media'] as Map<String, dynamic>?;
      final playing = (m?['playback'] as String?) == 'playing';
      return MediaCard(
        title: m?['title'] as String?,
        artist: m?['artist'] as String?,
        playing: playing,
        volume: ((m?['volume'] as num?) ?? 30).toDouble() / 100.0,
        artworkUrl: m?['artworkUrl'] as String?,
        onPlayPause: () => _cmd(
            ref, {'capability': 'media', 'action': playing ? 'pause' : 'play'}),
        onNext: () => _cmd(ref, {'capability': 'media', 'action': 'next'}),
        onPrevious: () =>
            _cmd(ref, {'capability': 'media', 'action': 'previous'}),
        onVolume: (v) => _cmd(ref, {
          'capability': 'media',
          'action': 'volume',
          'volume': (v * 100).round()
        }),
      );
    }
    if (device.capabilities.contains('position')) {
      final p = device.state['position'] as Map<String, dynamic>?;
      final pos = ((p?['position'] as num?) ?? 0).toDouble() / 100.0;
      return FillTile(
        label: device.name,
        subtitle: '${(pos * 100).round()}% open',
        value: pos,
        on: pos > 0,
        onToggle: () => _cmd(ref,
            {'capability': 'position', 'action': pos > 0 ? 'close' : 'open'}),
        onChanged: (v) => _cmd(ref, {
          'capability': 'position',
          'action': 'set',
          'position': (v * 100).round()
        }),
      );
    }
    if (device.capabilities.contains('lock')) {
      return SlideToConfirm(
        label: 'Slide to unlock',
        icon: Icons.lock_open,
        onConfirmed: () =>
            _cmd(ref, {'capability': 'lock', 'action': 'unlock'}),
      );
    }
    // Lighting fallback (onoff / brightness).
    final hasBrightness = device.capabilities.contains('brightness');
    return FillTile(
      label: device.name,
      subtitle:
          device.isOn ? '${(device.brightnessFraction * 100).round()}%' : 'Off',
      value: device.brightnessFraction,
      on: device.isOn,
      onToggle: () => _cmd(ref, {
        'capability': hasBrightness ? 'brightness' : 'onoff',
        'action': device.isOn ? 'off' : 'on',
      }),
      onChanged: (v) => _cmd(ref, {
        'capability': 'brightness',
        'action': 'set',
        'level': (v * 100).round()
      }),
    );
  }
}
