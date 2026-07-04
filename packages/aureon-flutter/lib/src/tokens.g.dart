// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/aureon-web/tokens/aureon.tokens.json
// Regenerate: pnpm --filter @supreme/codegen gen:aureon-dart
//
// Aureon design tokens (blueprint §11.2): dark, architectural, gold-accented.
import 'package:flutter/widgets.dart';

class AureonBase {
  const AureonBase._();
  static const Color voidColor = Color(0xFF0A0908);
  static const Color surface = Color(0xFF141210);
  static const Color surfaceRaised = Color(0xFF1C1A16);
  static const Color surfaceOverlay = Color(0xFF242119);
  static const Color hairline = Color(0xFF2D2A24);
}

class AureonGold {
  const AureonGold._();
  static const Color c50 = Color(0xFFEFE9DF);
  static const Color c200 = Color(0xFFD8C9B4);
  static const Color c400 = Color(0xFFB29B80);
  static const Color c500 = Color(0xFF9C876C);
  static const Color c600 = Color(0xFF7E6B52);
  static const Color c700 = Color(0xFF5C4E3B);
}

class AureonText {
  const AureonText._();
  static const Color primary = Color(0xFFF4F1EA);
  static const Color secondary = Color(0xFFB6B2A8);
  static const Color muted = Color(0xFF7E7B73);
  static const Color inverse = Color(0xFF0A0A0C);
}

class AureonStatus {
  const AureonStatus._();
  static const Color good = Color(0xFF6FBF8B);
  static const Color info = Color(0xFF6FA8BF);
  static const Color warning = Color(0xFFD9A441);
  static const Color critical = Color(0xFFCF6B5A);
}

class AureonSpacing {
  const AureonSpacing._();
  static const double unit = 4.0;
  static const double xs = 4.0;
  static const double sm = 8.0;
  static const double md = 16.0;
  static const double lg = 24.0;
  static const double xl = 40.0;
  static const double xxl = 64.0;
}

class AureonRadius {
  const AureonRadius._();
  static const double sm = 8.0;
  static const double md = 16.0;
  static const double lg = 24.0;
  static const double pill = 999.0;
}

class AureonMotion {
  const AureonMotion._();
  static const Duration fast = Duration(milliseconds: 140);
  static const Duration base = Duration(milliseconds: 260);
  static const Duration slow = Duration(milliseconds: 420);
  static const Cubic quietOut = Cubic(0.16, 1, 0.3, 1);
  static const Cubic slowIn = Cubic(0.4, 0, 0.2, 1);
}
