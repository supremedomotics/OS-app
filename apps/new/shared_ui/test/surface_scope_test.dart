import 'dart:ui' show DisplayFeature, DisplayFeatureState, DisplayFeatureType;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

Widget _host(Size size, Widget child, {List<DisplayFeature> features = const []}) =>
    MediaQuery(
      data: MediaQueryData(size: size, displayFeatures: features),
      child: child,
    );

SurfaceProfile? _profile;
AdaptiveProfile? _adaptive;

Widget _probe() => Builder(builder: (context) {
      _profile = SurfaceScope.of(context);
      return const SizedBox.shrink();
    });

Future<SurfaceProfile> _read(WidgetTester tester, Size size,
    {SurfacePanelBinding? panel,
    double? inches,
    SurfacePointer? pointer,
    bool tv = false,
    List<DisplayFeature> features = const []}) async {
  await tester.pumpWidget(_host(
    size,
    SurfaceScope(
      installedPanel: panel,
      physicalSizeInches: inches,
      pointer: pointer,
      isTelevision: tv,
      child: _probe(),
    ),
    features: features,
  ));
  return _profile!;
}

void main() {
  group('SurfaceScope publishes the SurfaceProfile for the real Flutter inputs', () {
    testWidgets('5" personal phone → focused', (tester) async {
      final p = await _read(tester, const Size(360, 640),
          pointer: SurfacePointer.coarse);
      expect(p.role, SurfaceRole.personal);
      expect(p.mode, SurfaceMode.focused);
      expect(p.formFactor, SurfaceFormFactor.phone);
    });

    testWidgets('5" room panel → compact panel, never a phone', (tester) async {
      final p = await _read(tester, const Size(360, 640),
          panel: SurfacePanelBinding.room, pointer: SurfacePointer.coarse);
      expect(p.role, SurfaceRole.roomPanel);
      expect(p.mode, SurfaceMode.compact);
      expect(p.formFactor, SurfaceFormFactor.panel);
    });

    testWidgets('3" personal device → glance, 3" room panel → compact',
        (tester) async {
      final watch = await _read(tester, const Size(320, 240),
          pointer: SurfacePointer.coarse);
      expect(watch.mode, SurfaceMode.glance);
      final panel = await _read(tester, const Size(320, 240),
          panel: SurfacePanelBinding.room, pointer: SurfacePointer.coarse);
      expect(panel.mode, SurfaceMode.compact);
      expect(panel.mode, isNot(watch.mode));
    });

    testWidgets('30" residence panel → expansive panel, not a desktop',
        (tester) async {
      final p = await _read(tester, const Size(2560, 1600),
          panel: SurfacePanelBinding.residence, pointer: SurfacePointer.coarse);
      expect(p.formFactor, SurfaceFormFactor.panel);
      expect(p.mode, SurfaceMode.expansive);
    });

    testWidgets('TV signal → distance with remote input', (tester) async {
      final p = await _read(tester, const Size(1920, 1080),
          tv: true, pointer: SurfacePointer.none);
      expect(p.formFactor, SurfaceFormFactor.tv);
      expect(p.input, SurfaceInput.remote);
      expect(p.mode, SurfaceMode.distance);
    });

    testWidgets('a hinge display feature opens the foldable, and is published',
        (tester) async {
      final p = await _read(
        tester,
        const Size(884, 1104),
        pointer: SurfacePointer.coarse,
        features: const [
          DisplayFeature(
              bounds: Rect.fromLTRB(430, 0, 454, 1104),
              type: DisplayFeatureType.hinge,
              state: DisplayFeatureState.postureFlat),
        ],
      );
      expect(p.formFactor, SurfaceFormFactor.foldable);
      expect(p.mode, SurfaceMode.spatial);
      expect(p.fold!.axis, SurfaceFoldAxis.vertical);
      expect(p.fold!.start, 430);
      expect(p.fold!.end, 454);
    });

    testWidgets('a cutout (notch) is not a fold', (tester) async {
      final p = await _read(
        tester,
        const Size(390, 844),
        pointer: SurfacePointer.coarse,
        features: const [
          DisplayFeature(
              bounds: Rect.fromLTRB(150, 0, 240, 30),
              type: DisplayFeatureType.cutout,
              state: DisplayFeatureState.unknown),
        ],
      );
      expect(p.fold, isNull);
      expect(p.formFactor, SurfaceFormFactor.phone);
    });

    testWidgets('resizing re-publishes: fold/unfold changes the composition',
        (tester) async {
      var p = await _read(tester, const Size(280, 653),
          pointer: SurfacePointer.coarse);
      expect(p.mode, SurfaceMode.compact);
      p = await _read(tester, const Size(884, 1104),
          pointer: SurfacePointer.coarse,
          features: const [
            DisplayFeature(
                bounds: Rect.fromLTRB(430, 0, 454, 1104),
                type: DisplayFeatureType.fold,
                state: DisplayFeatureState.postureFlat),
          ]);
      expect(p.mode, SurfaceMode.spatial);
    });

    testWidgets('an installed panel is never a wrist even when tiny',
        (tester) async {
      final p = await _read(tester, const Size(200, 200),
          panel: SurfacePanelBinding.residence, pointer: SurfacePointer.coarse);
      expect(p.mode, isNot(SurfaceMode.glance));
      expect(p.formFactor, SurfaceFormFactor.panel);
    });
  });

  group('AdaptiveScope is a compatibility adapter over the same SurfaceProfile', () {
    testWidgets('with no ancestor it creates a SurfaceScope', (tester) async {
      await tester.pumpWidget(_host(
        const Size(360, 640),
        AdaptiveScope(
          child: Builder(builder: (context) {
            _profile = SurfaceScope.of(context);
            _adaptive = AdaptiveScope.of(context);
            return const SizedBox.shrink();
          }),
        ),
      ));
      expect(_profile!.widthDp, 360);
      expect(_adaptive!.widthDp, _profile!.widthDp);
      expect(_adaptive!.heightDp, _profile!.heightDp);
      expect(_adaptive!.panelMode, PanelPresentationMode.compact);
    });

    testWidgets('an ancestor SurfaceScope is authoritative — no second classifier',
        (tester) async {
      await tester.pumpWidget(_host(
        const Size(360, 640),
        SurfaceScope(
          installedPanel: SurfacePanelBinding.room,
          pointer: SurfacePointer.coarse,
          child: AdaptiveScope(
            child: Builder(builder: (context) {
              _profile = SurfaceScope.of(context);
              return const SizedBox.shrink();
            }),
          ),
        ),
      ));
      expect(_profile!.role, SurfaceRole.roomPanel);
    });

    testWidgets('legacy AdaptiveProfile values are unchanged by the adapter',
        (tester) async {
      await tester.pumpWidget(_host(
        const Size(800, 1280),
        AdaptiveScope(
          child: Builder(builder: (context) {
            _adaptive = AdaptiveScope.of(context);
            return const SizedBox.shrink();
          }),
        ),
      ));
      final direct = classifyAdaptive(widthDp: 800, heightDp: 1280);
      expect(_adaptive!.panelMode, direct.panelMode);
      expect(_adaptive!.composition, direct.composition);
      expect(_adaptive!.density, direct.density);
    });
  });
}
