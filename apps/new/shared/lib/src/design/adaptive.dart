/// The adaptive layout engine's semantic model (§Phase7-5). No Flutter
/// dependency — this is pure classification logic over logical-pixel (dp)
/// dimensions, so it's testable without a widget tree and reusable if a Web
/// Homeowner app ever needs the same decisions. The Flutter binding
/// (`supreme_os_ui`'s `AdaptiveScope`) is a thin wrapper that reads
/// `MediaQuery` and calls straight into this file.
///
/// HONEST LIMITATION: dp width/height is a proxy for physical screen size,
/// not a measurement of it — a real Touch Panel's actual diagonal is known
/// at provisioning time (it's part of the panel's registered hardware
/// model, §9-10) and should override this heuristic once that plumbing
/// exists (`physicalSizeInchesHint` below is the seam for that). Until then,
/// classification is by logical width, which is the best available signal
/// and is still centralized/semantic rather than scattered `if width < X`
/// checks per screen.
library;

import 'tokens.dart';

enum AdaptiveOrientation { portrait, landscape }

/// General device/density classification shared by Mobile, Touch Panel and
/// (later) Web — NOT the Touch-Panel-specific presentation modes below.
enum DeviceClass { phone, tablet, desktop }

/// Touch Panel presentation modes (§Phase7-6) — semantic, not raw device
/// categories. A single 10" panel can be STANDARD in portrait and use a
/// different [LayoutComposition] in landscape; the mode name describes the
/// physical surface, composition describes what it does with it.
enum PanelPresentationMode { micro, compact, standard, expanded, immersive }

enum InformationCapacity { minimal, compact, standard, rich, expansive }

/// What a component is allowed to decide once it knows the profile
/// (§Phase7-5's bullet list): whether to show navigation, whether controls
/// stack or grid, whether a bottom sheet or full-screen control fits.
enum LayoutComposition {
  singleDominantAction,
  stackedControls,
  gridControls,
  sidePanels,
}

/// The resolved, semantic description of "what kind of surface is this,
/// right now" — everything a component needs to compose itself, and nothing
/// it should compute itself from raw width/height (§Phase7-5).
class AdaptiveProfile {
  final double widthDp;
  final double heightDp;
  final AdaptiveOrientation orientation;
  final DeviceClass deviceClass;
  final PanelPresentationMode panelMode;
  final InformationCapacity capacity;
  final LayoutComposition composition;
  final SupremeDensity density;

  const AdaptiveProfile({
    required this.widthDp,
    required this.heightDp,
    required this.orientation,
    required this.deviceClass,
    required this.panelMode,
    required this.capacity,
    required this.composition,
    required this.density,
  });

  double get shortestSideDp => widthDp < heightDp ? widthDp : heightDp;

  /// Minimum touch target edge length for this profile (§Phase7-4) — a
  /// semantic size, never a literal constant scattered across widgets.
  /// Small panels get the largest targets (approached up close, one action
  /// at a time); larger panels assume more controls coexist and a slightly
  /// smaller (but still touch-friendly) target.
  double get minTouchTarget => switch (panelMode) {
        PanelPresentationMode.micro => 72,
        PanelPresentationMode.compact => 64,
        PanelPresentationMode.standard => 56,
        PanelPresentationMode.expanded => 52,
        PanelPresentationMode.immersive => 48,
      };

  SupremeSpacingResolver get spacing => SupremeSpacingResolver(density);
}

/// The classifier (§Phase7-5, §Phase7-6). `widthDp`/`heightDp` are logical
/// pixels (Flutter's `MediaQuery.size`, already density-normalized).
AdaptiveProfile classifyAdaptive({
  required double widthDp,
  required double heightDp,
  double? physicalSizeInchesHint,
}) {
  final orientation = widthDp >= heightDp
      ? AdaptiveOrientation.landscape
      : AdaptiveOrientation.portrait;
  final shortestSide = widthDp < heightDp ? widthDp : heightDp;

  final panelMode = _classifyPanelMode(shortestSide, physicalSizeInchesHint);
  final deviceClass = _classifyDeviceClass(shortestSide);
  final density = _densityFor(panelMode, deviceClass);
  final capacity = _capacityFor(panelMode, orientation);
  final composition = _compositionFor(panelMode, orientation, capacity);

  return AdaptiveProfile(
    widthDp: widthDp,
    heightDp: heightDp,
    orientation: orientation,
    deviceClass: deviceClass,
    panelMode: panelMode,
    capacity: capacity,
    composition: composition,
    density: density,
  );
}

PanelPresentationMode _classifyPanelMode(
    double shortestSideDp, double? physicalHint) {
  if (physicalHint != null) {
    if (physicalHint <= 4) return PanelPresentationMode.micro;
    if (physicalHint <= 7) return PanelPresentationMode.compact;
    if (physicalHint <= 12) return PanelPresentationMode.standard;
    if (physicalHint <= 20) return PanelPresentationMode.expanded;
    return PanelPresentationMode.immersive;
  }
  // dp-width heuristic bands, calibrated so a phone-in-hand lands COMPACT
  // and a wall panel/large display lands EXPANDED/IMMERSIVE.
  if (shortestSideDp < 280) return PanelPresentationMode.micro;
  if (shortestSideDp < 500) return PanelPresentationMode.compact;
  if (shortestSideDp < 840) return PanelPresentationMode.standard;
  if (shortestSideDp < 1400) return PanelPresentationMode.expanded;
  return PanelPresentationMode.immersive;
}

DeviceClass _classifyDeviceClass(double shortestSideDp) {
  // Mirrors Material's own phone/tablet dp convention (600dp) rather than
  // inventing a new breakpoint (ladder rung 2/3 — reuse a known convention).
  if (shortestSideDp < 600) return DeviceClass.phone;
  if (shortestSideDp < 1200) return DeviceClass.tablet;
  return DeviceClass.desktop;
}

SupremeDensity _densityFor(
    PanelPresentationMode mode, DeviceClass deviceClass) {
  return switch (mode) {
    PanelPresentationMode.micro => SupremeDensity.compact,
    PanelPresentationMode.compact => SupremeDensity.compact,
    PanelPresentationMode.standard => SupremeDensity.comfortable,
    PanelPresentationMode.expanded => SupremeDensity.expanded,
    PanelPresentationMode.immersive => SupremeDensity.immersive,
  };
}

InformationCapacity _capacityFor(
    PanelPresentationMode mode, AdaptiveOrientation orientation) {
  final base = switch (mode) {
    PanelPresentationMode.micro => InformationCapacity.minimal,
    PanelPresentationMode.compact => InformationCapacity.compact,
    PanelPresentationMode.standard => InformationCapacity.standard,
    PanelPresentationMode.expanded => InformationCapacity.rich,
    PanelPresentationMode.immersive => InformationCapacity.expansive,
  };
  // Landscape buys more horizontal room to show side-by-side content even
  // at a mode that would otherwise be more conservative in portrait.
  if (orientation == AdaptiveOrientation.landscape &&
      base == InformationCapacity.standard) {
    return InformationCapacity.rich;
  }
  return base;
}

LayoutComposition _compositionFor(
  PanelPresentationMode mode,
  AdaptiveOrientation orientation,
  InformationCapacity capacity,
) {
  return switch (mode) {
    PanelPresentationMode.micro => LayoutComposition.singleDominantAction,
    PanelPresentationMode.compact => LayoutComposition.stackedControls,
    PanelPresentationMode.standard =>
      orientation == AdaptiveOrientation.landscape
          ? LayoutComposition.gridControls
          : LayoutComposition.stackedControls,
    PanelPresentationMode.expanded => LayoutComposition.sidePanels,
    PanelPresentationMode.immersive => LayoutComposition.sidePanels,
  };
}
