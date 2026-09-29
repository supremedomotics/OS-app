import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import 'supreme_colors.dart';

/// The Golden Master's two families (`assets/fonts/README.md`). A serif for what a thing IS
/// (a name, a title, the state sentence, the figure a control is about), a sans for everything
/// functional. Both are bundled by this package, so consumers pass `package` — never rely on
/// the platform's default font.
class SupremeFonts {
  static const serif = 'SOSSerif';
  static const sans = 'SOSSans';
  static const package = 'supreme_os_ui';

  static const serifFallback = ['Georgia', 'serif'];
  static const sansFallback = ['Arial', 'sans-serif'];
}

/// A [TextStyle] set resolved for one [SupremeDensity] — this is what
/// [SupremeTextStyles.resolve] hands a widget. Sizes come from
/// `SupremeSpacingResolver.fontSize`, never a literal number in a widget
/// (§Phase7-2, restraint through a small deliberate hierarchy).
///
/// Luxury here is proportion, not weight: the serif is always Light (300), the sans Light or
/// Regular. Nothing is bold.
class SupremeTextStyles {
  final TextStyle caption;
  final TextStyle label;
  final TextStyle body;
  final TextStyle headline;
  final TextStyle title;
  final TextStyle display;

  /// Golden Master serif scale (see [SupremeTypography.name]): a space or floor name, a page or
  /// panel title, and the state sentence on Home. `headline`/`title`/`display` keep their
  /// legacy sizes until the screens using them are rebuilt.
  final TextStyle name;
  final TextStyle pageTitle;
  final TextStyle hero;

  /// The Home / Space sentence.
  final TextStyle sentence;

  /// A figure a control is about (a set temperature): serif, tabular numerals.
  final TextStyle value;

  /// Uppercase spaced label over a title. The style does not upper-case: pass
  /// `text.toUpperCase()` (or a locale-aware equivalent) at the call site.
  final TextStyle kicker;

  const SupremeTextStyles._({
    required this.caption,
    required this.label,
    required this.body,
    required this.headline,
    required this.title,
    required this.display,
    required this.name,
    required this.pageTitle,
    required this.hero,
    required this.sentence,
    required this.value,
    required this.kicker,
  });

  factory SupremeTextStyles.resolve(SupremeDensity density) {
    final resolver = SupremeSpacingResolver(density);

    TextStyle sans(SupremeTypeScale scale, FontWeight weight, Color color,
            {double tracking = 0}) =>
        TextStyle(
          fontFamily: SupremeFonts.sans,
          fontFamilyFallback: SupremeFonts.sansFallback,
          package: SupremeFonts.package,
          fontSize: resolver.fontSize(scale),
          height: scale.lineHeight,
          fontWeight: weight,
          letterSpacing: tracking * resolver.fontSize(scale),
          color: color,
        );

    TextStyle serif(SupremeTypeScale scale, Color color,
        {List<FontFeature>? features}) {
      final size = resolver.fontSize(scale);
      return TextStyle(
        fontFamily: SupremeFonts.serif,
        fontFamilyFallback: SupremeFonts.serifFallback,
        package: SupremeFonts.package,
        fontSize: size,
        height: scale.lineHeight,
        fontWeight: FontWeight.w300,
        letterSpacing: -0.005 * size,
        fontFeatures: features,
        color: color,
      );
    }

    return SupremeTextStyles._(
      caption: sans(SupremeTypography.caption, FontWeight.w400,
          SupremeColorScheme.text3),
      label: sans(SupremeTypography.label, FontWeight.w400,
          SupremeColorScheme.text2,
          tracking: 0.04),
      body: sans(
          SupremeTypography.body, FontWeight.w400, SupremeColorScheme.text),
      headline: serif(SupremeTypography.headline, SupremeColorScheme.text),
      title: serif(SupremeTypography.title, SupremeColorScheme.text),
      display: serif(SupremeTypography.display, SupremeColorScheme.text),
      name: serif(SupremeTypography.name, SupremeColorScheme.text),
      pageTitle: serif(SupremeTypography.pageTitle, SupremeColorScheme.text),
      hero: serif(SupremeTypography.hero, SupremeColorScheme.text),
      sentence: sans(SupremeTypography.sentence, FontWeight.w300,
          SupremeColorScheme.text),
      value: serif(SupremeTypography.value, SupremeColorScheme.text,
          features: const [FontFeature.tabularFigures()]),
      kicker: sans(SupremeTypography.kicker, FontWeight.w400,
          SupremeColorScheme.brassPale,
          tracking: 0.2),
    );
  }
}

/// One `ThemeData` for both Homeowner and Professional Mode (§Phase7-1) —
/// Professional Mode raises density, it never swaps palette/type family.
///
/// Material is only a primitive layer here: the Golden Master has no ink ripples, no elevated
/// surfaces and no default Material typography, so those are switched off rather than skinned.
ThemeData buildSupremeTheme(
    {SupremeDensity density = SupremeDensity.comfortable}) {
  final text = SupremeTextStyles.resolve(density);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    fontFamily: SupremeFonts.sans,
    fontFamilyFallback: SupremeFonts.sansFallback,
    package: SupremeFonts.package,
    scaffoldBackgroundColor: SupremeColorScheme.night,
    canvasColor: SupremeColorScheme.night,
    splashFactory: NoSplash.splashFactory,
    colorScheme: const ColorScheme.dark(
      primary: SupremeColorScheme.brassLight,
      onPrimary: SupremeColorScheme.onIvory,
      secondary: SupremeColorScheme.brass,
      surface: SupremeColorScheme.night,
      onSurface: SupremeColorScheme.text,
      error: SupremeColorScheme.statusCritical,
    ),
    dividerColor: SupremeColorScheme.rule,
    textTheme: TextTheme(
      bodySmall: text.caption,
      labelMedium: text.label,
      bodyLarge: text.body,
      headlineSmall: text.headline,
      titleLarge: text.title,
      displaySmall: text.display,
    ),
  );
}
