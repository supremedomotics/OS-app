import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import 'supreme_colors.dart';

/// A [TextStyle] set resolved for one [SupremeDensity] — this is what
/// [SupremeTextStyles.of] hands a widget. Sizes come from
/// `SupremeSpacingResolver.fontSize`, never a literal number in a widget
/// (§Phase7-2, restraint through a small deliberate hierarchy).
class SupremeTextStyles {
  final TextStyle caption;
  final TextStyle label;
  final TextStyle body;
  final TextStyle headline;
  final TextStyle title;
  final TextStyle display;

  const SupremeTextStyles._({
    required this.caption,
    required this.label,
    required this.body,
    required this.headline,
    required this.title,
    required this.display,
  });

  factory SupremeTextStyles.resolve(SupremeDensity density) {
    final resolver = SupremeSpacingResolver(density);
    TextStyle style(SupremeTypeScale scale, FontWeight weight, Color color) =>
        TextStyle(
          fontSize: resolver.fontSize(scale),
          height: scale.lineHeight,
          fontWeight: weight,
          color: color,
        );
    return SupremeTextStyles._(
      caption: style(SupremeTypography.caption, FontWeight.w400,
          SupremeColorScheme.textSecondary),
      label: style(SupremeTypography.label, FontWeight.w500,
          SupremeColorScheme.textSecondary),
      body: style(SupremeTypography.body, FontWeight.w400,
          SupremeColorScheme.textPrimary),
      headline: style(SupremeTypography.headline, FontWeight.w600,
          SupremeColorScheme.textPrimary),
      title: style(SupremeTypography.title, FontWeight.w600,
          SupremeColorScheme.textPrimary),
      display: style(SupremeTypography.display, FontWeight.w600,
          SupremeColorScheme.textPrimary),
    );
  }
}

/// One `ThemeData` for both Homeowner and Professional Mode (§Phase7-1) —
/// Professional Mode raises density, it never swaps palette/type family.
ThemeData buildSupremeTheme(
    {SupremeDensity density = SupremeDensity.comfortable}) {
  final text = SupremeTextStyles.resolve(density);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: SupremeColorScheme.voidBg,
    colorScheme: const ColorScheme.dark(
      primary: SupremeColorScheme.gold500,
      surface: SupremeColorScheme.surface,
      error: SupremeColorScheme.statusCritical,
    ),
    dividerColor: SupremeColorScheme.hairline,
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
