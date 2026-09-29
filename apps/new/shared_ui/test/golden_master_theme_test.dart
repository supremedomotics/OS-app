import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
  const serifFamily = 'packages/supreme_os_ui/${SupremeFonts.serif}';
  const sansFamily = 'packages/supreme_os_ui/${SupremeFonts.sans}';

  group('typography', () {
    test('what a thing IS is serif Light; everything functional is sans', () {
      for (final s in [
        text.headline,
        text.title,
        text.display,
        text.name,
        text.pageTitle,
        text.hero,
        text.value
      ]) {
        expect(s.fontFamily, serifFamily);
        expect(s.fontWeight, FontWeight.w300);
      }
      for (final s in [
        text.caption,
        text.label,
        text.body,
        text.sentence,
        text.kicker
      ]) {
        expect(s.fontFamily, sansFamily);
      }
    });

    test('nothing is bold — luxury is proportion, not weight', () {
      for (final s in [
        text.caption,
        text.label,
        text.body,
        text.headline,
        text.title,
        text.display,
        text.name,
        text.pageTitle,
        text.hero,
        text.sentence,
        text.value,
        text.kicker
      ]) {
        expect(s.fontWeight!.value, lessThanOrEqualTo(400));
      }
    });

    test('a control value uses tabular figures so it does not jitter', () {
      expect(text.value.fontFeatures, contains(const FontFeature.tabularFigures()));
    });

    test('the kicker is spaced at .2em and brass-pale', () {
      expect(text.kicker.letterSpacing! / text.kicker.fontSize!,
          closeTo(0.2, 1e-9));
      expect(text.kicker.color, SupremeColorScheme.brassPale);
    });

    test('serif tightens by .005em, as the Golden Master does', () {
      expect(text.pageTitle.letterSpacing! / text.pageTitle.fontSize!,
          closeTo(-0.005, 1e-9));
    });

    test('sizes follow density from the shared scale, never a literal', () {
      final compact = SupremeTextStyles.resolve(SupremeDensity.compact);
      final immersive = SupremeTextStyles.resolve(SupremeDensity.immersive);
      expect(compact.hero.fontSize, lessThan(immersive.hero.fontSize!));
      expect(compact.hero.fontSize, 44);
      expect(immersive.hero.fontSize, 76);
    });
  });

  group('theme', () {
    final theme = buildSupremeTheme();

    test('night canvas, brass as the single accent', () {
      expect(theme.scaffoldBackgroundColor, SupremeColorScheme.night);
      expect(theme.colorScheme.primary, SupremeColorScheme.brassLight);
      expect(theme.colorScheme.onSurface, SupremeColorScheme.text);
      expect(theme.dividerColor, SupremeColorScheme.rule);
    });

    test('Material is a primitive layer only: no ink ripple, our own font', () {
      expect(theme.splashFactory, NoSplash.splashFactory);
      expect(theme.textTheme.bodyLarge!.fontFamily, sansFamily);
      expect(theme.textTheme.titleLarge!.fontFamily, serifFamily);
    });
  });

  group('motion curves', () {
    test('settle is the Golden Master ease and is quick to leave', () {
      final c = SupremeMotionCurves.curveFor(SupremeCurveToken.settle);
      expect(c, SupremeMotionCurves.settle);
      expect(c.transform(0), 0);
      expect(c.transform(1), 1);
      expect(c.transform(0.25), greaterThan(0.25));
    });

    test('durations map the token milliseconds', () {
      expect(SupremeMotionCurves.pendingTravel.inMilliseconds, 1400);
      expect(SupremeMotionCurves.confirmBreathe.inMilliseconds, 900);
      expect(SupremeMotionCurves.failReturn.inMilliseconds, 900);
      expect(SupremeMotionCurves.composition.inMilliseconds, 380);
    });
  });

  group('fonts are really bundled', () {
    for (final f in ['CormorantGaramond-Light', 'Jost-Light', 'Jost-Regular']) {
      test(f, () async {
        final data =
            await rootBundle.load('packages/supreme_os_ui/assets/fonts/$f.ttf');
        expect(data.lengthInBytes, greaterThan(10000));
      });
    }

    test('both families are in the font manifest', () async {
      final manifest = await rootBundle.loadString('FontManifest.json');
      // Inside this package's own tests the manifest lists the declared names; an app that
      // depends on the package sees them as `packages/supreme_os_ui/<family>` (what the
      // TextStyles above resolve to).
      expect(manifest, contains('"family":"${SupremeFonts.serif}"'));
      expect(manifest, contains('"family":"${SupremeFonts.sans}"'));
    });

    test('each font ships with its OFL text (the licence requires it travel with the font)',
        () {
      for (final f in ['OFL-CormorantGaramond', 'OFL-Jost']) {
        final file = File('assets/fonts/$f.txt');
        expect(file.existsSync(), isTrue, reason: '$f.txt missing');
        expect(file.readAsStringSync().toUpperCase(),
            contains('SIL OPEN FONT LICENSE'));
      }
    });
  });
}
