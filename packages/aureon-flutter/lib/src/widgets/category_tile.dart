import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Ovio-style horizontal category tile (§11.1): an icon + label on the left and a value
/// on the right, with the background filling **proportionally** to the value. Used for
/// room aggregates ("Lights · 7 on") and for navigation rows. Tap drills in.
///
/// Theme-aware (works in Luxury Black + Luxury White): surface from the card theme, fill
/// from the accent. For pure navigation rows pass [fill] = 0 and a chevron [trailing].
class CategoryTile extends StatelessWidget {
  const CategoryTile({
    super.key,
    required this.icon,
    required this.label,
    this.value,
    this.valueSuffix,
    this.fill = 0,
    this.active = false,
    this.onTap,
    this.trailing,
  });

  final IconData icon;
  final String label;

  /// Right-hand emphasised value, e.g. "7".
  final String? value;

  /// Muted suffix after the value, e.g. "on".
  final String? valueSuffix;

  /// Background fill fraction 0..1 (the embedded "slider" read).
  final double fill;

  /// Whether the category is active (lifts the accent intensity).
  final bool active;

  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final surface = Theme.of(context).cardTheme.color ?? scheme.surface;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: AureonMotion.fast,
        curve: AureonMotion.quietOut,
        height: 92,
        decoration: BoxDecoration(
          color: surface,
          borderRadius: BorderRadius.circular(AureonRadius.md),
          border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          children: [
            if (fill > 0)
              FractionallySizedBox(
                widthFactor: fill.clamp(0.0, 1.0),
                alignment: Alignment.centerLeft,
                child: AnimatedContainer(
                  duration: AureonMotion.base,
                  curve: AureonMotion.quietOut,
                  color: scheme.primary.withValues(alpha: active ? 0.22 : 0.12),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.lg),
              child: Row(
                children: [
                  Icon(icon, color: active ? scheme.primary : scheme.onSurface, size: 24),
                  const SizedBox(width: AureonSpacing.md),
                  Expanded(child: Text(label, style: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600))),
                  if (value != null)
                    RichText(
                      text: TextSpan(
                        style: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                        children: [
                          TextSpan(text: value),
                          if (valueSuffix != null)
                            TextSpan(
                              text: '  $valueSuffix',
                              style: text.labelMedium?.copyWith(color: scheme.onSurface.withValues(alpha: 0.55)),
                            ),
                        ],
                      ),
                    ),
                  if (trailing != null) ...[const SizedBox(width: AureonSpacing.sm), trailing!],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
