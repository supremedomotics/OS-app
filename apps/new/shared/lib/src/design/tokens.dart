/// SupremeOS design tokens — raw values only. This file has no Flutter
/// dependency on purpose (mirrors `shared`'s architecture, §35): Mobile and
/// Touch Panel each map these onto `ThemeData`/`TextStyle` via
/// `supreme_os_ui`, so a future Web Homeowner app can reuse the same numbers
/// without pulling in Flutter.
///
/// One visual language for both Homeowner and Professional Mode (§1 of
/// Phase 7): Professional Mode raises information density by choosing a
/// denser [SupremeSpacing]/[SupremeDensity] tier, never by switching to a
/// different palette or type scale.
library;

/// Colors as 0xAARRGGBB ints — the same representation `Color` accepts
/// directly in the Flutter binding, so no lossy string round-trip.
class SupremeColors {
  // Base surfaces — dark architectural canvas (§24).
  static const voidBg = 0xFF0B0B0D;
  static const surface = 0xFF15151A;
  static const surfaceRaised = 0xFF1C1C22;
  static const surfaceOverlay = 0x99000000; // scrim over imagery
  static const hairline = 0xFF232329;

  // Warm neutral accent.
  static const gold50 = 0xFFFAF6EE;
  static const gold200 = 0xFFE8D9B5;
  static const gold400 = 0xFFD4B876;
  static const gold500 = 0xFFC9A55C;
  static const gold600 = 0xFFB08E4A;
  static const gold700 = 0xFF8C6F38;

  // Text hierarchy.
  static const textPrimary = 0xFFF2F1EE;
  static const textSecondary = 0xFF9C9A96;
  static const textMuted = 0xFF6B6A67;
  static const textInverse = 0xFF0B0B0D;

  // Semantic states — never color alone; always paired with a label (§29).
  static const statusGood = 0xFF5FBF7A;
  static const statusInfo = 0xFF6FA8DC;
  static const statusWarning = 0xFFE0B655;
  static const statusCritical = 0xFFD1655A;
}

/// Fluid type scale. Sizes are (min, max) logical-pixel pairs; the Flutter
/// binding clamps between them based on the current [SupremeDensity] rather
/// than a fixed per-breakpoint jump table.
class SupremeTypeScale {
  final double minSize;
  final double maxSize;
  final double lineHeight;
  const SupremeTypeScale(this.minSize, this.maxSize, this.lineHeight);
}

class SupremeTypography {
  static const caption = SupremeTypeScale(11, 13, 1.3);
  static const label = SupremeTypeScale(13, 15, 1.3);
  static const body = SupremeTypeScale(15, 17, 1.4);
  static const headline = SupremeTypeScale(20, 24, 1.2);
  static const title = SupremeTypeScale(24, 32, 1.15);
  static const display = SupremeTypeScale(36, 56, 1.05);
}

/// Spacing scale (§Phase7-3). A component asks for a semantic size, never a
/// literal pixel value — [SupremeDensity] decides the actual dp.
enum SupremeSpaceToken { xs, sm, md, lg, xl, xxl }

/// Corner radius scale.
enum SupremeRadiusToken { sm, md, lg, xl }

/// Elevation tiers (shadow depth), used sparingly (§24 — restrained shadows).
enum SupremeElevationToken { flat, raised, overlay }

/// Icon sizing scale (§ icon sizing).
enum SupremeIconSizeToken { sm, md, lg, xl }

/// Motion — durations in ms and named curves the Flutter binding maps onto
/// real `Curve`s. Kept small and reused everywhere (§25 — one vocabulary).
class SupremeMotion {
  static const fastMs = 120;
  static const standardMs = 220;
  static const slowMs = 400;
}

enum SupremeCurveToken { standard, decelerate, accelerate }

/// Density tiers a UI actually renders at. Distinct from [PanelPresentationMode]
/// (§Phase7-6, Touch-Panel-specific) — this is the general spacing/type-scale
/// multiplier shared by Mobile, Touch Panel and (later) Web.
enum SupremeDensity { compact, comfortable, expanded, immersive }

/// Resolves semantic tokens to concrete dp values for a given density. This
/// is the ONE place a pixel number is decided — components and screens must
/// never hardcode padding/margins themselves (§Phase7-3).
class SupremeSpacingResolver {
  final SupremeDensity density;
  const SupremeSpacingResolver(this.density);

  double _scale() => switch (density) {
        SupremeDensity.compact => 0.85,
        SupremeDensity.comfortable => 1.0,
        SupremeDensity.expanded => 1.2,
        SupremeDensity.immersive => 1.4,
      };

  double space(SupremeSpaceToken token) {
    final base = switch (token) {
      SupremeSpaceToken.xs => 4.0,
      SupremeSpaceToken.sm => 8.0,
      SupremeSpaceToken.md => 16.0,
      SupremeSpaceToken.lg => 24.0,
      SupremeSpaceToken.xl => 32.0,
      SupremeSpaceToken.xxl => 48.0,
    };
    return base * _scale();
  }

  double radius(SupremeRadiusToken token) => switch (token) {
        SupremeRadiusToken.sm => 8.0,
        SupremeRadiusToken.md => 12.0,
        SupremeRadiusToken.lg => 16.0,
        SupremeRadiusToken.xl => 24.0,
      };

  double iconSize(SupremeIconSizeToken token) => switch (token) {
        SupremeIconSizeToken.sm => 16.0,
        SupremeIconSizeToken.md => 24.0,
        SupremeIconSizeToken.lg => 32.0,
        SupremeIconSizeToken.xl => 48.0,
      };

  /// Font size for [scale] at this density — the fluid clamp (§Phase7-2).
  double fontSize(SupremeTypeScale scale) {
    final t = switch (density) {
      SupremeDensity.compact => 0.0,
      SupremeDensity.comfortable => 0.35,
      SupremeDensity.expanded => 0.7,
      SupremeDensity.immersive => 1.0,
    };
    return scale.minSize + (scale.maxSize - scale.minSize) * t;
  }
}

/// Environmental overlay (§Phase7-12): a subtle data model for "the
/// atmosphere reflects the room's actual state" — not gimmicky animation,
/// just a warmth/brightness tint a room image or background gradient can
/// apply. No real photography pipeline exists yet in this phase; this is the
/// data contract a future imagery layer consumes.
class EnvironmentalOverlay {
  /// -1 (cool) .. 1 (warm), derived from the room's current lighting mood.
  final double warmth;

  /// 0 (dark) .. 1 (bright), derived from aggregate brightness/shade state.
  final double brightness;

  const EnvironmentalOverlay({required this.warmth, required this.brightness});

  static const neutral = EnvironmentalOverlay(warmth: 0, brightness: 0.5);
}
