import 'package:flutter/material.dart';

import '../adaptive/adaptive_scope.dart';
import '../theme/supreme_colors.dart';

import 'package:supreme_os_core/supreme_os_core.dart';

/// The one grouped-content surface every card-like element uses (§24 —
/// restrained elevation, never a bare styled `Container` per screen).
class SupremeCard extends StatelessWidget {
  final Widget child;
  const SupremeCard({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final spacing = AdaptiveScope.of(context).spacing;
    return Container(
      decoration: BoxDecoration(
        color: SupremeColorScheme.surface,
        borderRadius:
            BorderRadius.circular(spacing.radius(SupremeRadiusToken.lg)),
        border: Border.all(color: SupremeColorScheme.hairline),
      ),
      child: child,
    );
  }
}
