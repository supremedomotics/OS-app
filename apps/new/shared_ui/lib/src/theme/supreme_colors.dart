import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Flutter `Color` wrappers over the raw int tokens in
/// `supreme_os_core`'s `SupremeColors` — the ONE place a token int becomes a
/// `Color`, so no widget ever hardcodes a hex value (§Phase7-11).
class SupremeColorScheme {
  static const voidBg = Color(SupremeColors.voidBg);
  static const surface = Color(SupremeColors.surface);
  static const surfaceRaised = Color(SupremeColors.surfaceRaised);
  static const surfaceOverlay = Color(SupremeColors.surfaceOverlay);
  static const hairline = Color(SupremeColors.hairline);

  static const gold50 = Color(SupremeColors.gold50);
  static const gold200 = Color(SupremeColors.gold200);
  static const gold400 = Color(SupremeColors.gold400);
  static const gold500 = Color(SupremeColors.gold500);
  static const gold600 = Color(SupremeColors.gold600);
  static const gold700 = Color(SupremeColors.gold700);

  static const textPrimary = Color(SupremeColors.textPrimary);
  static const textSecondary = Color(SupremeColors.textSecondary);
  static const textMuted = Color(SupremeColors.textMuted);
  static const textInverse = Color(SupremeColors.textInverse);

  static const statusGood = Color(SupremeColors.statusGood);
  static const statusInfo = Color(SupremeColors.statusInfo);
  static const statusWarning = Color(SupremeColors.statusWarning);
  static const statusCritical = Color(SupremeColors.statusCritical);
}
