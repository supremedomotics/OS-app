import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Ovio "tile-as-control" device row (§11.1): a horizontal tile with an icon + name on
/// the left, a value on the right, and a background that fills proportionally to the
/// value. Horizontal drag sets the value (lights, covers); a tap opens the detail. Theme
/// aware (renders in Luxury Black + Luxury White).
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
  });

  final IconData icon;
  final String name;
  final String valueLabel;
  final double fill;
  final bool on;
  final bool slidable;
  final ValueChanged<double>? onChanged;
  final VoidCallback? onTap;

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
    return LayoutBuilder(
      builder: (context, c) {
        final width = c.maxWidth;
        void setFromDx(double dx) {
          setState(() => _drag = (dx / width).clamp(0.0, 1.0));
          widget.onChanged?.call(_drag!);
        }

        return GestureDetector(
          onTap: widget.onTap,
          onHorizontalDragStart: widget.slidable ? (d) { _moved = false; setFromDx(d.localPosition.dx); } : null,
          onHorizontalDragUpdate: widget.slidable ? (d) { _moved = true; setFromDx(d.localPosition.dx); } : null,
          onHorizontalDragEnd: widget.slidable
              ? (_) {
                  setState(() => _drag = null);
                  if (!_moved) widget.onTap?.call();
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
  }
}
