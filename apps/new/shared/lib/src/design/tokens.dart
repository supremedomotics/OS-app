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
///
/// The homeowner palette is the SupremeOS-10 Golden Master's (`:root` in its stylesheet):
/// a near-black "night", warm ivory, and brass used only for emphasis and state. Text is one
/// ivory at three opacities so it sits correctly on photography as well as on flat night.
/// `docs/design/supremeos-golden-master-tokens.md` records where each value comes from.
///
/// Legacy names (`voidBg`, `gold*`, `text*`, `hairline`) stay so existing consumers keep
/// compiling; where the Golden Master has an equivalent they now carry ITS value.
class SupremeColors {
  // ── Golden Master ──
  static const night = 0xFF08090A;
  static const ivory = 0xFFF7F4EE;
  static const ink = 0xFF2D2A25;
  static const brass = 0xFFA78048;
  static const brassLight = 0xFFC9A66B;
  static const brassPale = 0xFFDCC49A;

  /// Hover / emphasised text on night: a brass-tinted ivory the reference uses for names that
  /// are being pointed at or are current.
  static const champagne = 0xFFEFE3CC;

  /// Ink for text on an ivory (primary action) surface.
  static const onIvory = 0xFF15130F;

  /// Ivory at 100 / 72 / 56 % — primary, secondary and tertiary text.
  static const text = 0xFFF7F6F2;
  static const text2 = 0xB8F7F6F2;
  static const text3 = 0x8FF7F6F2;

  /// White at 9 % — the hairline the reference draws between layers.
  static const rule = 0x17FFFFFF;

  /// White at 5 % — the fainter hairline under the header.
  static const faintRule = 0x0DFFFFFF;

  /// Brass at 20 % — the wash behind a pressed / current chip or tab.
  static const brassWash = 0x33B48A4F;

  /// Ivory at 62 % — an idle navigation item (between `text2` 72 % and `text3` 56 %).
  static const textIdle = 0x9EF7F6F2;

  /// White at 13 % — the plate behind the current navigation item.
  static const plate = 0x21FFFFFF;

  /// The Golden Master's `panel-glass`: near-black at 88 % with a white 8 % edge. Its 28 px blur is
  /// switched off by the user's "Transparency: solid" preference, which uses [glassSolid].
  static const glass = 0xE00C0E10;
  static const glassEdge = 0x14FFFFFF;
  static const glassSolid = 0xF70C0D0F;

  /// The navigation rail (tablet, TV, phone on its side) at 92 %, and the phone's bottom bar at 94 %.
  static const rail = 0xEB0A0B0D;
  static const bar = 0xF00A0B0D;

  /// Night at 45 % — the veil under the header's Control button; its brass edge is brass-light at 45 %.
  static const veil = 0x7308090A;
  static const brassEdge = 0x73C9A66B;

  // ── Legacy names (mapped onto the Golden Master where an equivalent exists) ──
  static const voidBg = night;
  static const surface = 0xFF15151A;
  static const surfaceRaised = 0xFF1C1C22;
  static const surfaceOverlay = 0x99000000; // scrim over imagery
  static const hairline = rule;

  static const gold50 = ivory;
  static const gold200 = brassPale;
  static const gold400 = brassLight;
  static const gold500 = brassLight;
  static const gold600 = brass;
  static const gold700 = 0xFF8C6F38;

  static const textPrimary = text;
  static const textSecondary = text2;
  static const textMuted = text3;
  static const textInverse = night;

  // Semantic states — never color alone; always paired with a label (§29). The Golden Master
  // says "needs attention" in brass and in words; these stay for Pro / diagnostics surfaces.
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
  // Sans (Jost): caption/label/body. Serif (Cormorant Garamond Light): headline/title/display
  // and the Golden Master names below.
  static const caption = SupremeTypeScale(11, 13, 1.3);
  static const label = SupremeTypeScale(13, 15, 1.3);
  static const body = SupremeTypeScale(15, 17, 1.4);

  // Legacy sizes — kept so screens built before the Golden Master do not move (a 34 dp title
  // overflows a 3" panel that was laid out for 24). New UI uses name / pageTitle / hero.
  static const headline = SupremeTypeScale(20, 24, 1.2);
  static const title = SupremeTypeScale(24, 32, 1.15);
  static const display = SupremeTypeScale(36, 56, 1.05);

  // Golden Master scale: a space or floor name 22–28, a page or panel title 34–52, the state
  // sentence on Home 44–76.
  static const name = SupremeTypeScale(22, 28, 1.2);
  static const pageTitle = SupremeTypeScale(34, 52, 1.05);
  static const hero = SupremeTypeScale(44, 76, 1.0);

  /// The Home / Space sentence ("Everything is as you left it.") — light sans, generous leading.
  static const sentence = SupremeTypeScale(17, 20, 1.55);

  /// A figure that is the subject of a control (a set temperature): serif, tabular.
  static const value = SupremeTypeScale(36, 44, 1.0);

  /// Uppercase spaced label over a title ("CONTROL", a floor name).
  static const kicker = SupremeTypeScale(11, 12, 1.3);
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
///
/// One emotional language (Responsive Interaction Grammar §7): pending TRAVELS, confirmation
/// BREATHES, failure RETURNS. The Golden Master's timings: a hairline sweeps for 1.4 s while a
/// command is on its way; a soft ring answers a confirmation for 0.9 s; a control that failed
/// dips and returns to what the device reports over 0.9 s.
class SupremeMotion {
  static const fastMs = 120;
  static const standardMs = 220;
  static const slowMs = 400;

  /// Chips, tabs, rows (`.2s`), controls (`.25s`), switches and sheets (`.35s`).
  static const chipMs = 200;
  static const controlMs = 250;
  static const sheetMs = 350;

  /// Content arriving (`sos-rise`, `.5–.6s`) and imagery settling (`.7s`).
  static const riseMs = 550;
  static const imageMs = 700;

  /// Fold / unfold, or a panel taking its role: a cross-fade of the whole composition.
  static const compositionMs = 380;

  /// A layer (the Control drawer or sheet) sliding in or out.
  static const layerMs = 500;

  static const pendingTravelMs = 1400;
  static const confirmBreatheMs = 900;
  static const failReturnMs = 900;

  /// The hero's ambient scale (1 → 1.012), tied to real state, not decoration.
  static const ambientBreatheMs = 9000;
}

enum SupremeCurveToken {
  standard,
  decelerate,
  accelerate,

  /// The Golden Master's `--sos-ease`: `cubic-bezier(.2,.7,.2,1)` — quick to leave, slow to settle.
  settle,
}

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
