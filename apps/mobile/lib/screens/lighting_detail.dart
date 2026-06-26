import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// Purpose-built lighting control (§11.1): a large brightness dial, an HSV colour wheel,
/// and a warm→cool temperature slider — shown per the light's capabilities. Drives the
/// Supreme `brightness` + `color` commands; HA is never in view.
class LightingDetail extends ConsumerStatefulWidget {
  const LightingDetail({super.key, required this.device});

  final Device device;

  @override
  ConsumerState<LightingDetail> createState() => _LightingDetailState();
}

enum _Mode { colour, white }

class _LightingDetailState extends ConsumerState<LightingDetail> {
  late bool _on = widget.device.isOn;
  late double _level = widget.device.brightnessFraction; // 0..1
  double _hue = 40;
  double _sat = 0.6;
  double _kelvin = 2700;
  _Mode _mode = _Mode.colour;

  bool get _hasColour => widget.device.capabilities.contains('color');

  @override
  void initState() {
    super.initState();
    final c = widget.device.state['color'] as Map<String, dynamic>?;
    if (c != null) {
      _hue = ((c['hue'] as num?) ?? _hue).toDouble();
      _sat = ((c['saturation'] as num?) ?? (_sat * 100)).toDouble() / 100.0;
      _kelvin = ((c['kelvin'] as num?) ?? _kelvin).toDouble();
      if ((c['kelvin'] != null) && c['hue'] == null) _mode = _Mode.white;
    }
  }

  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);

  void _setLevel(double v) {
    setState(() {
      _level = v.clamp(0.0, 1.0);
      _on = _level > 0;
    });
    _cmd({'capability': 'brightness', 'action': 'set', 'level': (_level * 100).round()});
  }

  void _setColour(double hue, double sat) {
    setState(() {
      _hue = hue;
      _sat = sat;
    });
    _cmd({'capability': 'color', 'hue': hue.round(), 'saturation': (sat * 100).round()});
  }

  void _setKelvin(double k) {
    setState(() => _kelvin = k);
    _cmd({'capability': 'color', 'kelvin': k.round()});
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.device.name),
        actions: [
          Switch(
            value: _on,
            onChanged: (v) {
              setState(() => _on = v);
              _cmd({'capability': widget.device.capabilities.contains('brightness') ? 'brightness' : 'onoff', 'action': v ? 'on' : 'off'});
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          // Brightness dial — a tall bar that fills bottom-up; drag to set.
          Center(
            child: _BrightnessBar(value: _level, onChanged: _setLevel),
          ),
          const SizedBox(height: AureonSpacing.sm),
          Center(child: Text('${(_level * 100).round()}%', style: text.headlineSmall)),
          const SizedBox(height: AureonSpacing.xl),

          if (_hasColour) ...[
            Center(
              child: SegmentedButton<_Mode>(
                segments: const [
                  ButtonSegment(value: _Mode.colour, label: Text('Colour'), icon: Icon(Icons.palette_outlined)),
                  ButtonSegment(value: _Mode.white, label: Text('White'), icon: Icon(Icons.wb_sunny_outlined)),
                ],
                selected: {_mode},
                onSelectionChanged: (s) => setState(() => _mode = s.first),
                showSelectedIcon: false,
              ),
            ),
            const SizedBox(height: AureonSpacing.xl),
            if (_mode == _Mode.colour)
              Center(child: ColorWheel(hue: _hue, saturation: _sat, onChanged: _setColour))
            else
              _TemperatureSlider(kelvin: _kelvin, onChanged: _setKelvin),
          ],
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

/// Warm→cool colour-temperature slider (2200K..6500K).
class _TemperatureSlider extends StatelessWidget {
  const _TemperatureSlider({required this.kelvin, required this.onChanged});
  final double kelvin;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    const min = 2200.0, max = 6500.0;
    final t = ((kelvin - min) / (max - min)).clamp(0.0, 1.0);
    return Column(
      children: [
        LayoutBuilder(
          builder: (context, c) {
            void setFromDx(double dx) => onChanged(min + (dx / c.maxWidth).clamp(0.0, 1.0) * (max - min));
            return GestureDetector(
              onPanDown: (d) => setFromDx(d.localPosition.dx),
              onPanUpdate: (d) => setFromDx(d.localPosition.dx),
              child: Container(
                height: 56,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.pill),
                  gradient: const LinearGradient(
                    colors: [Color(0xFFFFB867), Color(0xFFFFF1D6), Color(0xFFCFE5FF)],
                  ),
                ),
                child: Align(
                  alignment: Alignment(t * 2 - 1, 0),
                  child: Container(
                    width: 28,
                    height: 28,
                    margin: const EdgeInsets.symmetric(horizontal: 6),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.black.withValues(alpha: 0.15)),
                      boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 6)],
                    ),
                  ),
                ),
              ),
            );
          },
        ),
        const SizedBox(height: AureonSpacing.sm),
        Text('${kelvin.round()}K', style: Theme.of(context).textTheme.labelMedium),
      ],
    );
  }
}
