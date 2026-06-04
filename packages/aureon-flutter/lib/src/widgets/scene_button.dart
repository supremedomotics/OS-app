import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Quick-scene chip for the dashboard scene row (§11.1): "Arrive", "Movie", etc.
class SceneButton extends StatelessWidget {
  const SceneButton(
      {super.key, required this.label, required this.onTap, this.icon});

  final String label;
  final IconData? icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AureonBase.surfaceRaised,
      borderRadius: BorderRadius.circular(AureonRadius.pill),
      child: InkWell(
        borderRadius: BorderRadius.circular(AureonRadius.pill),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AureonSpacing.md,
            vertical: AureonSpacing.sm,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon ?? Icons.auto_awesome,
                  size: 18, color: AureonGold.c400),
              const SizedBox(width: AureonSpacing.sm),
              Text(label, style: Theme.of(context).textTheme.labelMedium),
            ],
          ),
        ),
      ),
    );
  }
}
