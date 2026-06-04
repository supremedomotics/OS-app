import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// The core Aureon interaction grammar (§11.1): a category/device tile whose
/// background *fills proportionally* to its value. Tap toggles; horizontal drag
/// sets the value. This is the "tile-as-control" pattern — a slider embedded in
/// the tile — used for lights, fans, awnings, covers, etc.
class FillTile extends StatefulWidget {
  const FillTile({
    super.key,
    required this.label,
    required this.value,
    required this.on,
    required this.onToggle,
    required this.onChanged,
    this.icon,
    this.subtitle,
  });

  /// Primary label, e.g. "Lights".
  final String label;

  /// Secondary line, e.g. "7 on" or "60%".
  final String? subtitle;

  /// Fill fraction 0..1.
  final double value;

  /// Whether the device is currently on (affects accent intensity).
  final bool on;

  final IconData? icon;

  /// Called on tap (toggle).
  final VoidCallback onToggle;

  /// Called continuously while dragging, with the new 0..1 value.
  final ValueChanged<double> onChanged;

  @override
  State<FillTile> createState() => _FillTileState();
}

class _FillTileState extends State<FillTile> {
  double? _dragValue;

  double get _display => _dragValue ?? widget.value;

  void _handleDrag(Offset localPosition, double width) {
    final next = (localPosition.dx / width).clamp(0.0, 1.0);
    setState(() => _dragValue = next);
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final accent = widget.on ? AureonGold.c500 : AureonBase.surfaceOverlay;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return GestureDetector(
          onTap: widget.onToggle,
          onHorizontalDragUpdate: (d) => _handleDrag(d.localPosition, width),
          onHorizontalDragEnd: (_) => setState(() => _dragValue = null),
          child: AnimatedContainer(
            duration: AureonMotion.fast,
            curve: AureonMotion.quietOut,
            height: 96,
            decoration: BoxDecoration(
              color: AureonBase.surfaceRaised,
              borderRadius: BorderRadius.circular(AureonRadius.md),
              border: Border.all(color: AureonBase.hairline),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              children: [
                // Proportional fill.
                FractionallySizedBox(
                  widthFactor: _display.clamp(0.0, 1.0),
                  alignment: Alignment.centerLeft,
                  child: AnimatedContainer(
                    duration: AureonMotion.fast,
                    color: accent.withValues(alpha: widget.on ? 0.32 : 0.18),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(AureonSpacing.md),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Icon(widget.icon ?? Icons.lightbulb_outline,
                          color:
                              widget.on ? AureonGold.c200 : AureonText.muted),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(widget.label,
                              style: Theme.of(context).textTheme.bodyLarge),
                          if (widget.subtitle != null)
                            Text(widget.subtitle!,
                                style: Theme.of(context).textTheme.labelMedium),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
