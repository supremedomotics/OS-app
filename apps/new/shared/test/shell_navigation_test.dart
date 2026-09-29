import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// The shell navigation is a pure function of the one SurfaceProfile. These tests pin the
/// Golden Master's frames per surface (docs/design/golden-master-implementation-map.md §1) and the
/// Responsive Interaction Grammar's navigation adaptation (§5).
SurfaceProfile _p(double w, double h,
        {SurfacePointer pointer = SurfacePointer.coarse,
        SurfacePanelBinding? panel,
        bool tv = false,
        List<SurfaceDisplayFeature> features = const []}) =>
    surfaceProfileOf(SurfaceInputs(
        widthDp: w,
        heightDp: h,
        pointer: pointer,
        installedPanel: panel,
        isTelevision: tv,
        displayFeatures: features));

List<ShellDestination> _dests(ShellNavigation n) =>
    n.items.map((i) => i.destination).toList();

const _all = [
  ShellDestination.home,
  ShellDestination.spaces,
  ShellDestination.control,
  ShellDestination.experiences,
  ShellDestination.settings,
];

void main() {
  group('frame per surface (the same five destinations, re-framed)', () {
    test('phone → bottom bar with Control as a nav item in the centre', () {
      final n = shellNavigationFor(_p(390, 844));
      expect(n.frame, ShellFrame.bottomBar);
      expect(_dests(n), _all);
      expect(n.controlEntry, ControlEntry.navItem);
      expect(n.items[2].destination, ShellDestination.control,
          reason: 'Control is the centre item of five');
    });

    test('phone held on its side → the bar moves to a side rail (the photo keeps its height)', () {
      final n = shellNavigationFor(_p(844, 390));
      expect(n.frame, ShellFrame.rail);
      expect(_dests(n), _all);
      expect(n.controlEntry, ControlEntry.navItem);
    });

    test('a compact room panel on its side follows the same rule', () {
      final n = shellNavigationFor(_p(320, 240, panel: SurfacePanelBinding.room),
          boundSpaceName: 'Kitchen');
      expect(n.frame, ShellFrame.rail);
      expect(n.has(ShellDestination.spaces), isFalse);
    });

    test('tablet → left rail with Control in it', () {
      final n = shellNavigationFor(_p(834, 1112));
      expect(n.frame, ShellFrame.rail);
      expect(_dests(n), _all);
      expect(n.controlEntry, ControlEntry.navItem);
    });

    test('TV → the same rail, directional focus', () {
      final n = shellNavigationFor(
          _p(1920, 1080, pointer: SurfacePointer.none, tv: true));
      expect(n.frame, ShellFrame.rail);
      expect(_dests(n), _all);
      expect(n.directionalFocus, isTrue);
    });

    test('desktop → top bar WITHOUT a Control item, plus a header Control button', () {
      final n = shellNavigationFor(_p(1440, 900, pointer: SurfacePointer.fine));
      expect(n.frame, ShellFrame.topBar);
      expect(_dests(n), [
        ShellDestination.home,
        ShellDestination.spaces,
        ShellDestination.experiences,
        ShellDestination.settings,
      ]);
      expect(n.controlEntry, ControlEntry.headerButton);
      expect(n.has(ShellDestination.control), isFalse);
    });

    test('watch → no navigation at all; Control is a glance link', () {
      final n = shellNavigationFor(_p(198, 242));
      expect(n.frame, ShellFrame.none);
      expect(n.items, isEmpty);
      expect(n.controlEntry, ControlEntry.glanceLink);
      expect(n.chromeVisible, isTrue);
    });

    test('the information architecture never gains navigation because there are more pixels', () {
      for (final size in [
        _p(390, 844),
        _p(834, 1112),
        _p(1440, 900, pointer: SurfacePointer.fine),
        _p(2560, 1440, pointer: SurfacePointer.fine),
        _p(2560, 1600, panel: SurfacePanelBinding.residence),
      ]) {
        final n = shellNavigationFor(size);
        final entries = n.items.length +
            (n.controlEntry == ControlEntry.headerButton ? 1 : 0);
        expect(entries, 5, reason: '$size');
      }
    });

    test('the order is always Home · Spaces · (Control) · Experiences · Settings', () {
      for (final s in [
        _p(390, 844),
        _p(1440, 900, pointer: SurfacePointer.fine)
      ]) {
        final order = _dests(shellNavigationFor(s));
        final ranked = order.map((d) => d.index).toList();
        expect([...ranked]..sort(), ranked);
      }
    });
  });

  group('installed panels', () {
    test('a room panel never lists Spaces; its Home is its room', () {
      final n = shellNavigationFor(
          _p(360, 640, panel: SurfacePanelBinding.room),
          boundSpaceName: 'Living Room');
      expect(n.has(ShellDestination.spaces), isFalse);
      expect(n.items.first.destination, ShellDestination.home);
      expect(n.items.first.label, 'Living');
      expect(n.items.first.semanticLabel, 'Living Room');
      expect(_dests(n), [
        ShellDestination.home,
        ShellDestination.control,
        ShellDestination.experiences,
        ShellDestination.settings,
      ]);
    });

    test('a room panel keeps its frame per its surface (compact → bar, spatial → rail)', () {
      expect(
          shellNavigationFor(_p(360, 640, panel: SurfacePanelBinding.room),
                  boundSpaceName: 'Kitchen')
              .frame,
          ShellFrame.bottomBar);
      expect(
          shellNavigationFor(_p(1280, 800, panel: SurfacePanelBinding.room),
                  boundSpaceName: 'Kitchen')
              .frame,
          ShellFrame.rail);
    });

    test('a room name that does not end in "Room" is used whole', () {
      final n = shellNavigationFor(
          _p(360, 640, panel: SurfacePanelBinding.room),
          boundSpaceName: 'Terrace');
      expect(n.items.first.label, 'Terrace');
    });

    test('a room panel without a resolvable room falls back to Home, never a guess', () {
      final n = shellNavigationFor(_p(360, 640, panel: SurfacePanelBinding.room));
      expect(n.items.first.label, 'Home');
    });

    test('a residence panel has the full hierarchy', () {
      final n = shellNavigationFor(_p(2560, 1600, panel: SurfacePanelBinding.residence));
      expect(n.frame, ShellFrame.topBar);
      expect(n.has(ShellDestination.spaces), isTrue);
      expect(n.items.first.label, 'Home');
    });

    test('a floor panel keeps Spaces and has no floor navigation (owner decision D1 pending)', () {
      final n = shellNavigationFor(_p(1280, 800, panel: SurfacePanelBinding.floor));
      expect(n.has(ShellDestination.spaces), isTrue);
      expect(n.items.length, 5);
    });

    test('an uncommissioned panel shows no chrome and no way to navigate away', () {
      final n = shellNavigationFor(_p(1280, 800, panel: SurfacePanelBinding.uncommissioned));
      expect(n.chromeVisible, isFalse);
      expect(n.frame, ShellFrame.none);
      expect(n.items, isEmpty);
      expect(n.controlEntry, ControlEntry.none);
    });

    test('only a room panel ever relabels Home', () {
      for (final s in [
        _p(390, 844),
        _p(2560, 1600, panel: SurfacePanelBinding.residence),
        _p(1280, 800, panel: SurfacePanelBinding.floor),
      ]) {
        expect(shellNavigationFor(s, boundSpaceName: 'Living Room').items.first.label,
            'Home');
      }
    });
  });

  group('the Control layer', () {
    test('phone held upright → bottom sheet', () {
      expect(shellNavigationFor(_p(390, 844)).controlPresentation,
          ControlLayerPresentation.sheet);
    });

    test('phone on its side → drawer', () {
      expect(shellNavigationFor(_p(844, 390)).controlPresentation,
          ControlLayerPresentation.drawer);
    });

    test('tablet, TV and desktop → drawer', () {
      for (final s in [
        _p(834, 1112),
        _p(1920, 1080, pointer: SurfacePointer.none, tv: true),
        _p(1440, 900, pointer: SurfacePointer.fine),
      ]) {
        expect(shellNavigationFor(s).controlPresentation,
            ControlLayerPresentation.drawer);
      }
    });

    test('unfolded across a vertical hinge → docked on the second segment', () {
      final n = shellNavigationFor(_p(884, 1104, features: const [
        SurfaceDisplayFeature(left: 430, top: 0, right: 454, bottom: 1104)
      ]));
      expect(n.controlPresentation, ControlLayerPresentation.secondSegment);
      expect(n.frame, ShellFrame.rail);
    });

    test('unfolded across a horizontal hinge → docked on the lower segment', () {
      final n = shellNavigationFor(_p(1104, 884, features: const [
        SurfaceDisplayFeature(left: 0, top: 430, right: 1104, bottom: 454)
      ]));
      expect(n.controlPresentation, ControlLayerPresentation.lowerSegment);
    });

    test('the fold cover is a compact phone: bar and sheet', () {
      final n = shellNavigationFor(_p(280, 653));
      expect(n.frame, ShellFrame.bottomBar);
      expect(n.controlPresentation, ControlLayerPresentation.sheet);
    });

    test('the watch presents it as a full sheet', () {
      expect(shellNavigationFor(_p(198, 242)).controlPresentation,
          ControlLayerPresentation.sheet);
    });
  });

  group('input', () {
    test('only a remote makes focus directional', () {
      expect(shellNavigationFor(_p(390, 844)).directionalFocus, isFalse);
      expect(
          shellNavigationFor(_p(1440, 900, pointer: SurfacePointer.fine))
              .directionalFocus,
          isFalse);
      expect(
          shellNavigationFor(
                  _p(1920, 1080, pointer: SurfacePointer.none, tv: true))
              .directionalFocus,
          isTrue);
    });
  });

  test('deterministic: the same profile always frames the same', () {
    final a = shellNavigationFor(_p(834, 1112));
    final b = shellNavigationFor(_p(834, 1112));
    expect(a.frame, b.frame);
    expect(a.items, b.items);
    expect(a.controlPresentation, b.controlPresentation);
  });
}
