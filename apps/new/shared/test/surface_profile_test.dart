import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// Ports the behavioral invariants of the reference `tests/surfaces.js` (22-surface matrix)
/// and `tests/authority.js` (five confusable surfaces). Sizes are the reference's viewports in
/// logical pixels.
const _touch = SurfacePointer.coarse;

SurfaceDisplayFeature _vHinge(double w, double h) => SurfaceDisplayFeature(
    left: w / 2 - 12, top: 0, right: w / 2 + 12, bottom: h);
SurfaceDisplayFeature _hHinge(double w, double h) => SurfaceDisplayFeature(
    left: 0, top: h / 2 - 12, right: w, bottom: h / 2 + 12);

class _Row {
  final String name;
  final SurfaceInputs inputs;
  final SurfaceRole role;
  final SurfaceFormFactor form;
  final SurfaceMode mode;
  const _Row(this.name, this.inputs, this.role, this.form, this.mode);
}

SurfaceInputs _in(double w, double h,
        {SurfacePointer pointer = _touch,
        SurfacePanelBinding? panel,
        double? inches,
        bool tv = false,
        List<SurfaceDisplayFeature> features = const []}) =>
    SurfaceInputs(
        widthDp: w,
        heightDp: h,
        pointer: pointer,
        installedPanel: panel,
        physicalSizeInches: inches,
        isTelevision: tv,
        displayFeatures: features);

const _room = SurfacePanelBinding.room;
const _res = SurfacePanelBinding.residence;

final _matrix = <_Row>[
  _Row('watch 44mm', _in(198, 242), SurfaceRole.personal,
      SurfaceFormFactor.watch, SurfaceMode.glance),
  _Row('3" room panel', _in(320, 240, panel: _room), SurfaceRole.roomPanel,
      SurfaceFormFactor.panel, SurfaceMode.compact),
  _Row('4" square room panel', _in(480, 480, panel: _room),
      SurfaceRole.roomPanel, SurfaceFormFactor.panel, SurfaceMode.compact),
  _Row('5" phone', _in(360, 640), SurfaceRole.personal,
      SurfaceFormFactor.phone, SurfaceMode.focused),
  _Row('6" phone', _in(390, 844), SurfaceRole.personal,
      SurfaceFormFactor.phone, SurfaceMode.focused),
  _Row('6" phone landscape', _in(844, 390), SurfaceRole.personal,
      SurfaceFormFactor.phone, SurfaceMode.focused),
  _Row('fold cover', _in(280, 653), SurfaceRole.personal,
      SurfaceFormFactor.foldable, SurfaceMode.compact),
  _Row(
      'fold open portrait (vertical hinge)',
      _in(884, 1104, features: [_vHinge(884, 1104)]),
      SurfaceRole.personal,
      SurfaceFormFactor.foldable,
      SurfaceMode.spatial),
  _Row(
      'fold open landscape (horizontal hinge)',
      _in(1104, 884, features: [_hHinge(1104, 884)]),
      SurfaceRole.personal,
      SurfaceFormFactor.foldable,
      SurfaceMode.spatial),
  _Row('7" room panel', _in(1024, 600, panel: _room), SurfaceRole.roomPanel,
      SurfaceFormFactor.panel, SurfaceMode.spatial),
  _Row('8" tablet portrait', _in(744, 1133), SurfaceRole.personal,
      SurfaceFormFactor.tablet, SurfaceMode.spatial),
  _Row('10" room panel portrait', _in(800, 1280, panel: _room),
      SurfaceRole.roomPanel, SurfaceFormFactor.panel, SurfaceMode.spatial),
  _Row('10" room panel landscape', _in(1280, 800, panel: _room),
      SurfaceRole.roomPanel, SurfaceFormFactor.panel, SurfaceMode.spatial),
  _Row('11" tablet landscape', _in(1194, 834), SurfaceRole.personal,
      SurfaceFormFactor.tablet, SurfaceMode.spatial),
  _Row('12.9" tablet portrait', _in(1024, 1366), SurfaceRole.personal,
      SurfaceFormFactor.tablet, SurfaceMode.spatial),
  _Row('15" residence panel', _in(1920, 1080, panel: _res),
      SurfaceRole.residencePanel, SurfaceFormFactor.panel, SurfaceMode.expansive),
  _Row('21" residence panel', _in(1920, 1080, panel: _res),
      SurfaceRole.residencePanel, SurfaceFormFactor.panel, SurfaceMode.expansive),
  _Row('24" residence panel portrait', _in(1200, 1920, panel: _res),
      SurfaceRole.residencePanel, SurfaceFormFactor.panel, SurfaceMode.expansive),
  _Row('27" residence panel', _in(2560, 1440, panel: _res),
      SurfaceRole.residencePanel, SurfaceFormFactor.panel, SurfaceMode.expansive),
  _Row('30" residence panel', _in(2560, 1600, panel: _res),
      SurfaceRole.residencePanel, SurfaceFormFactor.panel, SurfaceMode.expansive),
  _Row('desktop', _in(1920, 1080, pointer: SurfacePointer.fine),
      SurfaceRole.personal, SurfaceFormFactor.desktop, SurfaceMode.expansive),
  _Row('TV', _in(1920, 1080, pointer: SurfacePointer.none, tv: true),
      SurfaceRole.personal, SurfaceFormFactor.tv, SurfaceMode.distance),
];

void main() {
  group('surface matrix — role and mode per surface', () {
    for (final r in _matrix) {
      test(r.name, () {
        final p = surfaceProfileOf(r.inputs);
        expect(p.role, r.role);
        expect(p.formFactor, r.form);
        expect(p.mode, r.mode);
      });
    }
  });

  group('authority: five confusable surfaces', () {
    final cases = <String, (SurfaceInputs, SurfaceRole, SurfaceMode,
        SurfaceFormFactor, SurfaceSkeleton, SurfaceDistance)>{
      '3" room panel': (
        _in(320, 240, panel: _room),
        SurfaceRole.roomPanel,
        SurfaceMode.compact,
        SurfaceFormFactor.panel,
        SurfaceSkeleton.phone,
        SurfaceDistance.arm
      ),
      '3" residence panel': (
        _in(320, 240, panel: _res),
        SurfaceRole.residencePanel,
        SurfaceMode.compact,
        SurfaceFormFactor.panel,
        SurfaceSkeleton.phone,
        SurfaceDistance.arm
      ),
      '3" personal device': (
        _in(320, 240),
        SurfaceRole.personal,
        SurfaceMode.glance,
        SurfaceFormFactor.watch,
        SurfaceSkeleton.watch,
        SurfaceDistance.wrist
      ),
      '5" room panel': (
        _in(360, 640, panel: _room),
        SurfaceRole.roomPanel,
        SurfaceMode.compact,
        SurfaceFormFactor.panel,
        SurfaceSkeleton.phone,
        SurfaceDistance.arm
      ),
      '5" personal phone': (
        _in(360, 640),
        SurfaceRole.personal,
        SurfaceMode.focused,
        SurfaceFormFactor.phone,
        SurfaceSkeleton.phone,
        SurfaceDistance.hand
      ),
    };
    cases.forEach((name, c) {
      test(name, () {
        final p = surfaceProfileOf(c.$1);
        expect(p.role, c.$2);
        expect(p.mode, c.$3);
        expect(p.formFactor, c.$4);
        expect(p.skeleton, c.$5);
        expect(p.distance, c.$6);
      });
    });

    test('an installed panel is never a wrist, at any size', () {
      for (final binding in [_room, _res, SurfacePanelBinding.floor]) {
        final p = surfaceProfileOf(_in(200, 200, panel: binding));
        expect(p.mode, isNot(SurfaceMode.glance));
        expect(p.formFactor, SurfaceFormFactor.panel);
        expect(p.skeleton, isNot(SurfaceSkeleton.watch));
      }
    });

    test('role outranks dimensions: 10" panel is not a tablet, 30" not a desktop',
        () {
      expect(surfaceProfileOf(_in(1280, 800, panel: _room)).formFactor,
          SurfaceFormFactor.panel);
      expect(surfaceProfileOf(_in(2560, 1600, panel: _res)).formFactor,
          SurfaceFormFactor.panel);
      expect(surfaceProfileOf(_in(1280, 800)).formFactor,
          SurfaceFormFactor.tablet);
    });

    test('negative control: a subsystem disagreeing with the profile is detectable',
        () {
      final p = surfaceProfileOf(_in(320, 240, panel: _room));
      expect(p.skeleton == SurfaceSkeleton.watch, isFalse);
      expect(p.mode == SurfaceMode.glance, isFalse);
    });
  });

  group('authority order', () {
    test('role beats input: a remote-driven panel is still a panel', () {
      final p = surfaceProfileOf(
          _in(1920, 1080, pointer: SurfacePointer.none, tv: true, panel: _res));
      expect(p.decidedBy, SurfaceAuthority.role);
      expect(p.formFactor, SurfaceFormFactor.panel);
      expect(p.mode, SurfaceMode.distance);
    });

    test('input beats fold and dimensions: a TV is never a large desktop', () {
      final p = surfaceProfileOf(_in(1920, 1080,
          pointer: SurfacePointer.none,
          tv: true,
          features: [_vHinge(1920, 1080)]));
      expect(p.decidedBy, SurfaceAuthority.input);
      expect(p.formFactor, SurfaceFormFactor.tv);
    });

    test('role beats fold', () {
      final p = surfaceProfileOf(
          _in(884, 1104, panel: _room, features: [_vHinge(884, 1104)]));
      expect(p.decidedBy, SurfaceAuthority.role);
      expect(p.formFactor, SurfaceFormFactor.panel);
    });

    test('fold beats dimensions; cover is compact', () {
      expect(
          surfaceProfileOf(_in(884, 1104, features: [_vHinge(884, 1104)]))
              .decidedBy,
          SurfaceAuthority.fold);
      expect(surfaceProfileOf(_in(280, 653)).decidedBy,
          SurfaceAuthority.foldCover);
    });

    test('a registered physical size beats the dp heuristic for panels', () {
      // 2000x1200 dp would be spatial by dp; the panel registered as 5" is a compact panel.
      final p = surfaceProfileOf(_in(2000, 1200, panel: _room, inches: 5));
      expect(p.mode, SurfaceMode.compact);
      expect(surfaceProfileOf(_in(800, 480, panel: _room, inches: 10)).mode,
          SurfaceMode.spatial);
      expect(surfaceProfileOf(_in(800, 480, panel: _res, inches: 30)).mode,
          SurfaceMode.expansive);
    });

    test('a TV is not guessed from size alone', () {
      final p = surfaceProfileOf(_in(1920, 1080, pointer: SurfacePointer.fine));
      expect(p.input, SurfaceInput.pointer);
      expect(p.formFactor, SurfaceFormFactor.desktop);
    });

    test('a personal device never becomes a panel or carries a panel role', () {
      for (final r in _matrix.where((r) => r.role == SurfaceRole.personal)) {
        final p = surfaceProfileOf(r.inputs);
        expect(p.isInstalledPanel, isFalse, reason: r.name);
        expect(p.formFactor, isNot(SurfaceFormFactor.panel), reason: r.name);
      }
    });

    test('floor scope keeps its own role but behaves as an installed panel', () {
      final p = surfaceProfileOf(_in(1280, 800, panel: SurfacePanelBinding.floor));
      expect(p.role, SurfaceRole.floorPanel);
      expect(p.mode, SurfaceMode.spatial);
    });

    test('production ControlScope maps to a binding, wholeHome → residence', () {
      expect(SurfacePanelBinding.forScope(ControlScope.room),
          SurfacePanelBinding.room);
      expect(SurfacePanelBinding.forScope(ControlScope.floor),
          SurfacePanelBinding.floor);
      expect(SurfacePanelBinding.forScope(ControlScope.wholeHome),
          SurfacePanelBinding.residence);
    });
  });

  group('derived fields', () {
    test('input: remote / touch / pointer', () {
      expect(surfaceProfileOf(_in(1920, 1080, tv: true)).input,
          SurfaceInput.remote);
      expect(
          surfaceProfileOf(_in(1920, 1080, pointer: SurfacePointer.none)).input,
          SurfaceInput.remote);
      expect(surfaceProfileOf(_in(360, 640)).input, SurfaceInput.touch);
      expect(surfaceProfileOf(_in(1440, 900, pointer: SurfacePointer.fine)).input,
          SurfaceInput.pointer);
    });

    test('content priority ceiling follows the mode (P0 / P1 / P2 / P3 / P3 / P2)',
        () {
      const want = {
        SurfaceMode.glance: ContentPriority.p0,
        SurfaceMode.compact: ContentPriority.p1,
        SurfaceMode.focused: ContentPriority.p2,
        SurfaceMode.spatial: ContentPriority.p3,
        SurfaceMode.expansive: ContentPriority.p3,
        SurfaceMode.distance: ContentPriority.p2,
      };
      for (final r in _matrix) {
        final p = surfaceProfileOf(r.inputs);
        expect(p.maxPriority, want[p.mode], reason: r.name);
      }
    });

    test('P4 (technical) is never shown to a homeowner on any surface', () {
      for (final r in _matrix) {
        expect(surfaceProfileOf(r.inputs).shows(ContentPriority.p4), isFalse,
            reason: r.name);
      }
    });

    test('shows() hides content the mode ranks below its ceiling', () {
      final watch = surfaceProfileOf(_in(198, 242));
      expect(watch.shows(ContentPriority.p0), isTrue);
      expect(watch.shows(ContentPriority.p1), isFalse);
      final tablet = surfaceProfileOf(_in(744, 1133));
      expect(tablet.shows(ContentPriority.p3), isTrue);
    });

    test('distance and orientation', () {
      expect(surfaceProfileOf(_in(198, 242)).distance, SurfaceDistance.wrist);
      expect(surfaceProfileOf(_in(360, 640)).distance, SurfaceDistance.hand);
      expect(
          surfaceProfileOf(_in(1920, 1080, pointer: SurfacePointer.none, tv: true))
              .distance,
          SurfaceDistance.far);
      expect(surfaceProfileOf(_in(360, 640)).orientation,
          SurfaceOrientation.portrait);
      expect(surfaceProfileOf(_in(844, 390)).orientation,
          SurfaceOrientation.landscape);
    });

    test('zoom scales only distance and very large canvases', () {
      expect(surfaceProfileOf(_in(360, 640)).zoom, 1);
      final tv = surfaceProfileOf(
          _in(2880, 1620, pointer: SurfacePointer.none, tv: true));
      expect(tv.zoom, closeTo(2.0, 1e-9));
      final wall = surfaceProfileOf(_in(2560, 1600, panel: _res));
      expect(wall.zoom, closeTo(1.6, 1e-9));
      // 1920x1080 expansive canvas composes at 1600x900: 1.2×.
      expect(surfaceProfileOf(_in(1920, 1080, panel: _res)).zoom,
          closeTo(1.2, 1e-9));
      // expansive below the large-canvas threshold, and any spatial surface, do not scale.
      expect(surfaceProfileOf(_in(1440, 900, pointer: SurfacePointer.fine)).zoom,
          1);
      expect(surfaceProfileOf(_in(1280, 800, panel: _room)).zoom, 1);
    });
  });

  group('foldables — the hinge is published', () {
    test('vertical hinge exposes its span along x', () {
      final p = surfaceProfileOf(_in(884, 1104, features: [_vHinge(884, 1104)]));
      expect(p.fold, isNotNull);
      expect(p.fold!.axis, SurfaceFoldAxis.vertical);
      expect(p.fold!.start, 430);
      expect(p.fold!.end, 454);
    });

    test('horizontal hinge exposes its span along y', () {
      final p = surfaceProfileOf(_in(1104, 884, features: [_hHinge(1104, 884)]));
      expect(p.fold!.axis, SurfaceFoldAxis.horizontal);
      expect(p.fold!.start, 430);
      expect(p.fold!.end, 454);
    });

    test('a zero-width fold is still a vertical fold', () {
      final p = surfaceProfileOf(_in(884, 1104, features: [
        const SurfaceDisplayFeature(left: 442, top: 0, right: 442, bottom: 1104)
      ]));
      expect(p.fold!.axis, SurfaceFoldAxis.vertical);
    });

    test('no display feature means no fold', () {
      expect(surfaceProfileOf(_in(884, 1104)).fold, isNull);
    });
  });

  group('purity', () {
    test('the same inputs always give an equal profile', () {
      for (final r in _matrix) {
        expect(surfaceProfileOf(r.inputs), surfaceProfileOf(r.inputs),
            reason: r.name);
        expect(surfaceProfileOf(r.inputs).hashCode,
            surfaceProfileOf(r.inputs).hashCode,
            reason: r.name);
      }
    });
  });
}
