import 'dart:ui' show DisplayFeatureType;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// The ONLY place Flutter's raw surface inputs (`MediaQuery` size and display features, the
/// platform's pointer) are read. It hands them to `surfaceProfileOf` and publishes the resulting
/// [SurfaceProfile] to the subtree; nothing below may classify a surface itself
/// (§ Responsive Interaction Grammar — one SurfaceProfile). `test/surface_authority_test.dart`
/// enforces that.
///
/// The installed panel role (`installedPanel`, `physicalSizeInches`) is identity, not something
/// this widget can sense: the panel host passes it from the commissioned `PanelConfig`.
/// `isTelevision` stays `false` until a platform bridge reports it — a TV is never guessed
/// from size.
class SurfaceScope extends StatelessWidget {
  final Widget child;
  final SurfacePanelBinding? installedPanel;
  final double? physicalSizeInches;
  final bool isTelevision;

  /// Overrides the platform default. Desktop-OS touch panels report a fine pointer by default;
  /// a panel host that knows it is touch-only passes [SurfacePointer.coarse].
  final SurfacePointer? pointer;

  const SurfaceScope({
    super.key,
    required this.child,
    this.installedPanel,
    this.physicalSizeInches,
    this.isTelevision = false,
    this.pointer,
  });

  static SurfaceProfile? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_SurfaceProfileProvider>()
      ?.profile;

  static SurfaceProfile of(BuildContext context) {
    final profile = maybeOf(context);
    assert(profile != null, 'SurfaceScope.of() called outside a SurfaceScope');
    return profile!;
  }

  static SurfacePointer _platformPointer() => switch (defaultTargetPlatform) {
        TargetPlatform.android ||
        TargetPlatform.iOS ||
        TargetPlatform.fuchsia =>
          SurfacePointer.coarse,
        _ => SurfacePointer.fine,
      };

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final features = MediaQuery.displayFeaturesOf(context)
        .where((f) =>
            f.type == DisplayFeatureType.hinge ||
            f.type == DisplayFeatureType.fold)
        .map((f) => SurfaceDisplayFeature(
            left: f.bounds.left,
            top: f.bounds.top,
            right: f.bounds.right,
            bottom: f.bounds.bottom))
        .toList(growable: false);

    final profile = surfaceProfileOf(SurfaceInputs(
      widthDp: size.width,
      heightDp: size.height,
      pointer: pointer ?? _platformPointer(),
      isTelevision: isTelevision,
      installedPanel: installedPanel,
      physicalSizeInches: physicalSizeInches,
      displayFeatures: features,
    ));
    return _SurfaceProfileProvider(profile: profile, child: child);
  }
}

class _SurfaceProfileProvider extends InheritedWidget {
  final SurfaceProfile profile;
  const _SurfaceProfileProvider(
      {required this.profile, required super.child});

  @override
  bool updateShouldNotify(_SurfaceProfileProvider oldWidget) =>
      oldWidget.profile != profile;
}

/// Forces reduced motion for everything beneath it when [reduce] is set (a device preference),
/// on top of whatever the OS already asks for. Lives here because this file is the only place
/// allowed to read the raw `MediaQueryData` (see `test/surface_authority_test.dart`).
class MotionScope extends StatelessWidget {
  final bool reduce;
  final Widget child;
  const MotionScope({super.key, required this.reduce, required this.child});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return MediaQuery(
        data: mq.copyWith(disableAnimations: mq.disableAnimations || reduce),
        child: child);
  }
}
