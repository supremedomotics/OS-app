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
        SupremeCurveToken.settle => settle,
      };

  /// Golden Master `--sos-ease`.
  static const settle = Cubic(.2, .7, .2, 1);

  static const fast = Duration(milliseconds: SupremeMotion.fastMs);
  static const standard = Duration(milliseconds: SupremeMotion.standardMs);
  static const slow = Duration(milliseconds: SupremeMotion.slowMs);

  static const chip = Duration(milliseconds: SupremeMotion.chipMs);
  static const control = Duration(milliseconds: SupremeMotion.controlMs);
  static const sheet = Duration(milliseconds: SupremeMotion.sheetMs);
  static const rise = Duration(milliseconds: SupremeMotion.riseMs);
  static const image = Duration(milliseconds: SupremeMotion.imageMs);
  static const composition = Duration(milliseconds: SupremeMotion.compositionMs);
  static const layer = Duration(milliseconds: SupremeMotion.layerMs);

  /// Pending travels · confirmation breathes · failure returns.
  static const pendingTravel = Duration(milliseconds: SupremeMotion.pendingTravelMs);
  static const confirmBreathe = Duration(milliseconds: SupremeMotion.confirmBreatheMs);
  static const failReturn = Duration(milliseconds: SupremeMotion.failReturnMs);
  static const ambientBreathe = Duration(milliseconds: SupremeMotion.ambientBreatheMs);
}
