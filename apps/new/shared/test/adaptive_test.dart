import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group('classifyAdaptive — Touch Panel presentation modes (§Phase7-6,14)', () {
    test('3-4 inch portrait classifies as micro with a single dominant action',
        () {
      final profile = classifyAdaptive(widthDp: 240, heightDp: 320);
      expect(profile.panelMode, PanelPresentationMode.micro);
      expect(profile.orientation, AdaptiveOrientation.portrait);
      expect(profile.composition, LayoutComposition.singleDominantAction);
      expect(profile.capacity, InformationCapacity.minimal);
    });

    test('5-7 inch classifies as compact with stacked controls', () {
      final profile = classifyAdaptive(widthDp: 360, heightDp: 640);
      expect(profile.panelMode, PanelPresentationMode.compact);
      expect(profile.composition, LayoutComposition.stackedControls);
    });

    test('10 inch portrait classifies as standard with stacked controls', () {
      final profile = classifyAdaptive(widthDp: 800, heightDp: 1280);
      expect(profile.panelMode, PanelPresentationMode.standard);
      expect(profile.orientation, AdaptiveOrientation.portrait);
      expect(profile.composition, LayoutComposition.stackedControls);
    });

    test(
        '10 inch landscape composes differently than 10 inch portrait '
        '(§Phase7-6 — same size, different composition)', () {
      final portrait = classifyAdaptive(widthDp: 800, heightDp: 1280);
      final landscape = classifyAdaptive(widthDp: 1280, heightDp: 800);

      expect(landscape.panelMode, portrait.panelMode); // same physical surface
      expect(landscape.composition, isNot(portrait.composition));
      expect(landscape.composition, LayoutComposition.gridControls);
      expect(landscape.capacity, InformationCapacity.rich);
    });

    test('20 inch classifies as expanded with side panels', () {
      final profile = classifyAdaptive(widthDp: 1600, heightDp: 1000);
      expect(profile.panelMode, PanelPresentationMode.expanded);
      expect(profile.composition, LayoutComposition.sidePanels);
      expect(profile.capacity, InformationCapacity.rich);
    });

    test(
        '30 inch classifies as immersive with side panels and expansive capacity',
        () {
      final profile = classifyAdaptive(widthDp: 2400, heightDp: 1500);
      expect(profile.panelMode, PanelPresentationMode.immersive);
      expect(profile.composition, LayoutComposition.sidePanels);
      expect(profile.capacity, InformationCapacity.expansive);
    });

    test('an explicit physical-size hint overrides the dp heuristic', () {
      // A panel whose registered hardware model says 7" but happens to
      // report unusual dp (e.g. non-standard density) still classifies by
      // its known real size once that's available (§ honest limitation).
      final profile = classifyAdaptive(
        widthDp: 2000,
        heightDp: 1200,
        physicalSizeInchesHint: 7,
      );
      expect(profile.panelMode, PanelPresentationMode.compact);
    });
  });

  group('touch target constraints (§Phase7-4)', () {
    test('smaller panels get larger minimum touch targets than larger panels',
        () {
      final micro = classifyAdaptive(widthDp: 240, heightDp: 320);
      final compact = classifyAdaptive(widthDp: 360, heightDp: 640);
      final standard = classifyAdaptive(widthDp: 800, heightDp: 1280);
      final expanded = classifyAdaptive(widthDp: 1600, heightDp: 1000);
      final immersive = classifyAdaptive(widthDp: 2400, heightDp: 1500);

      expect(micro.minTouchTarget, greaterThan(compact.minTouchTarget));
      expect(compact.minTouchTarget, greaterThan(standard.minTouchTarget));
      expect(standard.minTouchTarget, greaterThan(expanded.minTouchTarget));
      expect(expanded.minTouchTarget,
          greaterThanOrEqualTo(immersive.minTouchTarget));

      // Every tier still clears a real touch-accessibility floor.
      for (final p in [micro, compact, standard, expanded, immersive]) {
        expect(p.minTouchTarget, greaterThanOrEqualTo(44));
      }
    });
  });

  group('spacing/typography resolution (§Phase7-1,2,3)', () {
    test('density scales spacing consistently across tiers', () {
      final compact = const SupremeSpacingResolver(SupremeDensity.compact);
      final comfortable =
          const SupremeSpacingResolver(SupremeDensity.comfortable);
      final immersive = const SupremeSpacingResolver(SupremeDensity.immersive);

      expect(compact.space(SupremeSpaceToken.md),
          lessThan(comfortable.space(SupremeSpaceToken.md)));
      expect(
        comfortable.space(SupremeSpaceToken.md),
        lessThan(immersive.space(SupremeSpaceToken.md)),
      );
    });

    test('font size stays within the declared fluid range at every density',
        () {
      for (final density in SupremeDensity.values) {
        final resolver = SupremeSpacingResolver(density);
        final size = resolver.fontSize(SupremeTypography.title);
        expect(size, greaterThanOrEqualTo(SupremeTypography.title.minSize));
        expect(size, lessThanOrEqualTo(SupremeTypography.title.maxSize));
      }
    });
  });
}
