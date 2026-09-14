import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/adaptive_scope.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_theme.dart';

/// The primary call-to-action, sized to the profile's real minimum touch
/// target (§Phase7-4) — never a hardcoded button height.
class PrimaryAction extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  const PrimaryAction(
      {super.key, required this.label, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    return SizedBox(
      height: profile.minTouchTarget,
      child: FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: SupremeColorScheme.gold500,
          foregroundColor: SupremeColorScheme.textInverse,
        ),
        onPressed: onPressed,
        child: Text(label,
            style: text.body.copyWith(color: SupremeColorScheme.textInverse)),
      ),
    );
  }
}

/// A secondary, lower-emphasis action — same touch-target discipline.
class SecondaryAction extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  const SecondaryAction(
      {super.key, required this.label, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    return SizedBox(
      height: profile.minTouchTarget,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: SupremeColorScheme.textPrimary,
          side: const BorderSide(color: SupremeColorScheme.hairline),
        ),
        onPressed: onPressed,
        child: Text(label),
      ),
    );
  }
}

/// An Experience tile (§16-17) — a name and nothing else; the homeowner sees
/// "Relax", never a device command list.
class ExperienceControl extends StatelessWidget {
  final String name;
  final VoidCallback onActivate;
  const ExperienceControl(
      {super.key, required this.name, required this.onActivate});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;
    return Semantics(
      button: true,
      label: 'Activate $name experience',
      excludeSemantics: true,
      child: InkWell(
        onTap: onActivate,
        borderRadius:
            BorderRadius.circular(spacing.radius(SupremeRadiusToken.lg)),
        child: Container(
          constraints: BoxConstraints(minHeight: profile.minTouchTarget),
          padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.md)),
          decoration: BoxDecoration(
            color: SupremeColorScheme.surface,
            borderRadius:
                BorderRadius.circular(spacing.radius(SupremeRadiusToken.lg)),
            border: Border.all(color: SupremeColorScheme.hairline),
          ),
          alignment: Alignment.bottomLeft,
          child: Text(name, style: text.headline),
        ),
      ),
    );
  }
}
