import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Reads `MediaQuery` once and exposes the resolved [AdaptiveProfile] to the
/// subtree via `AdaptiveScope.of(context)`. This is the ONLY place
/// `MediaQuery.size` should be read for layout decisions — every component
/// below asks the profile "what composition/capacity/touch target," never
/// re-derives it from raw pixels itself (§Phase7-5).
///
/// `physicalSizeInchesHint` lets a Touch Panel that knows its own registered
/// hardware size (§9-10) override the dp heuristic — wire it from the
/// panel's `PanelConfig`/registry entry once that plumbing exists.
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
    final size = MediaQuery.sizeOf(context);
    final profile = classifyAdaptive(
      widthDp: size.width,
      heightDp: size.height,
      physicalSizeInchesHint: physicalSizeInchesHint,
    );
    return _AdaptiveProfileProvider(profile: profile, child: child);
  }
}

class _AdaptiveProfileProvider extends InheritedWidget {
  final AdaptiveProfile profile;
  const _AdaptiveProfileProvider({required this.profile, required super.child});

  @override
  bool updateShouldNotify(_AdaptiveProfileProvider oldWidget) =>
      oldWidget.profile != profile;
}
