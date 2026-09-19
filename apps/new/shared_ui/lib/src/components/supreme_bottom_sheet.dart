import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/adaptive_scope.dart';
import '../theme/supreme_colors.dart';

/// The one bottom-sheet presentation every screen uses for progressive
/// disclosure (§18 — advanced controls, not shown by default). Whether a
/// bottom sheet is even the right affordance for the current surface is an
/// [AdaptiveProfile] decision made by the caller (a MICRO panel's single
/// dominant action rarely wants a sheet); this helper only standardizes the
/// chrome once that decision is made.
Future<T?> showSupremeBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
}) {
  final spacing = AdaptiveScope.of(context).spacing;
  return showModalBottomSheet<T>(
    context: context,
    backgroundColor: SupremeColorScheme.surfaceRaised,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(spacing.radius(SupremeRadiusToken.xl)),
      ),
    ),
    builder: builder,
  );
}
