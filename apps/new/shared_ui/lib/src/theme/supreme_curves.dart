import 'package:flutter/animation.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Maps [SupremeCurveToken] onto real `Curve`s and [SupremeMotion]'s ms
/// constants onto `Duration`s — the one place motion vocabulary becomes
/// Flutter types (§25 — one vocabulary, reused everywhere).
class SupremeMotionCurves {
  static Curve curveFor(SupremeCurveToken token) => switch (token) {
        SupremeCurveToken.standard => Curves.easeInOut,
        SupremeCurveToken.decelerate => Curves.easeOut,
        SupremeCurveToken.accelerate => Curves.easeIn,
      };

  static const fast = Duration(milliseconds: SupremeMotion.fastMs);
  static const standard = Duration(milliseconds: SupremeMotion.standardMs);
  static const slow = Duration(milliseconds: SupremeMotion.slowMs);
}
