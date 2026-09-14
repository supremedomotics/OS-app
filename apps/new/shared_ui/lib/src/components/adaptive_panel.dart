import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/adaptive_scope.dart';

/// Composes [children] according to the CURRENT [AdaptiveProfile]'s
/// [LayoutComposition] (§Phase7-5) — this is the reusable answer to "should
/// controls stack or grid or sit in side panels," decided once here instead
/// of duplicated per-screen `if` chains. A screen that needs a single
/// dominant action passes exactly one child and [singleDominantActionChild]
/// selects it; everything else composes the full list.
class AdaptivePanel extends StatelessWidget {
  final List<Widget> children;
  final int gridColumns;

  const AdaptivePanel(
      {super.key, required this.children, this.gridColumns = 2});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final spacing = profile.spacing.space(SupremeSpaceToken.md);

    return switch (profile.composition) {
      LayoutComposition.singleDominantAction => children.isEmpty
          ? const SizedBox.shrink()
          : Center(child: children.first),
      LayoutComposition.stackedControls => ListView.separated(
          padding: EdgeInsets.all(spacing),
          itemCount: children.length,
          separatorBuilder: (_, __) => SizedBox(height: spacing),
          itemBuilder: (_, i) => children[i],
        ),
      LayoutComposition.gridControls => GridView.count(
          padding: EdgeInsets.all(spacing),
          crossAxisCount: gridColumns,
          mainAxisSpacing: spacing,
          crossAxisSpacing: spacing,
          childAspectRatio: 1.6,
          children: children,
        ),
      LayoutComposition.sidePanels => Padding(
          padding: EdgeInsets.all(spacing),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < children.length; i++) ...[
                Expanded(child: children[i]),
                if (i != children.length - 1) SizedBox(width: spacing),
              ],
            ],
          ),
        ),
    };
  }
}
