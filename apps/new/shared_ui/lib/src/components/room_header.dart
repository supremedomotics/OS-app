import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/adaptive_scope.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_theme.dart';

/// Entering a room, not opening a device dashboard (§18): name, a subtle
/// environmental tint (§12), and an optional back affordance — never a
/// device list. Reused verbatim by Mobile and Touch Panel (§13/§J).
class RoomHeader extends StatelessWidget {
  final String roomName;
  final EnvironmentalOverlay overlay;
  final VoidCallback? onBack;

  /// Optional trailing content — e.g. a [ConnectionStateIndicator]. Kept
  /// subtle by design (§Phase8-15: never a banner that dominates the
  /// screen) — just a small indicator alongside the room name.
  final Widget? trailing;

  const RoomHeader({
    super.key,
    required this.roomName,
    this.overlay = EnvironmentalOverlay.neutral,
    this.onBack,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    // Warmth/brightness (§12) tint the header background subtly — no
    // photography pipeline yet, just a data-driven color wash.
    final tint = Color.lerp(SupremeColorScheme.gold600,
        SupremeColorScheme.surfaceRaised, 1 - ((overlay.warmth + 1) / 2))!;

    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: spacing.space(SupremeSpaceToken.lg),
        vertical: spacing.space(SupremeSpaceToken.md),
      ),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            tint.withValues(alpha: 0.35 + overlay.brightness * 0.15),
            Colors.transparent
          ],
        ),
      ),
      child: Row(children: [
        if (onBack != null)
          Semantics(
            button: true,
            label: 'Back',
            child: IconButton(
              onPressed: onBack,
              icon: const Icon(Icons.arrow_back,
                  color: SupremeColorScheme.textPrimary),
            ),
          ),
        Expanded(
          child: Text(roomName, style: text.title),
        ),
        if (trailing != null) trailing!,
      ]),
    );
  }
}

/// A single concise line of current atmosphere (§Phase7-13's "Environmental
/// state" component) — e.g. "72°F · Warm · Shades relaxed" — never a raw
/// device-state dump.
class EnvironmentalStateLine extends StatelessWidget {
  final String summary;
  const EnvironmentalStateLine({super.key, required this.summary});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    return Semantics(
      label: 'Current environment: $summary',
      child: Text(summary,
          style: text.body.copyWith(color: SupremeColorScheme.textSecondary)),
    );
  }
}
