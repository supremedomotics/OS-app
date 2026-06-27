import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// Ovio device-detail BOTTOM SHEETS (§11.1) — capability-routed controls (climate dual
/// setpoint, cover up/stop/down, lock unlatch/unlock, fan presets, vacuum, switch, media)
/// presented as a modal sheet over the dimmed room. Mirrors the web experience.
Future<void> showDeviceSheet(BuildContext context, Device device) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => DeviceSheet(device: device),
  );
}

class DeviceSheet extends ConsumerStatefulWidget {
  const DeviceSheet({super.key, required this.device});
  final Device device;

  @override
  ConsumerState<DeviceSheet> createState() => _DeviceSheetState();
}

class _DeviceSheetState extends ConsumerState<DeviceSheet> {
  Map<String, dynamic> _s(String k) => (widget.device.state[k] as Map<String, dynamic>?) ?? {};
  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);

  @override
  Widget build(BuildContext context) {
    final caps = widget.device.capabilities;
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
      ),
      padding: EdgeInsets.fromLTRB(22, 12, 22, 28 + MediaQuery.of(context).padding.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 44, height: 5, margin: const EdgeInsets.only(bottom: 18), decoration: BoxDecoration(color: scheme.outlineVariant, borderRadius: BorderRadius.circular(3))),
          if (caps.contains('temperature')) ..._climate()
          else if (caps.contains('position')) ..._cover()
          else if (caps.contains('lock')) ..._lock()
          else if (caps.contains('fan')) ..._fan()
          else if (caps.contains('vacuum')) ..._vacuum()
          else if (caps.contains('media')) ..._media()
          else ..._switch(),
        ],
      ),
    );
  }

  Widget _title(String name, String status) => Padding(
        padding: const EdgeInsets.only(bottom: 24),
        child: Column(children: [
          Text(name, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 4),
          Text(status, style: Theme.of(context).textTheme.labelMedium),
        ]),
      );

  // ── Climate ──
  List<Widget> _climate() {
    final t = _s('temperature');
    final ambient = ((t['ambientC'] as num?) ?? 20).toDouble();
    double low = ((t['targetLowC'] as num?) ?? ((t['targetC'] as num?)?.toDouble() ?? 21) - 1).toDouble();
    double high = ((t['targetHighC'] as num?) ?? ((t['targetC'] as num?)?.toDouble() ?? 21) + 2).toDouble();
    String mode = (t['mode'] as String?) ?? 'auto';
    return [
      StatefulBuilder(builder: (context, set) {
        void send() => _cmd({'capability': 'temperature', 'targetLowC': low, 'targetHighC': high});
        return Column(children: [
          _title(widget.device.name, '${ambient.toStringAsFixed(1)}° Inside'),
          Row(children: [
            Expanded(child: _stepper(low, (v) { set(() => low = v); send(); })),
            const SizedBox(width: 14),
            Expanded(child: _stepper(high, (v) { set(() => high = v); send(); })),
          ]),
          const SizedBox(height: 18),
          Row(children: [
            for (final m in const [['heat', Icons.local_fire_department], ['cool', Icons.ac_unit], ['fan_only', Icons.air], ['auto', Icons.settings], ['off', Icons.power_settings_new]])
              Expanded(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: _modeBtn(m[0] as String, m[1] as IconData, mode, (v) { set(() => mode = v); _cmd({'capability': 'temperature', 'mode': v}); }))),
          ]),
        ]);
      }),
    ];
  }

  Widget _stepper(double value, ValueChanged<double> onChange) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(18)),
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        IconButton(onPressed: () => onChange((value - 0.5)), icon: const Icon(Icons.remove)),
        Text('${value.toStringAsFixed(1)}°', style: Theme.of(context).textTheme.headlineSmall),
        IconButton(onPressed: () => onChange((value + 0.5)), icon: const Icon(Icons.add)),
      ]),
    );
  }

  Widget _modeBtn(String m, IconData icon, String current, ValueChanged<String> onTap) {
    final scheme = Theme.of(context).colorScheme;
    final on = current == m;
    return GestureDetector(
      onTap: () => onTap(m),
      child: Container(
        height: 60,
        decoration: BoxDecoration(color: on ? scheme.primary : scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(16)),
        child: Icon(icon, color: on ? scheme.onPrimary : scheme.onSurface),
      ),
    );
  }

  // ── Cover ──
  List<Widget> _cover() {
    final pos = ((_s('position')['position'] as num?) ?? 0).toDouble();
    return [
      _title(widget.device.name, '${pos.round()}% open'),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        for (final a in const [['open', Icons.keyboard_arrow_up], ['stop', Icons.height], ['close', Icons.keyboard_arrow_down]])
          Padding(padding: const EdgeInsets.symmetric(horizontal: 7), child: _bigBtn(a[1] as IconData, () => _cmd({'capability': 'position', 'action': a[0]}))),
      ]),
      const SizedBox(height: 18),
      StatefulBuilder(builder: (context, set) {
        double p = pos;
        return Slider(value: p.clamp(0, 100), max: 100, onChanged: (v) { set(() => p = v); }, onChangeEnd: (v) => _cmd({'capability': 'position', 'action': 'set', 'position': v.round()}));
      }),
    ];
  }

  // ── Lock ──
  List<Widget> _lock() {
    bool locked = (_s('lock')['locked'] as bool?) ?? true;
    return [
      StatefulBuilder(builder: (context, set) {
        return Column(children: [
          _title(widget.device.name, locked ? 'Locked' : 'Unlocked'),
          SizedBox(width: double.infinity, child: OutlinedButton(onPressed: () { set(() => locked = false); _cmd({'capability': 'lock', 'action': 'unlock'}); }, style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(60)), child: const Text('Unlatch'))),
          const SizedBox(height: 14),
          SlideToConfirm(label: locked ? 'Slide to unlock' : 'Unlocked', icon: locked ? Icons.lock_open : Icons.lock, onConfirmed: () { set(() => locked = false); _cmd({'capability': 'lock', 'action': 'unlock'}); }),
        ]);
      }),
    ];
  }

  // ── Fan ──
  List<Widget> _fan() {
    final f = _s('fan');
    bool on = (f['on'] as bool?) ?? true;
    String preset = (f['preset'] as String?) ?? 'auto';
    return [
      StatefulBuilder(builder: (context, set) {
        return Column(children: [
          _title(widget.device.name, on ? 'On' : 'Off'),
          _presetRow(const ['auto', 'sleep', 'turbo'], preset, (p) { set(() => preset = p); _cmd({'capability': 'fan', 'action': 'preset', 'preset': p}); }),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(child: _bigBtn(Icons.rotate_right, () => _cmd({'capability': 'fan', 'action': 'direction', 'direction': 'reverse'}))),
            const SizedBox(width: 12),
            Expanded(child: _bigBtn(Icons.power_settings_new, () { set(() => on = !on); _cmd({'capability': 'fan', 'action': on ? 'on' : 'off'}); })),
          ]),
        ]);
      }),
    ];
  }

  // ── Vacuum ──
  List<Widget> _vacuum() {
    final v = _s('vacuum');
    String status = (v['status'] as String?) ?? 'idle';
    String speed = (v['fanSpeed'] as String?) ?? 'normal';
    return [
      StatefulBuilder(builder: (context, set) {
        return Column(children: [
          _title(widget.device.name, status[0].toUpperCase() + status.substring(1)),
          _presetRow(const ['quiet', 'normal', 'turbo'], speed, (s) { set(() => speed = s); _cmd({'capability': 'vacuum', 'action': 'fan', 'fanSpeed': s}); }),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(child: _bigBtn(Icons.pause, () { set(() => status = 'paused'); _cmd({'capability': 'vacuum', 'action': 'pause'}); })),
            const SizedBox(width: 12),
            Expanded(child: _bigBtn(Icons.stop, () { set(() => status = 'idle'); _cmd({'capability': 'vacuum', 'action': 'stop'}); })),
          ]),
        ]);
      }),
    ];
  }

  // ── Switch ──
  List<Widget> _switch() {
    bool on = (_s('onoff')['on'] as bool?) ?? false;
    return [
      StatefulBuilder(builder: (context, set) {
        return Column(children: [
          _title(widget.device.name, on ? 'On' : 'Off'),
          SizedBox(width: double.infinity, child: FilledButton(onPressed: () { set(() => on = !on); _cmd({'capability': 'onoff', 'action': on ? 'on' : 'off'}); }, style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(60)), child: Text(on ? 'Turn off' : 'Turn on'))),
        ]);
      }),
    ];
  }

  // ── Media ──
  static const _sources = ['Arc', 'One Left', 'One Right', 'Sub', 'Era 300', 'Sonance Left', 'Sonance Right'];

  List<Widget> _media() {
    final m = _s('media');
    bool playing = (m['playback'] as String?) == 'playing';
    double vol = ((m['volume'] as num?) ?? 30).toDouble();
    final title = m['title'] as String?;
    String? source = m['source'] as String?;
    bool picker = false;
    final scheme = Theme.of(context).colorScheme;
    return [
      StatefulBuilder(builder: (context, set) {
        if (picker) {
          return Column(mainAxisSize: MainAxisSize.min, children: [
            _title('Home', 'Choose outputs'),
            for (final src in _sources)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Container(width: 48, height: 48, decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(12))),
                title: Text(src, style: const TextStyle(fontWeight: FontWeight.w600)),
                trailing: Icon(source == src ? Icons.radio_button_checked : Icons.radio_button_unchecked),
                onTap: () { set(() { source = src; picker = false; }); _cmd({'capability': 'media', 'action': 'source', 'source': src}); },
              ),
          ]);
        }
        return Column(children: [
          Row(children: [
            Expanded(child: _title(widget.device.name, title ?? source ?? 'Idle')),
          ]),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(onPressed: () => set(() => picker = true), icon: const Icon(Icons.speaker_outlined, size: 18), label: Text(source ?? 'Speakers')),
          ),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            IconButton(iconSize: 34, onPressed: () => _cmd({'capability': 'media', 'action': 'previous'}), icon: const Icon(Icons.skip_previous)),
            const SizedBox(width: 16),
            _bigBtn(playing ? Icons.pause : Icons.play_arrow, () { set(() => playing = !playing); _cmd({'capability': 'media', 'action': playing ? 'play' : 'pause'}); }),
            const SizedBox(width: 16),
            IconButton(iconSize: 34, onPressed: () => _cmd({'capability': 'media', 'action': 'next'}), icon: const Icon(Icons.skip_next)),
          ]),
          Slider(value: vol.clamp(0, 100), max: 100, onChanged: (v) { set(() => vol = v); }, onChangeEnd: (v) => _cmd({'capability': 'media', 'action': 'volume', 'volume': v.round()})),
        ]);
      }),
    ];
  }

  Widget _presetRow(List<String> opts, String current, ValueChanged<String> onTap) {
    final scheme = Theme.of(context).colorScheme;
    return Row(children: [
      for (final p in opts)
        Expanded(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: GestureDetector(
          onTap: () => onTap(p),
          child: Container(
            height: 58, alignment: Alignment.center,
            decoration: BoxDecoration(color: current == p ? scheme.primary : scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(16)),
            child: Text(p[0].toUpperCase() + p.substring(1), style: TextStyle(fontWeight: FontWeight.w600, color: current == p ? scheme.onPrimary : scheme.onSurface)),
          ),
        ))),
    ]);
  }

  Widget _bigBtn(IconData icon, VoidCallback onTap) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: onTap,
      child: Container(height: 64, alignment: Alignment.center, decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(16)), child: Icon(icon, size: 26)),
    );
  }
}
