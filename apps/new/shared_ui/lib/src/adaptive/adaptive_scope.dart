import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import 'surface_scope.dart';

/// COMPATIBILITY ADAPTER — the legacy [AdaptiveProfile] view, derived from the one
/// [SurfaceProfile]. New code reads `SurfaceScope.of(context)`; this stays only until every
/// consumer has migrated (then `AdaptiveProfile`, `DeviceClass` and `PanelPresentationMode`
/// can go).
///
/// It no longer reads `MediaQuery` itself: it uses the [SurfaceScope] above it, or creates one
/// when the app root has none, so the raw inputs are still read in exactly one place.
/// `physicalSizeInchesHint` only applies when this widget creates the [SurfaceScope]; an
/// ancestor [SurfaceScope] is authoritative.
class AdaptiveScope extends StatelessWidget {
  final Widget child;
  final double? physicalSizeInchesHint;

  const AdaptiveScope(
      {super.key, required this.child, this.physicalSizeInchesHint});

  static AdaptiveProfile of(BuildContext context) {
    final profile = context
        .dependOnInheritedWidgetOfExactType<_AdaptiveProfileProvider>()
        ?.profile;
    assert(
        profile != null, 'AdaptiveScope.of() called outside an AdaptiveScope');
    return profile!;
  }

  @override
  Widget build(BuildContext context) {
    final adapted = Builder(builder: (context) {
      final surface = SurfaceScope.of(context);
      final profile = classifyAdaptive(
        widthDp: surface.widthDp,
        heightDp: surface.heightDp,
        physicalSizeInchesHint: physicalSizeInchesHint,
      );
      return _AdaptiveProfileProvider(profile: profile, child: child);
    });
    if (SurfaceScope.maybeOf(context) != null) return adapted;
    return SurfaceScope(
        physicalSizeInches: physicalSizeInchesHint, child: adapted);
  }
}

class _AdaptiveProfileProvider extends InheritedWidget {
  final AdaptiveProfile profile;
  const _AdaptiveProfileProvider({required this.profile, required super.child});

  @override
  bool updateShouldNotify(_AdaptiveProfileProvider oldWidget) =>
      oldWidget.profile != profile;
}
