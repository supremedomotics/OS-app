import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// Builds the Aureon [ThemeData] from the generated design tokens (§11.2).
///
/// Dark, architectural base layers; a warm gold accent ramp; a premium type
/// scale with a serif display face over a clean body sans. Both the homeowner and
/// installer personas share this theme and diverge only in information density.
class AureonTheme {
  const AureonTheme._();

  static ThemeData dark() {
    const scheme = ColorScheme.dark(
      primary: AureonGold.c500,
      onPrimary: AureonText.inverse,
      secondary: AureonGold.c400,
      surface: AureonBase.surface,
      onSurface: AureonText.primary,
      error: AureonStatus.critical,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: AureonBase.voidColor,
      fontFamily: 'Inter',
      textTheme: _textTheme,
      splashFactory: InkSparkle.splashFactory,
      cardTheme: CardThemeData(
        color: AureonBase.surfaceRaised,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AureonRadius.md),
        ),
      ),
    );
  }

  static const TextTheme _textTheme = TextTheme(
    displayLarge: TextStyle(
      fontFamily: 'Aureon Display',
      fontSize: 40,
      height: 44 / 40,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.5,
      color: AureonText.primary,
    ),
    titleLarge: TextStyle(
      fontFamily: 'Aureon Display',
      fontSize: 28,
      height: 34 / 28,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.25,
      color: AureonText.primary,
    ),
    headlineSmall: TextStyle(
      fontSize: 22,
      height: 28 / 22,
      fontWeight: FontWeight.w600,
      color: AureonText.primary,
    ),
    bodyLarge:
        TextStyle(fontSize: 16, height: 24 / 16, color: AureonText.primary),
    labelMedium: TextStyle(
      fontSize: 13,
      height: 18 / 13,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.4,
      color: AureonText.secondary,
    ),
  );
}
