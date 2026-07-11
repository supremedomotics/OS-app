import 'dart:math' as math;

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import 'avr_console.dart' show AvrCard;

/// The HVAC/Climate console (§ HVAC Detail Page) — the shared, capability-driven
/// widget library for any `temperature` device whose capability config is genuinely
/// driver-reported (ClimateCapabilityConfig, from CoolMasterProtocolDriver today).
/// Mirrors avr_console.dart's exact visual language (reuses AvrCard directly) and
/// architecture (a ConsumerStatefulWidget body + compact/wide layouts driving the phone
/// sheet and tablet screen from the SAME widget tree) so the two consoles feel like one
/// app. The driver is the ONLY source of truth: modes/fan speeds/swing positions come
/// entirely from Device.climateModes/climateFanSpeeds/climateSwingPositions — nothing
/// here is hardcoded per brand, and Swing simply doesn't render when a unit reports none.
///
/// Deliberately excluded because the driver cannot actually command it: "Dry" mode
/// (Supreme's shared temperature command has no dry value to send). Deliberately
/// excluded because they're not driver-backed at all: humidity, air quality, energy
/// usage, running cost, Wi-Fi signal, compressor status.

const _minC = 16.0;
const _maxC = 30.0;
const _stepC = 0.5;

IconData climateModeIcon(String mode) {
  switch (mode) {
    case 'heat':
      return Icons.local_fire_department;
    case 'cool':
      return Icons.ac_unit;
    case 'auto':
      return Icons.autorenew;
    case 'fan_only':
      return Icons.air;
    default:
      return Icons.thermostat;
  }
}

String climateModeLabel(String mode) {
  switch (mode) {
    case 'heat':
      return 'Heat';
    case 'cool':
      return 'Cool';
    case 'auto':
      return 'Auto';
    case 'fan_only':
      return 'Fan';
    default:
      return mode;
  }
}

IconData fanSpeedIcon(String speed) => speed.toLowerCase() == 'auto' ? Icons.autorenew : Icons.air;

IconData swingIcon(String position) {
  switch (position.toLowerCase()) {
    case 'up':
      return Icons.arrow_upward;
    case 'down':
      return Icons.arrow_downward;
    case 'left':
      return Icons.arrow_back;
    case 'right':
      return Icons.arrow_forward;
    default:
      return Icons.swap_vert;
  }
}

double clampTempStep(double v) => (v.clamp(_minC, _maxC) / _stepC).round() * _stepC;

/// A generic hardware-style button row — reused for Mode / Fan Speed / Swing so the
/// three fields share one implementation instead of three near-duplicates.
class ClimateHwRow extends StatelessWidget {
  const ClimateHwRow({super.key, required this.label, required this.items, required this.active, required this.onSelect});
  final String label;
  final List<({String id, String display, IconData icon})> items;
  final String? active;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label.toUpperCase(), style: const TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final it in items)
          Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.sm + 2),
              onTap: () { HapticFeedback.selectionClick(); onSelect(it.id); },
              child: AnimatedContainer(
                duration: AureonMotion.base,
                width: 78,
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.sm + 2),
                  gradient: active == it.id
                      ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500])
                      : LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color.lerp(AureonBase.surface, Colors.white, 0.03)!, AureonBase.surface]),
                  border: Border.all(color: active == it.id ? Colors.transparent : AureonBase.hairline),
                  boxShadow: active == it.id
                      ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 5))]
                      : [BoxShadow(color: Colors.white.withValues(alpha: 0.04), blurRadius: 0, spreadRadius: 0.5), const BoxShadow(color: Colors.black26, blurRadius: 3, offset: Offset(0, 1))],
                ),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(it.icon, size: 18, color: active == it.id ? AureonText.inverse : AureonText.primary),
                  const SizedBox(height: 4),
                  Text(it.display.toUpperCase(), textAlign: TextAlign.center, style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w700, letterSpacing: 0.2, color: active == it.id ? AureonText.inverse : AureonText.primary)),
                ]),
              ),
            ),
          ),
      ]),
    ]);
  }
}

class _ClimateDialPainter extends CustomPainter {
  _ClimateDialPainter(this.pct);
  final double pct;
  static const _tickCount = 48;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final tickRadius = size.width / 2 - 6;
    final lit = (pct.clamp(0, 1) * _tickCount).round();
    for (var i = 0; i < _tickCount; i++) {
      final angle = (i / _tickCount) * 2 * math.pi - math.pi / 2;
      final major = i % 4 == 0;
      final len = major ? 11.0 : 8.0;
      final on = i < lit;
      final p1 = center + Offset(math.cos(angle), math.sin(angle)) * (tickRadius - len);
      final p2 = center + Offset(math.cos(angle), math.sin(angle)) * tickRadius;
      final paint = Paint()
        ..color = on ? AureonGold.c400 : AureonBase.hairline
        ..strokeWidth = major ? 2.5 : 2
        ..strokeCap = StrokeCap.round;
      if (on) paint.maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.2);
      canvas.drawLine(p1, p2, paint);
    }
    final arcRadius = tickRadius - 20;
    final track = Paint()..color = AureonBase.hairline.withValues(alpha: 0.7)..style = PaintingStyle.stroke..strokeWidth = 3;
    canvas.drawCircle(center, arcRadius, track);
    final fill = Paint()
      ..color = AureonGold.c400
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.0);
    canvas.drawArc(Rect.fromCircle(center: center, radius: arcRadius), -math.pi / 2, 2 * math.pi * pct.clamp(0, 1), false, fill);

    final faceRadius = arcRadius - 14;
    final brush = Paint()..color = Colors.white.withValues(alpha: 0.025)..strokeWidth = 1;
    for (var i = 0; i < 120; i++) {
      final angle = (i / 120) * 2 * math.pi;
      final p1 = center + Offset(math.cos(angle), math.sin(angle)) * (faceRadius * 0.15);
      final p2 = center + Offset(math.cos(angle), math.sin(angle)) * faceRadius;
      canvas.drawLine(p1, p2, brush);
    }
  }

  @override
  bool shouldRepaint(covariant _ClimateDialPainter old) => old.pct != pct;
}

/// The large hero circular gauge (§ "large premium circular temperature dial as the
/// hero control") — same brushed-metal/tick-mark/reactive-glow mechanics as
/// AvrVolumeDial, mapped to 16–30°C instead of 0–100 volume.
class ClimateTemperatureDial extends StatefulWidget {
  const ClimateTemperatureDial({super.key, required this.targetC, required this.mode, required this.onChanged, this.size = 208});
  final double targetC;
  final String mode;
  final ValueChanged<double> onChanged;
  final double size;

  @override
  State<ClimateTemperatureDial> createState() => _ClimateTemperatureDialState();
}

class _ClimateTemperatureDialState extends State<ClimateTemperatureDial> {
  bool _pressed = false;
  int _lastTick = -1;
  static const _tickCount = 48;

  void _onChanged(double v) {
    final pct = ((v - _minC) / (_maxC - _minC)).clamp(0, 1);
    final tick = (pct * _tickCount).round();
    if (tick != _lastTick) {
      HapticFeedback.selectionClick();
      _lastTick = tick;
    }
    widget.onChanged(clampTempStep(v));
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    final pct = ((widget.targetC - _minC) / (_maxC - _minC)).clamp(0.0, 1.0);
    return AnimatedScale(
      scale: _pressed ? 0.985 : 1,
      duration: const Duration(milliseconds: 120),
      curve: Curves.easeOut,
      child: SizedBox(
        width: size, height: size,
        child: Stack(alignment: Alignment.center, children: [
          Container(
            width: size - 16, height: size - 16,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                center: const Alignment(0, -0.2),
                colors: [Color.lerp(AureonBase.surfaceRaised, Colors.white, 0.03)!, AureonBase.surface, Color.lerp(AureonBase.voidColor, Colors.black, 0.15)!],
                stops: const [0, 0.6, 1],
              ),
              boxShadow: [
                BoxShadow(color: Colors.black.withValues(alpha: 0.45), blurRadius: 26, offset: const Offset(0, 14)),
                BoxShadow(color: Colors.white.withValues(alpha: 0.04), blurRadius: 0, spreadRadius: 0.5),
                BoxShadow(color: AureonGold.c400.withValues(alpha: 0.05 + pct * 0.22), blurRadius: 14 + pct * 22),
                if (_pressed) BoxShadow(color: AureonGold.c400.withValues(alpha: 0.18), blurRadius: 30, spreadRadius: 2),
              ],
            ),
          ),
          Container(
            width: size - 24, height: size - 24,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(begin: Alignment.topLeft, end: const Alignment(0.2, 0.4), colors: [Colors.white.withValues(alpha: 0.08), Colors.white.withValues(alpha: 0)]),
            ),
          ),
          CustomPaint(size: Size(size, size), painter: _ClimateDialPainter(pct)),
          Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('SET TEMPERATURE', style: TextStyle(fontSize: 10, letterSpacing: 1.4, color: AureonText.secondary)),
            const SizedBox(height: 6),
            Text.rich(TextSpan(children: [
              TextSpan(text: widget.targetC.toStringAsFixed(1), style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w600, color: AureonText.primary, letterSpacing: -0.3)),
              const TextSpan(text: '°C', style: TextStyle(fontSize: 16, color: AureonText.secondary, fontWeight: FontWeight.w500)),
            ])),
            if (widget.mode != 'off') ...[
              const SizedBox(height: 8),
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(climateModeIcon(widget.mode), size: 14, color: AureonGold.c400),
                const SizedBox(width: 4),
                Text(climateModeLabel(widget.mode), style: const TextStyle(fontSize: 12.5, color: AureonGold.c400, fontWeight: FontWeight.w600)),
              ]),
            ],
          ]),
          Positioned.fill(
            child: RotatedBox(
              quarterTurns: 3,
              child: SliderTheme(
                data: SliderTheme.of(context).copyWith(trackHeight: 0, thumbShape: SliderComponentShape.noThumb, overlayShape: SliderComponentShape.noOverlay),
                child: Slider(
                  value: widget.targetC.clamp(_minC, _maxC), min: _minC, max: _maxC,
                  onChangeStart: (_) => setState(() => _pressed = true),
                  onChanged: _onChanged,
                  onChangeEnd: (_) => setState(() => _pressed = false),
                  activeColor: Colors.transparent, inactiveColor: Colors.transparent,
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

typedef ClimatePreset = String; // "comfort" | "eco" | "away"

class ClimateQuickActions extends StatelessWidget {
  const ClimateQuickActions({super.key, required this.active, required this.onPreset, required this.onSchedule});
  final ClimatePreset? active;
  final ValueChanged<ClimatePreset> onPreset;
  final VoidCallback onSchedule;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('QUICK ACTIONS', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      Wrap(spacing: 10, runSpacing: 10, children: [
        _tile(context, icon: Icons.eco_outlined, label: 'Comfort', on: active == 'comfort', onTap: () => onPreset('comfort')),
        _tile(context, icon: Icons.energy_savings_leaf_outlined, label: 'Eco', on: active == 'eco', onTap: () => onPreset('eco')),
        _tile(context, icon: Icons.home_outlined, label: 'Away', on: active == 'away', onTap: () => onPreset('away')),
        _tile(context, icon: Icons.calendar_month_outlined, label: 'Schedule', on: false, onTap: onSchedule),
      ]),
    ]);
  }

  Widget _tile(BuildContext context, {required IconData icon, required String label, required bool on, required VoidCallback onTap}) {
    final width = (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2 > 220 ? 220.0 : (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2;
    return SizedBox(
      width: width,
      child: Material(
        color: AureonBase.surfaceRaised.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        child: InkWell(
          borderRadius: BorderRadius.circular(AureonRadius.lg),
          onTap: () { HapticFeedback.selectionClick(); onTap(); },
          child: Container(
            padding: const EdgeInsets.all(16),
            constraints: const BoxConstraints(minHeight: 88),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              border: Border.all(color: on ? AureonGold.c400.withValues(alpha: 0.55) : Colors.white.withValues(alpha: 0.08)),
              boxShadow: on
                  ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.28), blurRadius: 16, offset: const Offset(0, 6))]
                  : [BoxShadow(color: Colors.black.withValues(alpha: 0.28), blurRadius: 14, offset: const Offset(0, 6))],
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 24, color: on ? AureonGold.c400 : AureonText.primary),
              const SizedBox(height: 8),
              Text(label, style: const TextStyle(fontSize: 12.5)),
            ]),
          ),
        ),
      ),
    );
  }
}

/// AC Unit info card — Brand/Type (installer-entered), Room, Online status only, per the
/// explicit "show only" list. Lock/Inhibit/Filter-reset live behind Advanced Settings.
class ClimateInfoCard extends StatelessWidget {
  const ClimateInfoCard({
    super.key, required this.device, required this.roomName, required this.brand, required this.unitType,
    required this.onEditBrand, required this.onEditType, required this.onOpenAdvanced,
  });
  final Device device;
  final String roomName;
  final String? brand;
  final String? unitType;
  final VoidCallback onEditBrand;
  final VoidCallback onEditType;
  final VoidCallback onOpenAdvanced;

  @override
  Widget build(BuildContext context) {
    final online = device.status == 'online';
    return AvrCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          const Text('AC Unit', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Container(width: 7, height: 7, margin: const EdgeInsets.only(right: 6), decoration: BoxDecoration(shape: BoxShape.circle, color: online ? AureonStatus.good : AureonText.secondary)),
            Text(online ? 'Online' : 'Offline', style: TextStyle(fontSize: 12, color: online ? AureonStatus.good : AureonText.secondary)),
          ]),
        ]),
        const SizedBox(height: 10),
        _row(context, 'Brand', brand ?? 'Not set', onEditBrand),
        _row(context, 'Indoor Unit Type', unitType ?? 'Not set', onEditType),
        _row(context, 'Room', roomName, null),
        const SizedBox(height: 6),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: onOpenAdvanced,
            icon: const Icon(Icons.settings_outlined, size: 16),
            label: const Expanded(child: Align(alignment: Alignment.centerLeft, child: Text('Advanced Settings'))),
            style: OutlinedButton.styleFrom(side: BorderSide(color: AureonBase.hairline), padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12)),
          ),
        ),
      ]),
    );
  }

  Widget _row(BuildContext context, String label, String value, VoidCallback? onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(label, style: const TextStyle(fontSize: 12.5, color: AureonText.secondary)),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Text(value, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
            if (onTap != null) ...[const SizedBox(width: 6), Icon(Icons.edit_outlined, size: 11, color: AureonText.secondary.withValues(alpha: 0.7))],
          ]),
        ]),
      ),
    );
  }
}

/// Lock/Inhibit/Filter-reset — genuinely driver-backed but installer/secondary-facing,
/// surfaced as a modal bottom sheet rather than cluttering the primary page. Each row
/// only renders when this unit's own capability config declares support.
Future<void> showClimateAdvancedSettings(
  BuildContext context, {
  required List<MediaAdvancedControl> controls,
  required Map<String, dynamic> advanced,
  required void Function(String key, dynamic value) onSet,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) => Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.7),
      decoration: BoxDecoration(color: Theme.of(ctx).colorScheme.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(28))),
      padding: EdgeInsets.fromLTRB(22, 12, 22, 24 + MediaQuery.of(ctx).padding.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(child: Container(width: 44, height: 5, margin: const EdgeInsets.only(bottom: 18), decoration: BoxDecoration(color: Theme.of(ctx).colorScheme.outlineVariant, borderRadius: BorderRadius.circular(3)))),
          Text('Advanced Settings', style: Theme.of(ctx).textTheme.titleMedium),
          const SizedBox(height: 12),
          if (controls.isEmpty) Text('This unit reports no advanced controls.', style: TextStyle(color: AureonText.secondary)),
          for (final c in controls)
            if (c.kind == 'toggle')
              StatefulBuilder(builder: (ctx2, setLocal) {
                final on = advanced[c.key] == true;
                return SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(c.label),
                  value: on,
                  activeThumbColor: AureonGold.c400,
                  onChanged: (v) { onSet(c.key, v); setLocal(() {}); },
                );
              })
            else if (c.kind == 'action' && c.key == 'filterReset')
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(c.label),
                trailing: OutlinedButton(onPressed: () => onSet(c.key, true), child: const Text('Reset')),
              ),
        ]),
      ),
    ),
  );
}

enum ClimateConsoleLayout { compact, wide }

class ClimateConsoleBody extends ConsumerStatefulWidget {
  const ClimateConsoleBody({super.key, required this.device, required this.roomName, required this.layout, this.onOpenSchedule});
  final Device device;
  final String roomName;
  final ClimateConsoleLayout layout;
  final VoidCallback? onOpenSchedule;

  @override
  ConsumerState<ClimateConsoleBody> createState() => _ClimateConsoleBodyState();
}

class _ClimateConsoleBodyState extends ConsumerState<ClimateConsoleBody> {
  ClimatePreset? _activePreset;

  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);
  void _apply(String capability, Map<String, dynamic> value) => ref.read(liveStatesProvider.notifier).apply(widget.device.id, capability, value);

  void _setTarget(double v) {
    setState(() => _activePreset = null);
    final live = ref.read(liveStatesProvider);
    final merged = mergedDeviceState(widget.device, live);
    final t = (merged['temperature'] as Map<String, dynamic>?) ?? const {};
    _apply('temperature', {...t, 'targetC': v});
    _cmd({'capability': 'temperature', 'targetC': v});
  }

  void _setMode(String mode) {
    HapticFeedback.selectionClick();
    setState(() => _activePreset = null);
    final live = ref.read(liveStatesProvider);
    final merged = mergedDeviceState(widget.device, live);
    final t = (merged['temperature'] as Map<String, dynamic>?) ?? const {};
    _apply('temperature', {...t, 'mode': mode});
    _cmd({'capability': 'temperature', 'mode': mode});
  }

  void _setAdvanced(String key, dynamic value) {
    HapticFeedback.selectionClick();
    final live = ref.read(liveStatesProvider);
    final merged = mergedDeviceState(widget.device, live);
    final t = (merged['temperature'] as Map<String, dynamic>?) ?? const {};
    final advanced = {...((t['advanced'] as Map<String, dynamic>?) ?? const {}), key: value};
    _apply('temperature', {...t, 'advanced': advanced});
    _cmd({'capability': 'temperature', 'advanced': {key: value}});
  }

  void _setPower(bool on) {
    HapticFeedback.lightImpact();
    _apply('onoff', {'kind': 'onoff', 'on': on});
    _cmd({'capability': 'onoff', 'action': on ? 'on' : 'off'});
  }

  void _applyPreset(ClimatePreset preset, List<String> modes, String currentMode) {
    setState(() => _activePreset = preset);
    if (preset == 'comfort') {
      _setPower(true);
      final m = modes.contains('auto') ? 'auto' : (modes.isNotEmpty ? modes.first : 'auto');
      final live = ref.read(liveStatesProvider);
      final merged = mergedDeviceState(widget.device, live);
      final t = (merged['temperature'] as Map<String, dynamic>?) ?? const {};
      _apply('temperature', {...t, 'mode': m, 'targetC': 22});
      _cmd({'capability': 'temperature', 'mode': m, 'targetC': 22});
    } else if (preset == 'eco') {
      _setPower(true);
      _setTarget(currentMode == 'heat' ? 19 : 26);
    } else if (preset == 'away') {
      _setTarget(currentMode == 'heat' ? 16 : 28);
    }
  }

  Future<void> _editMeta(String field, String label) async {
    final hvac = (widget.device.metadata['hvac'] as Map<String, dynamic>?) ?? const {};
    final ctrl = TextEditingController(text: hvac[field] as String? ?? '');
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(label),
        content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(hintText: 'Installer-entered, not read from the driver')),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (result == null) return;
    await ref.read(clientProvider).updateDevice(widget.device.id, metadata: {'hvac': {...hvac, field: result.isEmpty ? null : result}});
    ref.invalidate(homeProvider);
    ref.invalidate(allDevicesProvider);
  }

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(liveStatesProvider);
    final merged = mergedDeviceState(widget.device, live);
    final onoff = (merged['onoff'] as Map<String, dynamic>?);
    final powerOn = onoff?['on'] == true;
    final t = (merged['temperature'] as Map<String, dynamic>?) ?? const {};
    final ambientC = ((t['ambientC'] as num?) ?? 21).toDouble();
    final targetC = ((t['targetC'] as num?) ?? ambientC).toDouble();
    final mode = (t['mode'] as String?) ?? 'off';
    final advanced = (t['advanced'] as Map<String, dynamic>?) ?? const {};
    final hasPower = widget.device.capabilities.contains('onoff');

    final modes = widget.device.climateModes;
    final fanSpeeds = widget.device.climateFanSpeeds;
    final swingPositions = widget.device.climateSwingPositions;
    final advancedControls = widget.device.climateAdvancedControls.where((c) {
      if (c.key == 'fanSpeed' || c.key == 'swing') return false;
      return true;
    }).toList();

    final hvac = (widget.device.metadata['hvac'] as Map<String, dynamic>?) ?? const {};

    final hero = AvrCard(
      child: Column(children: [
        ClimateTemperatureDial(targetC: targetC, mode: mode, onChanged: _setTarget),
        const SizedBox(height: 8),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          IconButton.outlined(onPressed: () => _setTarget(clampTempStep(targetC - _stepC)), icon: const Icon(Icons.remove)),
          const SizedBox(width: 24),
          IconButton.outlined(onPressed: () => _setTarget(clampTempStep(targetC + _stepC)), icon: const Icon(Icons.add)),
        ]),
        const SizedBox(height: 16),
        if (hasPower)
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => _setPower(!powerOn),
              icon: const Icon(Icons.power_settings_new, size: 18),
              label: Text('Power ${powerOn ? 'ON' : 'OFF'}'),
              style: FilledButton.styleFrom(
                backgroundColor: powerOn ? AureonGold.c400 : AureonBase.surface,
                foregroundColor: powerOn ? AureonText.inverse : AureonText.primary,
                minimumSize: const Size.fromHeight(48),
              ),
            ),
          ),
        const SizedBox(height: 14),
        Divider(color: AureonBase.hairline),
        const SizedBox(height: 10),
        Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          Row(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.thermostat, size: 14, color: AureonText.secondary),
            const SizedBox(width: 6),
            Text('Room  ${ambientC.toStringAsFixed(1)}°C', style: const TextStyle(fontSize: 12.5, color: AureonText.secondary)),
          ]),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.circle, size: 8, color: widget.device.status == 'online' ? AureonStatus.good : AureonText.secondary),
            const SizedBox(width: 6),
            Text(widget.device.status == 'online' ? 'Online' : 'Offline', style: TextStyle(fontSize: 12.5, color: widget.device.status == 'online' ? AureonStatus.good : AureonText.secondary)),
          ]),
        ]),
      ]),
    );

    final fields = AvrCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ClimateHwRow(
          label: 'Mode',
          items: [for (final m in modes) (id: m, display: climateModeLabel(m), icon: climateModeIcon(m))],
          active: mode,
          onSelect: _setMode,
        ),
        if (fanSpeeds.isNotEmpty) const SizedBox(height: 18),
        ClimateHwRow(
          label: 'Fan Speed',
          items: [for (final s in fanSpeeds) (id: s, display: s, icon: fanSpeedIcon(s))],
          active: advanced['fanSpeed'] as String?,
          onSelect: (v) => _setAdvanced('fanSpeed', v),
        ),
        if (swingPositions.isNotEmpty) const SizedBox(height: 18),
        ClimateHwRow(
          label: 'Swing',
          items: [for (final p in swingPositions) (id: p, display: p, icon: swingIcon(p))],
          active: advanced['swing'] as String?,
          onSelect: (v) => _setAdvanced('swing', v),
        ),
        const SizedBox(height: 18),
        ClimateQuickActions(
          active: _activePreset,
          onPreset: (p) => _applyPreset(p, modes, mode),
          onSchedule: () => widget.onOpenSchedule?.call(),
        ),
      ]),
    );

    final info = ClimateInfoCard(
      device: widget.device, roomName: widget.roomName,
      brand: hvac['brand'] as String?, unitType: hvac['unitType'] as String?,
      onEditBrand: () => _editMeta('brand', 'Brand'),
      onEditType: () => _editMeta('unitType', 'Indoor Unit Type'),
      onOpenAdvanced: () => showClimateAdvancedSettings(context, controls: advancedControls, advanced: advanced, onSet: _setAdvanced),
    );

    if (widget.layout == ClimateConsoleLayout.wide) {
      return Padding(
        padding: const EdgeInsets.all(AureonSpacing.md),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(flex: 5, child: hero),
          const SizedBox(width: AureonSpacing.md),
          Expanded(flex: 5, child: fields),
          const SizedBox(width: AureonSpacing.md),
          Expanded(flex: 4, child: info),
        ]),
      );
    }
    return Padding(
      padding: const EdgeInsets.all(AureonSpacing.md),
      child: Column(children: [
        hero,
        const SizedBox(height: AureonSpacing.md),
        fields,
        const SizedBox(height: AureonSpacing.md),
        info,
      ]),
    );
  }
}
