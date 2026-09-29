import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The body of the Control layer (Golden Master: Control is a layer opened in the scope of where it
/// was called from, never a page). Its systems — Environment, Media, Protection — are built from
/// the Residence State read model in the next phases; until that exists it says so plainly instead
/// of drawing controls that would be fabricated.
class ControlLayerBody extends StatelessWidget {
  /// The scope's name — "Residence", a space's name, an Experience's name.
  final String scope;
  const ControlLayerBody({super.key, this.scope = 'Residence'});

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return Padding(
      key: const ValueKey('control-layer'),
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('CONTROL', style: text.kicker),
              SupremeTappable(
                key: const ValueKey('control-close'),
                onTap: () => Navigator.of(context).maybePop(),
                semanticLabel: 'Close control',
                radius: 22,
                child: const SizedBox(
                  width: 44,
                  height: 44,
                  child: Center(child: SupremeGlyph('close', size: 22)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(scope, style: text.pageTitle),
          const SizedBox(height: 20),
          Text('Nothing to adjust yet.',
              style: text.body.copyWith(color: SupremeColorScheme.text2)),
        ],
      ),
    );
  }
}
