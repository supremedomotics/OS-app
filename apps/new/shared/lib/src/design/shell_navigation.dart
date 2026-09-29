/// How the SupremeOS navigation is framed on each physical surface — a pure function of the one
/// [SurfaceProfile] (§ Responsive Interaction Grammar §5 "Navigation adaptation").
///
/// The information architecture never changes: Home · Spaces · Control · Experiences · Settings.
/// The surface only decides the *frame* and where Control is entered from. Nothing here reads a
/// width, an orientation of its own, or a platform: every input is on [SurfaceProfile], so the
/// surface authority stays single (see `test/surface_authority_test.dart`).
///
/// Derived from the Golden Master (`docs/design/golden-master-implementation-map.md` §1):
/// phone → bottom bar with a ringed centre Control (a side rail when held on its side) ·
/// tablet and TV → a left rail with Control in it ·
/// desktop → a top pill group plus a separate "Residence control" button · watch → no navigation,
/// Home's glance list carries the ways in. Control itself is a *layer* opened in context, not a page.
library;

import 'surface_profile.dart';

enum ShellDestination { home, spaces, control, experiences, settings }

enum ShellFrame { none, bottomBar, rail, topBar }

/// Where Control is entered from on this surface.
enum ControlEntry {
  /// A nav item (phone bar centre, tablet/TV rail).
  navItem,

  /// A separate button in the header (desktop): the nav group itself has no Control item.
  headerButton,

  /// A link in Home's glance list (watch).
  glanceLink,

  /// The chrome is hidden (an uncommissioned panel is asking to be commissioned).
  none,
}

/// How the Control layer is presented over the page.
enum ControlLayerPresentation {
  /// A bottom sheet — a hand-held phone held upright.
  sheet,

  /// A right-hand drawer.
  drawer,

  /// Unfolded across a vertical hinge: docked on the second segment; nothing crosses the hinge.
  secondSegment,

  /// Unfolded across a horizontal hinge: docked on the lower segment.
  lowerSegment,
}

class ShellNavItem {
  final ShellDestination destination;

  /// The visible label.
  final String label;

  /// The full accessible name — differs from [label] only where the label is shortened
  /// (a room panel's Home reads "Living" but is named "Living Room").
  final String semanticLabel;

  const ShellNavItem(this.destination, this.label, [String? semanticLabel])
      : semanticLabel = semanticLabel ?? label;

  @override
  bool operator ==(Object other) =>
      other is ShellNavItem &&
      other.destination == destination &&
      other.label == label &&
      other.semanticLabel == semanticLabel;

  @override
  int get hashCode => Object.hash(destination, label, semanticLabel);

  @override
  String toString() => 'ShellNavItem(${destination.name}, $label)';
}

class ShellNavigation {
  final ShellFrame frame;

  /// The items the frame lists, in order. Excludes Control where it is not a nav item.
  final List<ShellNavItem> items;
  final ControlEntry controlEntry;
  final ControlLayerPresentation controlPresentation;

  /// Directional (remote / D-pad) focus is the input method: focus is always visible and stays in
  /// the top-most layer.
  final bool directionalFocus;

  /// False while an uncommissioned panel is being commissioned: its chrome must not show.
  final bool chromeVisible;

  const ShellNavigation({
    required this.frame,
    required this.items,
    required this.controlEntry,
    required this.controlPresentation,
    required this.directionalFocus,
    required this.chromeVisible,
  });

  bool has(ShellDestination d) => items.any((i) => i.destination == d);
}

/// [boundSpaceName] is the room an installed *room* panel is bound to; it is only used to label
/// that panel's Home item, because on a room panel its room is Home.
ShellNavigation shellNavigationFor(SurfaceProfile p, {String? boundSpaceName}) {
  final presentation = _presentation(p);
  final directional = p.input == SurfaceInput.remote;

  if (p.role == SurfaceRole.uncommissionedPanel) {
    return ShellNavigation(
      frame: ShellFrame.none,
      items: const [],
      controlEntry: ControlEntry.none,
      controlPresentation: presentation,
      directionalFocus: directional,
      chromeVisible: false,
    );
  }

  final roomPanel = p.role == SurfaceRole.roomPanel;
  final home = roomPanel && boundSpaceName != null && boundSpaceName.isNotEmpty
      ? ShellNavItem(ShellDestination.home, _roomHomeLabel(boundSpaceName),
          boundSpaceName)
      : const ShellNavItem(ShellDestination.home, 'Home');

  // A room panel never lists Spaces: its room is Home. (Floor panels keep it — owner decision D1
  // in the implementation map — and there is no floor navigation layer.)
  final spaces = roomPanel
      ? null
      : const ShellNavItem(ShellDestination.spaces, 'Spaces');
  const control = ShellNavItem(ShellDestination.control, 'Control');
  const experiences =
      ShellNavItem(ShellDestination.experiences, 'Experiences');
  const settings = ShellNavItem(ShellDestination.settings, 'Settings');

  switch (p.skeleton) {
    case SurfaceSkeleton.watch:
      return ShellNavigation(
        frame: ShellFrame.none,
        items: const [],
        controlEntry: ControlEntry.glanceLink,
        controlPresentation: presentation,
        directionalFocus: directional,
        chromeVisible: true,
      );
    case SurfaceSkeleton.desktop:
      return ShellNavigation(
        frame: ShellFrame.topBar,
        items: [home, if (spaces != null) spaces, experiences, settings],
        controlEntry: ControlEntry.headerButton,
        controlPresentation: presentation,
        directionalFocus: directional,
        chromeVisible: true,
      );
    case SurfaceSkeleton.phone:
    case SurfaceSkeleton.tablet:
    case SurfaceSkeleton.tv:
      return ShellNavigation(
        // A phone held on its side moves the bar to the side "so the photo keeps its height".
        frame: p.skeleton == SurfaceSkeleton.phone &&
                p.orientation == SurfaceOrientation.portrait
            ? ShellFrame.bottomBar
            : ShellFrame.rail,
        items: [
          home,
          if (spaces != null) spaces,
          control,
          experiences,
          settings,
        ],
        controlEntry: ControlEntry.navItem,
        controlPresentation: presentation,
        directionalFocus: directional,
        chromeVisible: true,
      );
  }
}

ControlLayerPresentation _presentation(SurfaceProfile p) {
  final fold = p.fold;
  if (fold != null) {
    return fold.axis == SurfaceFoldAxis.vertical
        ? ControlLayerPresentation.secondSegment
        : ControlLayerPresentation.lowerSegment;
  }
  if (p.skeleton == SurfaceSkeleton.watch) return ControlLayerPresentation.sheet;
  if (p.skeleton == SurfaceSkeleton.phone &&
      p.orientation == SurfaceOrientation.portrait) {
    return ControlLayerPresentation.sheet;
  }
  return ControlLayerPresentation.drawer;
}

/// "Living Room" → "Living": the Golden Master drops a trailing "Room" so the label fits the bar.
String _roomHomeLabel(String space) {
  final t = space.trim();
  final short = t.replaceFirst(RegExp(r'\s+room$', caseSensitive: false), '');
  return short.isEmpty ? t : short;
}
