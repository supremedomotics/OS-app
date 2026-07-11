import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../color_mode.dart';
import '../device_tile_spec.dart';
import '../providers.dart';
import '../usage.dart';
import 'lighting_detail.dart';

/// The room's Lighting page (§11.1): reached via Room → Lighting on the category screen. A master
/// "all lights" control, room-wide colour-temperature and colour controls — each shown ONLY when
/// the room actually has a light that supports it — and every individual light as a tap-to-toggle,
/// drag-to-dim tile. Tapping a light's chevron opens its own full [LightingDetail]. Everything here
/// is live: a change made anywhere else (another screen, a physical switch, the driver's own app)
/// reflects immediately, because every value reads through [liveStatesProvider].
///
/// Remove device (§ Room detail): every light here is slidable (drag-to-dim uses the same
/// horizontal axis a swipe-to-delete gesture would), so removal is a small delete button
/// alongside the tile rather than a competing swipe.
class RoomLightingScreen extends ConsumerStatefulWidget {
  const RoomLightingScreen({super.key, required this.roomName, required this.lights});

  final String roomName;
  final List<Device> lights;

  @override
  ConsumerState<RoomLightingScreen> createState() => _RoomLightingScreenState();
}

class _RoomLightingScreenState extends ConsumerState<RoomLightingScreen> {
  final List<Device> _lights = [];

  @override
  void initState() {
    super.initState();
    _lights.addAll(widget.lights);
  }

  Map<String, dynamic>? _colorOf(Device d, Map<String, Map<String, dynamic>> live) => mergedDeviceState(d, live)['color'] as Map<String, dynamic>?;

  bool _onOf(Device d, Map<String, Map<String, dynamic>> live) {
    final s = mergedDeviceState(d, live);
    final b = s['brightness'] as Map<String, dynamic>?;
    final c = s['color'] as Map<String, dynamic>?;
    final o = s['onoff'] as Map<String, dynamic>?;
    return (b?['on'] ?? c?['on'] ?? o?['on']) == true;
  }

  double _levelOf(Device d, Map<String, Map<String, dynamic>> live) {
    final s = mergedDeviceState(d, live);
    final b = s['brightness'] as Map<String, dynamic>?;
    final c = s['color'] as Map<String, dynamic>?;
    final level = (b?['level'] as num?) ?? (c?['level'] as num?);
    if (level != null) return level.toDouble();
    return _onOf(d, live) ? 100 : 0;
  }

  void _setAll(WidgetRef ref, bool on) {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final live = ref.read(liveStatesProvider);
    for (final d in _lights) {
      final hasBrightness = d.capabilities.contains('brightness');
      if (hasBrightness) {
        // 100 is a far more plausible guess than 1 for an unknown/zero cached level — the
        // real device state corrects this within moments over the live stream regardless.
        final known = _levelOf(d, live);
        final lvl = on ? (known > 0 ? known : 100) : 0;
        apply(d.id, 'brightness', {'kind': 'brightness', 'on': on, 'level': lvl});
        client.command(d.id, {'capability': 'brightness', 'action': on ? 'on' : 'off'});
      } else {
        apply(d.id, 'onoff', {'kind': 'onoff', 'on': on});
        client.command(d.id, {'capability': 'onoff', 'action': on ? 'on' : 'off'});
      }
    }
  }

  void _setGroupKelvin(WidgetRef ref, List<Device> cctLights, double k) {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final live = ref.read(liveStatesProvider);
    final kr = k.round();
    for (final d in cctLights) {
      apply(d.id, 'color', {'kind': 'color', 'on': true, 'level': _levelOf(d, live), 'hue': null, 'saturation': null, 'kelvin': kr});
      client.command(d.id, {'capability': 'color', 'kelvin': kr});
    }
  }

  void _setGroupColour(WidgetRef ref, List<Device> rgbLights, double h, double s) {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final live = ref.read(liveStatesProvider);
    for (final d in rgbLights) {
      apply(d.id, 'color', {'kind': 'color', 'on': true, 'level': _levelOf(d, live), 'hue': h.round(), 'saturation': (s * 100).round(), 'kelvin': null});
      client.command(d.id, {'capability': 'color', 'hue': h.round(), 'saturation': (s * 100).round()});
    }
  }

  Future<void> _toggle(WidgetRef ref, Device d, bool on) async {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    ref.read(usageProvider.notifier).record('device', d.id);
    final hasBrightness = d.capabilities.contains('brightness');
    if (hasBrightness) {
      // Preserve a known dim level rather than always jumping to 100 — a light last set to
      // 30% should come back at 30%, not blow out to full brightness on every toggle-on.
      final known = _levelOf(d, ref.read(liveStatesProvider));
      final lvl = on ? (known > 0 ? known : 100) : 0;
      apply(d.id, 'brightness', {'kind': 'brightness', 'on': on, 'level': lvl});
      await client.command(d.id, {'capability': 'brightness', 'action': on ? 'on' : 'off'});
    } else {
      apply(d.id, 'onoff', {'kind': 'onoff', 'on': on});
      await client.command(d.id, {'capability': 'onoff', 'action': on ? 'on' : 'off'});
    }
  }

  Future<void> _drag(WidgetRef ref, Device d, double v) async {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final val = (v * 100).round();
    apply(d.id, 'brightness', {'kind': 'brightness', 'on': val > 0, 'level': val});
    await client.command(d.id, {'capability': 'brightness', 'action': 'set', 'level': val});
  }

  Future<bool> _confirmRemove(Device d) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove device?'),
        content: Text('Remove "${d.name}"? This can\'t be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _remove(Device d) async {
    try {
      await ref.read(clientProvider).deleteDevice(d.id);
      if (!mounted) return;
      setState(() => _lights.removeWhere((x) => x.id == d.id));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not remove ${d.name}: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final live = ref.watch(liveStatesProvider);

    final onCount = _lights.where((d) => _onOf(d, live)).length;
    // The master switch reflects "is anything on" (matches the "N of M on" convention used
    // elsewhere), not "is everything on" — a single light left on should still read as the
    // room being on. The tap action follows the same rule: off from any/all-on, on from none.
    final anyOn = onCount > 0;
    final rgbLights = _lights.where((d) => colorModesOf(_colorOf(d, live)).rgb).toList();
    final cctLights = _lights.where((d) => colorModesOf(_colorOf(d, live)).cct).toList();
    final rgbAnchor = rgbLights.isNotEmpty ? _colorOf(rgbLights.first, live) : null;
    final cctAnchor = cctLights.isNotEmpty ? _colorOf(cctLights.first, live) : null;

    return Scaffold(
      appBar: AppBar(title: const Text('Lighting')),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          if (_lights.isNotEmpty)
            GestureDetector(
              onTap: () => _setAll(ref, !anyOn),
              child: Container(
                padding: const EdgeInsets.all(AureonSpacing.lg),
                decoration: BoxDecoration(
                  color: Theme.of(context).cardTheme.color ?? scheme.surface,
                  borderRadius: BorderRadius.circular(AureonRadius.lg),
                  border: Border.all(color: anyOn ? scheme.primary.withValues(alpha: 0.55) : scheme.outlineVariant.withValues(alpha: 0.4)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.wb_sunny_outlined, size: 26, color: scheme.primary),
                    const SizedBox(width: AureonSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('All lights', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
                          Text('$onCount of ${_lights.length} on', style: Theme.of(context).textTheme.labelMedium),
                        ],
                      ),
                    ),
                    Switch(value: anyOn, onChanged: (v) => _setAll(ref, v)),
                  ],
                ),
              ),
            ),
          if (cctLights.isNotEmpty || rgbLights.isNotEmpty) ...[
            const SizedBox(height: AureonSpacing.xl),
            if (cctLights.isNotEmpty) ...[
              Text('Room colour temperature', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: AureonSpacing.sm),
              TemperatureSlider(
                kelvin: ((cctAnchor?['kelvin'] as num?) ?? 2700).toDouble(),
                onChanged: (k) => _setGroupKelvin(ref, cctLights, k),
              ),
              const SizedBox(height: AureonSpacing.xl),
            ],
            if (rgbLights.isNotEmpty) ...[
              Text('Room colour', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: AureonSpacing.sm),
              Center(
                child: ColorWheel(
                  hue: ((rgbAnchor?['hue'] as num?) ?? 40).toDouble(),
                  saturation: (((rgbAnchor?['saturation'] as num?) ?? 60).toDouble()) / 100.0,
                  onChanged: (h, s) => _setGroupColour(ref, rgbLights, h, s),
                ),
              ),
            ],
          ],
          const SizedBox(height: AureonSpacing.xl),
          for (final d in _lights)
            Padding(
              padding: const EdgeInsets.only(bottom: AureonSpacing.md),
              child: Builder(builder: (_) {
                final spec = tileSpec(d, mergedDeviceState(d, live));
                return Row(children: [
                  Expanded(
                    child: DeviceControlTile(
                      icon: spec.icon,
                      name: d.name,
                      valueLabel: spec.value,
                      fill: spec.fill,
                      on: spec.on,
                      slidable: true,
                      onChanged: (v) => _drag(ref, d, v),
                      onToggle: () => _toggle(ref, d, !spec.on),
                      onOpenDetail: () async {
                        ref.read(usageProvider.notifier).record('device', d.id);
                        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => LightingDetail(device: d)));
                      },
                    ),
                  ),
                  const SizedBox(width: AureonSpacing.sm),
                  IconButton(
                    onPressed: () async { if (await _confirmRemove(d)) await _remove(d); },
                    icon: const Icon(Icons.delete_outline),
                    color: Theme.of(context).colorScheme.error,
                    tooltip: 'Remove ${d.name}',
                  ),
                ]);
              }),
            ),
        ],
      ),
    );
  }
}
