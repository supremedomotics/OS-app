import 'dart:math' as math;

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// Guards the homeowner design tokens against drifting from the SupremeOS-10 Golden Master
/// (`:root` custom properties in its stylesheet) — and against unreadable text.
double _channel(int v) {
  final c = v / 255;
  return c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();
}

double _luminance(int rgb) =>
    0.2126 * _channel((rgb >> 16) & 0xFF) +
    0.7152 * _channel((rgb >> 8) & 0xFF) +
    0.0722 * _channel(rgb & 0xFF);

/// Source-over blend of an ARGB [fg] on an opaque [bg], as the eye sees it.
int _over(int fg, int bg) {
  final a = ((fg >> 24) & 0xFF) / 255;
  int ch(int shift) =>
      ((((fg >> shift) & 0xFF) * a) + (((bg >> shift) & 0xFF) * (1 - a))).round();
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

double _contrast(int fg, int bg) {
  final l1 = _luminance(_over(fg, bg)), l2 = _luminance(bg & 0xFFFFFF);
  final hi = math.max(l1, l2), lo = math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

double _alpha(int argb) => ((argb >> 24) & 0xFF) / 255;

void main() {
  group('palette matches the Golden Master', () {
    test('solids', () {
      expect(SupremeColors.night, 0xFF08090A);
      expect(SupremeColors.ivory, 0xFFF7F4EE);
      expect(SupremeColors.ink, 0xFF2D2A25);
      expect(SupremeColors.brass, 0xFFA78048);
      expect(SupremeColors.brassLight, 0xFFC9A66B);
      expect(SupremeColors.brassPale, 0xFFDCC49A);
      expect(SupremeColors.text, 0xFFF7F6F2);
    });

    test('text is one ivory at 100 / 72 / 56 %; the rule is white at 9 %', () {
      expect(SupremeColors.text2 & 0xFFFFFF, 0xF7F6F2);
      expect(SupremeColors.text3 & 0xFFFFFF, 0xF7F6F2);
      expect(_alpha(SupremeColors.text2), closeTo(0.72, 0.003));
      expect(_alpha(SupremeColors.text3), closeTo(0.56, 0.003));
      expect(SupremeColors.rule & 0xFFFFFF, 0xFFFFFF);
      expect(_alpha(SupremeColors.rule), closeTo(0.09, 0.003));
      expect(_alpha(SupremeColors.faintRule), closeTo(0.05, 0.003));
      expect(_alpha(SupremeColors.brassWash), closeTo(0.20, 0.003));
      expect(_alpha(SupremeColors.textIdle), closeTo(0.62, 0.003));
      expect(_alpha(SupremeColors.plate), closeTo(0.13, 0.003));
      expect(_alpha(SupremeColors.glass), closeTo(0.88, 0.003));
      expect(_alpha(SupremeColors.glassEdge), closeTo(0.08, 0.003));
      expect(_alpha(SupremeColors.glassSolid), closeTo(0.97, 0.003));
      expect(_alpha(SupremeColors.rail), closeTo(0.92, 0.003));
      expect(_alpha(SupremeColors.bar), closeTo(0.94, 0.003));
      expect(_alpha(SupremeColors.veil), closeTo(0.45, 0.003));
      expect(_alpha(SupremeColors.brassEdge), closeTo(0.45, 0.003));
      expect(SupremeColors.brassEdge & 0xFFFFFF, SupremeColors.brassLight & 0xFFFFFF);
    });

    test('legacy names carry the Golden Master value where an equivalent exists', () {
      expect(SupremeColors.voidBg, SupremeColors.night);
      expect(SupremeColors.hairline, SupremeColors.rule);
      expect(SupremeColors.textPrimary, SupremeColors.text);
      expect(SupremeColors.textSecondary, SupremeColors.text2);
      expect(SupremeColors.textMuted, SupremeColors.text3);
      expect(SupremeColors.gold500, SupremeColors.brassLight);
      expect(SupremeColors.gold600, SupremeColors.brass);
      expect(SupremeColors.gold200, SupremeColors.brassPale);
      expect(SupremeColors.gold50, SupremeColors.ivory);
    });
  });

  group('text stays readable on night (WCAG AA, 4.5:1)', () {
    final night = SupremeColors.night;
    const roles = {
      'text': SupremeColors.text,
      'text2': SupremeColors.text2,
      'text3': SupremeColors.text3,
      'textIdle': SupremeColors.textIdle,
      'brassPale': SupremeColors.brassPale,
      'brassLight': SupremeColors.brassLight,
      'champagne': SupremeColors.champagne,
    };
    roles.forEach((name, color) {
      test(name, () => expect(_contrast(color, night), greaterThanOrEqualTo(4.5)));
    });

    test('ink on the ivory primary action', () {
      expect(_contrast(SupremeColors.onIvory, SupremeColors.ivory),
          greaterThanOrEqualTo(7));
    });

    test('the brass accent itself is a non-text mark, so it only needs 3:1', () {
      expect(_contrast(SupremeColors.brass, night), greaterThanOrEqualTo(3));
    });
  });

  group('motion is one language: pending travels, confirmation breathes, failure returns', () {
    test('Golden Master timings', () {
      expect(SupremeMotion.pendingTravelMs, 1400);
      expect(SupremeMotion.confirmBreatheMs, 900);
      expect(SupremeMotion.failReturnMs, 900);
      expect(SupremeMotion.compositionMs, 380);
      expect(SupremeMotion.layerMs, 500);
      expect(SupremeMotion.chipMs, lessThan(SupremeMotion.controlMs));
      expect(SupremeMotion.controlMs, lessThan(SupremeMotion.sheetMs));
    });

    test('a settling curve exists in the token vocabulary', () {
      expect(SupremeCurveToken.values, contains(SupremeCurveToken.settle));
    });
  });

  group('type scale', () {
    test('the Golden Master scale is ordered and non-degenerate', () {
      const scales = [
        SupremeTypography.caption,
        SupremeTypography.label,
        SupremeTypography.body,
        SupremeTypography.name,
        SupremeTypography.pageTitle,
        SupremeTypography.hero,
      ];
      for (final s in scales) {
        expect(s.minSize, lessThanOrEqualTo(s.maxSize));
      }
      for (var i = 1; i < scales.length; i++) {
        expect(scales[i].maxSize, greaterThan(scales[i - 1].maxSize));
      }
    });

    test('the Home sentence spans 44 (phone) to 76 (largest canvas)', () {
      expect(
          const SupremeSpacingResolver(SupremeDensity.compact)
              .fontSize(SupremeTypography.hero),
          44);
      expect(
          const SupremeSpacingResolver(SupremeDensity.immersive)
              .fontSize(SupremeTypography.hero),
          76);
    });

    test('legacy sizes are unchanged so pre-Golden-Master screens do not move', () {
      expect(SupremeTypography.headline.maxSize, 24);
      expect(SupremeTypography.title.maxSize, 32);
      expect(SupremeTypography.display.maxSize, 56);
    });
  });
}
