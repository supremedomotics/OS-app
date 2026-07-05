import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// Accent ramp choice (§11.2 Themes) — warm Gold or cool Silver.
enum AureonAccent { gold, silver }

/// Builds the Aureon [ThemeData] from the generated design tokens (§11.2).
///
/// Dark, architectural base layers (Luxury Black) with a warm gold accent ramp; a
/// premium type scale with a serif display face over a clean body sans. The same theme
/// also renders Luxury White (light) and a Silver accent, selected by [build]. Both the
/// homeowner and installer personas share this theme and diverge only in density.
class AureonTheme {
  const AureonTheme._();

  // Luxury White (light) base palette — mirrors the web `[data-theme="light"]` block.
  static const Color _lightVoid = Color(0xFFF4F3EF);
  static const Color _lightSurface = Color(0xFFFFFFFF);
  static const Color _lightSurfaceRaised = Color(0xFFFAF9F5);
  static const Color _lightTextPrimary = Color(0xFF1A1B1E);
  static const Color _lightTextSecondary = Color(0xFF5C5A53);

  // Silver accent ramp.
  static const Color _silver400 = Color(0xFFC8CDD6);
  static const Color _silver500 = Color(0xFFAEB4BE);

  static ThemeData dark({AureonAccent accent = AureonAccent.gold}) =>
      build(brightness: Brightness.dark, accent: accent);

  static ThemeData light({AureonAccent accent = AureonAccent.gold}) =>
      build(brightness: Brightness.light, accent: accent);

  /// Build the theme for a given base brightness + accent ramp.
  static ThemeData build({
    required Brightness brightness,
    AureonAccent accent = AureonAccent.gold,
  }) {
    final isDark = brightness == Brightness.dark;
    final accent400 = accent == AureonAccent.gold ? AureonGold.c400 : _silver400;
    final accent500 = accent == AureonAccent.gold ? AureonGold.c500 : _silver500;

    final background = isDark ? AureonBase.voidColor : _lightVoid;
    final surface = isDark ? AureonBase.surface : _lightSurface;
    final surfaceRaised = isDark ? AureonBase.surfaceRaised : _lightSurfaceRaised;
    final textPrimary = isDark ? AureonText.primary : _lightTextPrimary;
    final textSecondary = isDark ? AureonText.secondary : _lightTextSecondary;

    final scheme = ColorScheme(
      brightness: brightness,
      primary: accent500,
      onPrimary: isDark ? AureonText.inverse : Colors.white,
      secondary: accent400,
      onSecondary: AureonText.inverse,
      surface: surface,
      onSurface: textPrimary,
      error: AureonStatus.critical,
      onError: Colors.white,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      fontFamily: 'Inter',
      textTheme: _textTheme(textPrimary, textSecondary),
      splashFactory: InkSparkle.splashFactory,
      cardTheme: CardThemeData(
        color: surfaceRaised,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AureonRadius.md),
        ),
      ),
    );
  }

  static TextTheme _textTheme(Color primary, Color secondary) => TextTheme(
        displayLarge: TextStyle(
          fontFamily: 'Aureon Display',
          fontSize: 40,
          height: 44 / 40,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.5,
          color: primary,
        ),
        titleLarge: TextStyle(
          fontFamily: 'Aureon Display',
          fontSize: 28,
          height: 34 / 28,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.25,
          color: primary,
        ),
        headlineSmall: TextStyle(
          fontSize: 22,
          height: 28 / 22,
          fontWeight: FontWeight.w600,
          color: primary,
        ),
        bodyLarge: TextStyle(fontSize: 16, height: 24 / 16, color: primary),
        labelMedium: TextStyle(
          fontSize: 13,
          height: 18 / 13,
          fontWeight: FontWeight.w500,
          letterSpacing: 0.4,
          color: secondary,
        ),
      );
}
