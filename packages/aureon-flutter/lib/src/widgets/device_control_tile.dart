import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Ovio "tile-as-control" device row (§11.1): a horizontal tile with an icon + name on
/// the left, a value on the right, and a background that fills proportionally to the
/// value. Three distinct, unambiguous gestures instead of overloading tap:
///   - tap toggles on/off ([onToggle], falling back to [onTap] if unset, for callers that
///     haven't migrated — a plain toggle-less tile with no natural on/off still works via [onTap]);
///   - horizontal drag (when [slidable]) sets the value live, showing it as it moves;
///   - a small trailing chevron (shown only when [onOpenDetail] is set) opens the full detail.
/// The chevron is a genuine SIBLING outside the tile's own gesture region (not nested inside it) —
/// nested `GestureDetector`s in Flutter don't reliably suppress the outer one's `onTap`, so nesting
/// the chevron there would have fired both the toggle AND the detail-open on every chevron tap.
/// Theme aware (renders in Luxury Black + Luxury White).
class DeviceControlTile extends StatefulWidget {
  const DeviceControlTile({
    super.key,
    required this.icon,
    required this.name,
    required this.valueLabel,
    required this.fill,
    required this.on,
    required this.slidable,
    this.onChanged,
    this.onTap,
    this.onToggle,
    this.onOpenDetail,
  });

  final IconData icon;
  final String name;
  final String valueLabel;
  final double fill;
  final bool on;
  final bool slidable;
  final ValueChanged<double>? onChanged;
  final VoidCallback? onTap;
  final VoidCallback? onToggle;
  final VoidCallback? onOpenDetail;

  @override
  State<DeviceControlTile> createState() => _DeviceControlTileState();
}

class _DeviceControlTileState extends State<DeviceControlTile> {
  double? _drag;
  bool _moved = false;

  double get _display => _drag ?? widget.fill;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final surface = Theme.of(context).cardTheme.color ?? scheme.surface;
    final tapAction = widget.onToggle ?? widget.onTap;

    final tile = LayoutBuilder(
      builder: (context, c) {
        final width = c.maxWidth;
        void setFromDx(double dx) {
          setState(() => _drag = (dx / width).clamp(0.0, 1.0));
          widget.onChanged?.call(_drag!);
        }

        return GestureDetector(
          onTap: tapAction,
          onHorizontalDragStart: widget.slidable ? (d) { _moved = false; setFromDx(d.localPosition.dx); } : null,
          onHorizontalDragUpdate: widget.slidable ? (d) { _moved = true; setFromDx(d.localPosition.dx); } : null,
          onHorizontalDragEnd: widget.slidable
              ? (_) {
                  setState(() => _drag = null);
                  if (!_moved) tapAction?.call();
                }
              : null,
          child: Container(
            height: 76,
            decoration: BoxDecoration(
              color: surface,
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              border: Border.all(
                color: widget.on
                    ? scheme.primary.withValues(alpha: 0.6)
                    : scheme.outlineVariant.withValues(alpha: 0.4),
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              children: [
                if (widget.fill > 0 || _drag != null)
                  FractionallySizedBox(
                    widthFactor: _display.clamp(0.0, 1.0),
                    alignment: Alignment.centerLeft,
                    child: AnimatedContainer(
                      duration: AureonMotion.fast,
                      color: scheme.primary.withValues(alpha: widget.on ? 0.22 : 0.12),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.lg),
                  child: Row(
                    children: [
                      Icon(widget.icon, size: 22, color: widget.on ? scheme.primary : scheme.onSurface),
                      const SizedBox(width: AureonSpacing.md),
                      Expanded(child: Text(widget.name, style: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600))),
                      Text(widget.valueLabel,
                          style: text.labelMedium?.copyWith(
                              color: scheme.onSurface.withValues(alpha: 0.6),
                              fontFeatures: const [FontFeature.tabularFigures()])),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );

    if (widget.onOpenDetail == null) return tile;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(child: tile),
        const SizedBox(width: AureonSpacing.xs),
        SizedBox(
          width: 40,
          child: IconButton(
            onPressed: widget.onOpenDetail,
            icon: Icon(Icons.chevron_right, color: scheme.onSurface.withValues(alpha: 0.5)),
            tooltip: 'View details',
          ),
        ),
      ],
    );
  }
}
