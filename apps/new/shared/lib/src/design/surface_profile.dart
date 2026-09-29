/// The ONE authority on what physical surface SupremeOS is running on
/// (§ Responsive Interaction Grammar — "Invariant: one SurfaceProfile").
///
/// Raw surface inputs (size, pointer, TV signal, hinge geometry, installed panel role) are
/// interpreted HERE and nowhere else; every screen consumes the resulting [SurfaceProfile].
/// Pure Dart with no Flutter dependency, so the whole surface matrix is testable without a
/// widget tree. `supreme_os_ui`'s `SurfaceScope` is the only code that gathers the raw inputs.
///
/// Authority order — the first rule that decides, decides:
///   1. installed role   an installed panel is a panel at every size
///   2. input method     a remote means distance (a TV is not a large desktop)
///   3. fold             an open foldable has two places; its cover is a compact surface
///   4. dimensions       only then size
///
/// The surface decides presentation, never truth: nothing here touches residence state.
library;

import 'dart:math' as math;

import '../touchpanel/provisioning.dart';

enum SurfaceRole {
  personal,
  roomPanel,

  /// Production keeps floor scope (`ControlScope.floor`); the grammar has no floor role, so it is
  /// its own role here. It behaves like the other installed panels for mode/density.
  floorPanel,
  residencePanel,
  uncommissionedPanel,
}

/// What an installed panel is bound to. `null` in [SurfaceInputs.installedPanel] means the
/// device is personal (a phone, tablet, watch, TV or desktop) and has no binding at all.
enum SurfacePanelBinding {
  room,
  floor,
  residence,
  uncommissioned;

  /// Production [ControlScope] → surface binding. `wholeHome` is the grammar's "residence".
  static SurfacePanelBinding forScope(ControlScope scope) => switch (scope) {
        ControlScope.room => SurfacePanelBinding.room,
        ControlScope.floor => SurfacePanelBinding.floor,
        ControlScope.wholeHome => SurfacePanelBinding.residence,
      };
}

enum SurfaceInput { touch, pointer, remote }

/// The primary pointing device as the platform reports it (raw input, not a classification).
enum SurfacePointer { coarse, fine, none }

enum SurfaceFormFactor { watch, phone, foldable, tablet, panel, desktop, tv }

/// How SupremeOS behaves on the surface.
enum SurfaceMode { glance, compact, focused, spatial, expansive, distance }

enum SurfaceDistance { wrist, hand, arm, far }

enum SurfaceOrientation { portrait, landscape }

/// The layout frame — a pure function of [SurfaceMode]. It frames the page; it decides nothing.
enum SurfaceSkeleton { watch, phone, tablet, desktop, tv }

/// P0 critical · P1 primary · P2 contextual · P3 secondary · P4 technical (SupremeOS Pro only).
enum ContentPriority { p0, p1, p2, p3, p4 }

enum SurfaceAuthority { role, input, fold, foldCover, dimensions }

enum SurfaceFoldAxis {
  /// Hinge runs top-to-bottom: two segments side by side.
  vertical,

  /// Hinge runs left-to-right ("book"): two segments stacked.
  horizontal,
}

/// The hinge, in logical pixels along its axis: nothing interactive or written may sit between
/// [start] and [end].
class SurfaceFold {
  final SurfaceFoldAxis axis;
  final double start;
  final double end;
  const SurfaceFold(
      {required this.axis, required this.start, required this.end});

  @override
  bool operator ==(Object other) =>
      other is SurfaceFold &&
      other.axis == axis &&
      other.start == start &&
      other.end == end;

  @override
  int get hashCode => Object.hash(axis, start, end);

  @override
  String toString() => 'SurfaceFold($axis, $start–$end)';
}

/// A hinge/fold reported by the platform, as a rectangle in logical pixels. Notches and
/// cutouts are not folds and must not be passed in.
class SurfaceDisplayFeature {
  final double left, top, right, bottom;
  const SurfaceDisplayFeature(
      {required this.left,
      required this.top,
      required this.right,
      required this.bottom});
}

/// Everything raw the classifier may read.
class SurfaceInputs {
  final double widthDp;
  final double heightDp;
  final SurfacePointer pointer;

  /// A platform-level TV signal (e.g. Android `UI_MODE_TYPE_TELEVISION`). `false` until a
  /// platform bridge supplies it — a TV is never guessed from size alone.
  final bool isTelevision;
  final SurfacePanelBinding? installedPanel;

  /// The diagonal an installed panel registered at provisioning. Beats the dp heuristic for
  /// panels — dp is a proxy for size, the registered hardware model is a measurement.
  final double? physicalSizeInches;
  final List<SurfaceDisplayFeature> displayFeatures;

  const SurfaceInputs({
    required this.widthDp,
    required this.heightDp,
    this.pointer = SurfacePointer.coarse,
    this.isTelevision = false,
    this.installedPanel,
    this.physicalSizeInches,
    this.displayFeatures = const [],
  });
}

class SurfaceProfile {
  final SurfaceRole role;
  final SurfaceInput input;
  final SurfaceFold? fold;
  final SurfaceFormFactor formFactor;
  final SurfaceMode mode;
  final SurfaceDistance distance;
  final SurfaceOrientation orientation;
  final SurfaceSkeleton skeleton;
  final ContentPriority maxPriority;

  /// Large canvases compose at a logical size and scale, so type and targets keep proportions.
  final double zoom;

  /// Which authority rule decided — for diagnostics and tests, never for layout.
  final SurfaceAuthority decidedBy;
  final double widthDp;
  final double heightDp;

  const SurfaceProfile({
    required this.role,
    required this.input,
    required this.fold,
    required this.formFactor,
    required this.mode,
    required this.distance,
    required this.orientation,
    required this.skeleton,
    required this.maxPriority,
    required this.zoom,
    required this.decidedBy,
    required this.widthDp,
    required this.heightDp,
  });

  bool get isInstalledPanel => role != SurfaceRole.personal;

  /// Content disappears because it is less meaningful on this surface, never because of a
  /// breakpoint: P4 is never shown to a homeowner on any surface.
  bool shows(ContentPriority priority) =>
      priority.index <= maxPriority.index && priority != ContentPriority.p4;

  @override
  bool operator ==(Object other) =>
      other is SurfaceProfile &&
      other.role == role &&
      other.input == input &&
      other.fold == fold &&
      other.formFactor == formFactor &&
      other.mode == mode &&
      other.distance == distance &&
      other.orientation == orientation &&
      other.skeleton == skeleton &&
      other.maxPriority == maxPriority &&
      other.zoom == zoom &&
      other.decidedBy == decidedBy &&
      other.widthDp == widthDp &&
      other.heightDp == heightDp;

  @override
  int get hashCode => Object.hash(role, input, fold, formFactor, mode, distance,
      orientation, skeleton, maxPriority, zoom, decidedBy, widthDp, heightDp);

  @override
  String toString() =>
      'SurfaceProfile($role · $formFactor · $mode · $input · $distance · $decidedBy)';
}

const _maxPriorityByMode = {
  SurfaceMode.glance: ContentPriority.p0,
  SurfaceMode.compact: ContentPriority.p1,
  SurfaceMode.focused: ContentPriority.p2,
  SurfaceMode.spatial: ContentPriority.p3,
  SurfaceMode.expansive: ContentPriority.p3,
  SurfaceMode.distance: ContentPriority.p2,
};

const _skeletonByMode = {
  SurfaceMode.glance: SurfaceSkeleton.watch,
  SurfaceMode.compact: SurfaceSkeleton.phone,
  SurfaceMode.focused: SurfaceSkeleton.phone,
  SurfaceMode.spatial: SurfaceSkeleton.tablet,
  SurfaceMode.expansive: SurfaceSkeleton.desktop,
  SurfaceMode.distance: SurfaceSkeleton.tv,
};

/// The classifier: a pure function — the same inputs always give the same profile.
SurfaceProfile surfaceProfileOf(SurfaceInputs x) {
  final w = x.widthDp, h = x.heightDp;
  final long = math.max(w, h), short = math.min(w, h);
  final panel = x.installedPanel;

  final role = switch (panel) {
    null => SurfaceRole.personal,
    SurfacePanelBinding.room => SurfaceRole.roomPanel,
    SurfacePanelBinding.floor => SurfaceRole.floorPanel,
    SurfacePanelBinding.residence => SurfaceRole.residencePanel,
    SurfacePanelBinding.uncommissioned => SurfaceRole.uncommissionedPanel,
  };

  final input = (x.isTelevision || (x.pointer == SurfacePointer.none && w >= 1280))
      ? SurfaceInput.remote
      : x.pointer == SurfacePointer.coarse
          ? SurfaceInput.touch
          : SurfaceInput.pointer;

  final fold = _foldOf(x);
  final SurfaceMode mode;
  final SurfaceFormFactor formFactor;
  final SurfaceAuthority decidedBy;

  if (panel != null) {
    decidedBy = SurfaceAuthority.role;
    formFactor = SurfaceFormFactor.panel;
    mode = input == SurfaceInput.remote
        ? SurfaceMode.distance
        : _panelMode(x.physicalSizeInches, long, short);
  } else if (input == SurfaceInput.remote) {
    decidedBy = SurfaceAuthority.input;
    formFactor = SurfaceFormFactor.tv;
    mode = SurfaceMode.distance;
  } else if (fold != null) {
    decidedBy = SurfaceAuthority.fold;
    formFactor = SurfaceFormFactor.foldable;
    mode = SurfaceMode.spatial;
  } else if (short <= 300 && long >= 560) {
    decidedBy = SurfaceAuthority.foldCover;
    formFactor = SurfaceFormFactor.foldable;
    mode = SurfaceMode.compact;
  } else {
    decidedBy = SurfaceAuthority.dimensions;
    if (long <= 320 || short < 260) {
      formFactor = SurfaceFormFactor.watch;
      mode = SurfaceMode.glance;
    } else if (w < 640 || (h < 500 && w < 1000)) {
      formFactor = SurfaceFormFactor.phone;
      mode = SurfaceMode.focused;
    } else if (w < 1180 || (x.pointer == SurfacePointer.coarse && w < 1500)) {
      formFactor = SurfaceFormFactor.tablet;
      mode = SurfaceMode.spatial;
    } else {
      formFactor = SurfaceFormFactor.desktop;
      mode = SurfaceMode.expansive;
    }
  }

  final distance = mode == SurfaceMode.distance
      ? SurfaceDistance.far
      : mode == SurfaceMode.glance
          ? SurfaceDistance.wrist
          : panel != null
              ? SurfaceDistance.arm
              : SurfaceDistance.hand;

  final zoom = mode == SurfaceMode.distance
      ? math.max(1.0, math.min(w / 1440, h / 810))
      : mode == SurfaceMode.expansive && w > 1800 && h > 950
          ? math.min(2.2, math.min(w / 1600, h / 900))
          : 1.0;

  return SurfaceProfile(
    role: role,
    input: input,
    fold: fold,
    formFactor: formFactor,
    mode: mode,
    distance: distance,
    orientation:
        w >= h ? SurfaceOrientation.landscape : SurfaceOrientation.portrait,
    skeleton: _skeletonByMode[mode]!,
    maxPriority: _maxPriorityByMode[mode]!,
    zoom: zoom,
    decidedBy: decidedBy,
    widthDp: w,
    heightDp: h,
  );
}

/// Installed panels: the registered diagonal wins; without it, the dp bands the reference
/// implementation uses (a 3–4" panel is far under 720 dp on its long side, a 7" one is not).
/// Grammar bands: 3–5" compact · 7–15" spatial · 15–30" expansive; a 5–7" panel has no band in
/// the grammar and stays compact (a room panel is not a phone).
SurfaceMode _panelMode(double? inches, double long, double short) {
  if (inches != null) {
    if (inches < 7) return SurfaceMode.compact;
    if (inches < 15) return SurfaceMode.spatial;
    return SurfaceMode.expansive;
  }
  if (long <= 720) return SurfaceMode.compact;
  if (long < 1500 || (short <= 900 && long < 1700)) return SurfaceMode.spatial;
  return SurfaceMode.expansive;
}

SurfaceFold? _foldOf(SurfaceInputs x) {
  for (final f in x.displayFeatures) {
    final fw = f.right - f.left, fh = f.bottom - f.top;
    if (fw < 0 || fh < 0) continue;
    return fh >= fw
        ? SurfaceFold(
            axis: SurfaceFoldAxis.vertical, start: f.left, end: f.right)
        : SurfaceFold(
            axis: SurfaceFoldAxis.horizontal, start: f.top, end: f.bottom);
  }
  return null;
}
