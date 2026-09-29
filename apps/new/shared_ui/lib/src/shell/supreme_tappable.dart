import 'package:flutter/widgets.dart';

import '../theme/supreme_colors.dart';

/// A tappable, focusable surface with the Golden Master's focus language, for anything that is not
/// a text field: navigation items, chips, actions.
///
/// Material's ink ripple is not part of the language, so there is none. Focus is always visible:
/// a 2 px brass-light ring 3 px out; on a remote surface (`directionalFocus`) 3 px, 4 px out, with a
/// soft brass halo — "strong enough to read from the sofa". Enter, Space and a remote's Select all
/// activate it through Flutter's standard [ActivateIntent].
class SupremeTappable extends StatefulWidget {
  final VoidCallback onTap;
  final Widget child;
  final String semanticLabel;
  final bool selected;
  final double radius;
  final bool directionalFocus;
  final bool autofocus;

  const SupremeTappable({
    super.key,
    required this.onTap,
    required this.child,
    required this.semanticLabel,
    this.selected = false,
    this.radius = 8,
    this.directionalFocus = false,
    this.autofocus = false,
  });

  @override
  State<SupremeTappable> createState() => _SupremeTappableState();
}

class _SupremeTappableState extends State<SupremeTappable> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: widget.selected,
      label: widget.semanticLabel,
      onTap: widget.onTap,
      excludeSemantics: true,
      child: FocusableActionDetector(
        autofocus: widget.autofocus,
        mouseCursor: SystemMouseCursors.click,
        actions: <Type, Action<Intent>>{
          ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
            widget.onTap();
            return null;
          }),
        },
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: CustomPaint(
            foregroundPainter: _FocusRing(
                active: _focused,
                radius: widget.radius,
                directional: widget.directionalFocus),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

class _FocusRing extends CustomPainter {
  final bool active;
  final double radius;
  final bool directional;
  const _FocusRing(
      {required this.active, required this.radius, required this.directional});

  @override
  void paint(Canvas canvas, Size size) {
    if (!active) return;
    final offset = directional ? 4.0 : 3.0;
    final base = RRect.fromRectAndRadius(
        Offset.zero & size, Radius.circular(radius));
    if (directional) {
      canvas.drawRRect(
        base.inflate(offset + 4),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 8
          ..color = SupremeColorScheme.brassLight.withValues(alpha: .18),
      );
    }
    canvas.drawRRect(
      base.inflate(offset),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = directional ? 3 : 2
        ..color = SupremeColorScheme.brassLight,
    );
  }

  @override
  bool shouldRepaint(_FocusRing old) =>
      old.active != active ||
      old.radius != radius ||
      old.directional != directional;
}
