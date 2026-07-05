import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Climate control (§11.1): ambient readout with a draggable/steppable target and
/// mode selection. Dual setpoints collapse to a single target here for the MVP.
class ClimateCard extends StatelessWidget {
  const ClimateCard({
    super.key,
    required this.ambientC,
    required this.targetC,
    required this.mode,
    required this.onTarget,
    required this.onMode,
  });

  final double ambientC;
  final double? targetC;
  final String mode;
  final ValueChanged<double> onTarget;
  final ValueChanged<String> onMode;

  @override
  Widget build(BuildContext context) {
    final target = targetC ?? ambientC;
    return Container(
      padding: const EdgeInsets.all(AureonSpacing.lg),
      decoration: BoxDecoration(
        color: AureonBase.surfaceRaised,
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        border: Border.all(color: AureonBase.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${ambientC.toStringAsFixed(1)}° inside',
              style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: AureonSpacing.sm),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              IconButton(
                onPressed: () => onTarget(target - 0.5),
                icon: const Icon(Icons.remove_circle_outline,
                    color: AureonGold.c400),
              ),
              Text('${target.toStringAsFixed(1)}°',
                  style: Theme.of(context).textTheme.displayLarge),
              IconButton(
                onPressed: () => onTarget(target + 0.5),
                icon: const Icon(Icons.add_circle_outline,
                    color: AureonGold.c400),
              ),
            ],
          ),
          const SizedBox(height: AureonSpacing.md),
          Wrap(
            spacing: AureonSpacing.sm,
            children: [
              for (final m in const ['off', 'heat', 'cool', 'auto'])
                ChoiceChip(
                  label: Text(m),
                  selected: mode == m,
                  onSelected: (_) => onMode(m),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
