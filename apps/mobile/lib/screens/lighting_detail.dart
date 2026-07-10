import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../color_mode.dart';
import '../providers.dart';

/// Purpose-built lighting control (§11.1): a large brightness dial, an HSV colour wheel,
/// and a warm→cool temperature slider — shown per the light's capabilities. Drives the
/// Supreme `brightness` + `color` commands; HA is never in view.
///
/// Live-fed: every value reads through [liveStatesProvider], so a change made elsewhere
/// (another screen, a physical switch, Casambi's own app) shows up here immediately — and every
/// local drag writes optimistically into the SAME live state via `apply`, so the two never diverge.
class LightingDetail extends ConsumerStatefulWidget {
  const LightingDetail({super.key, required this.device});

  final Device device;

  @override
  ConsumerState<LightingDetail> createState() => _LightingDetailState();
}

enum _Mode { colour, white }

class _LightingDetailState extends ConsumerState<LightingDetail> {
  _Mode? _modeOverride;

  bool get _hasColour => widget.device.capabilities.contains('color');

  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final live = ref.watch(liveStatesProvider);
    final merged = mergedDeviceState(widget.device, live);
    final apply = ref.read(liveStatesProvider.notifier).apply;

    final brightness = merged['brightness'] as Map<String, dynamic>?;
    final onoff = merged['onoff'] as Map<String, dynamic>?;
    final color = merged['color'] as Map<String, dynamic>?;
    final on = (brightness?['on'] as bool?) ?? (onoff?['on'] as bool?) ?? (color?['on'] as bool?) ?? false;
    final level = ((brightness?['level'] as num?) ?? (color?['level'] as num?) ?? (on ? 100 : 0)).toDouble() / 100.0;
    final hue = ((color?['hue'] as num?) ?? 40).toDouble();
    final sat = ((color?['saturation'] as num?) ?? 60).toDouble() / 100.0;
    final kelvin = ((color?['kelvin'] as num?) ?? 2700).toDouble();
    final modes = colorModesOf(color);
    final mode = _modeOverride ?? (!modes.rgb && modes.cct ? _Mode.white : _Mode.colour);

    void setLevel(double v) {
      final val = v.clamp(0.0, 1.0);
      apply(widget.device.id, 'brightness', {'kind': 'brightness', 'on': val > 0, 'level': (val * 100).round()});
      _cmd({'capability': 'brightness', 'action': 'set', 'level': (val * 100).round()});
    }

    void setColour(double h, double s) {
      apply(widget.device.id, 'color', {'kind': 'color', 'on': true, 'level': level * 100, 'hue': h.round(), 'saturation': (s * 100).round(), 'kelvin': null});
      _cmd({'capability': 'color', 'hue': h.round(), 'saturation': (s * 100).round()});
    }

    void setKelvin(double k) {
      final kr = k.round();
      apply(widget.device.id, 'color', {'kind': 'color', 'on': true, 'level': level * 100, 'hue': null, 'saturation': null, 'kelvin': kr});
      _cmd({'capability': 'color', 'kelvin': kr});
    }

    void toggle(bool v) {
      final hasBrightness = widget.device.capabilities.contains('brightness');
      // 100 is a far more plausible guess than 1 for an unknown/zero cached level; a known
      // level (the light was last dimmed to some real value) is preserved as-is.
      final known = level * 100;
      final lvl = v ? (known > 0 ? known : 100.0) : 0.0;
      apply(widget.device.id, hasBrightness ? 'brightness' : 'onoff',
          hasBrightness ? {'kind': 'brightness', 'on': v, 'level': lvl} : {'kind': 'onoff', 'on': v});
      _cmd({'capability': hasBrightness ? 'brightness' : 'onoff', 'action': v ? 'on' : 'off'});
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.device.name),
        actions: [Switch(value: on, onChanged: toggle)],
      ),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          // Brightness dial — a tall bar that fills bottom-up; drag to set.
          Center(
            child: _BrightnessBar(value: level, onChanged: setLevel),
          ),
          const SizedBox(height: AureonSpacing.sm),
          Center(child: Text('${(level * 100).round()}%', style: text.headlineSmall)),
          const SizedBox(height: AureonSpacing.xl),

          if (_hasColour && modes.rgb && modes.cct) ...[
            Center(
              child: SegmentedButton<_Mode>(
                segments: const [
                  ButtonSegment(value: _Mode.colour, label: Text('Colour'), icon: Icon(Icons.palette_outlined)),
                  ButtonSegment(value: _Mode.white, label: Text('White'), icon: Icon(Icons.wb_sunny_outlined)),
                ],
                selected: {mode},
                onSelectionChanged: (s) => setState(() => _modeOverride = s.first),
                showSelectedIcon: false,
              ),
            ),
            const SizedBox(height: AureonSpacing.xl),
          ],
          if (_hasColour && modes.rgb && mode == _Mode.colour)
            Center(child: ColorWheel(hue: hue, saturation: sat, onChanged: setColour))
          else if (_hasColour && modes.cct && mode == _Mode.white)
            TemperatureSlider(kelvin: kelvin, onChanged: setKelvin),
        ],
      ),
    );
  }
}

/// Vertical brightness bar — fills bottom-up; drag to set.
class _BrightnessBar extends StatelessWidget {
  const _BrightnessBar({required this.value, required this.onChanged});
  final double value;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    const h = 260.0, w = 120.0;
    void setFromDy(double dy) => onChanged((1 - (dy / h)).clamp(0.0, 1.0));
    return GestureDetector(
      onVerticalDragUpdate: (d) => setFromDy(d.localPosition.dy),
      onTapDown: (d) => setFromDy(d.localPosition.dy),
      child: Container(
        height: h,
        width: w,
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(AureonRadius.lg),
          border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Align(
          alignment: Alignment.bottomCenter,
          child: AnimatedContainer(
            duration: AureonMotion.fast,
            height: h * value.clamp(0.0, 1.0),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [scheme.primary, scheme.primary.withValues(alpha: 0.7)],
              ),
            ),
            child: const Align(
              alignment: Alignment.topCenter,
              child: Padding(
                padding: EdgeInsets.only(top: 12),
                child: Icon(Icons.light_mode, color: Colors.black54, size: 22),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
