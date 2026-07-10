import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Warm→cool colour-temperature slider (§11.1 rich domain controls, 2200K..6500K by default).
/// Shared by the single-light detail screen and any room-wide "colour temperature" group control,
/// so both look and feel identical.
class TemperatureSlider extends StatelessWidget {
  const TemperatureSlider({
    super.key,
    required this.kelvin,
    required this.onChanged,
    this.min = 2200,
    this.max = 6500,
  });

  final double kelvin;
  final double min;
  final double max;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
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
