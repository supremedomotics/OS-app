import 'dart:math' as math;

import 'package:flutter/material.dart';

/// One light represented on the disc — placed by its hue/saturation.
class DiscLight {
  const DiscLight({required this.id, required this.hue, required this.saturation, required this.on});
  final String id;
  final double hue; // 0..360
  final double saturation; // 0..1
  final bool on;
}

/// The Ovio iPad multi-light colour field (§11.1): a large disc — a full HSV wheel in
/// Colour mode, a warm dim disc in White mode — with one draggable NODE per colour light.
/// Dragging a node tunes that light; tapping selects it.
class MultiLightDisc extends StatefulWidget {
  const MultiLightDisc({
    super.key,
    required this.lights,
    required this.colour,
    required this.onChange,
    required this.onSelect,
    this.selected,
    this.size = 380,
  });

  final List<DiscLight> lights;
  final bool colour;
  final String? selected;
  final void Function(String id, double hue, double saturation) onChange;
  final void Function(String id) onSelect;
  final double size;

  @override
  State<MultiLightDisc> createState() => _MultiLightDiscState();
}

class _MultiLightDiscState extends State<MultiLightDisc> {
  final _key = GlobalKey();

  void _handle(String id, Offset globalPos) {
    final box = _key.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return;
    final local = box.globalToLocal(globalPos);
    final r = widget.size / 2;
    final dx = local.dx - r;
    final dy = local.dy - r;
    final sat = (math.sqrt(dx * dx + dy * dy) / r).clamp(0.0, 1.0);
    var deg = math.atan2(dx, -dy) * 180 / math.pi;
    if (deg < 0) deg += 360;
    widget.onChange(id, deg, sat);
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.size / 2;
    return SizedBox(
      key: _key,
      width: widget.size,
      height: widget.size,
      child: Stack(
        children: [
          CustomPaint(size: Size.square(widget.size), painter: _DiscPainter(colour: widget.colour)),
          for (final l in widget.lights)
            _node(l, r),
        ],
      ),
    );
  }

  Widget _node(DiscLight l, double r) {
    final ang = (l.hue - 90) * math.pi / 180;
    final dist = l.saturation.clamp(0.0, 1.0) * r;
    final cx = r + dist * math.cos(ang);
    final cy = r + dist * math.sin(ang);
    final sel = widget.selected == l.id;
    final d = sel ? 36.0 : 30.0;
    final colour = l.on ? HSVColor.fromAHSV(1, l.hue % 360, l.saturation.clamp(0.0, 1.0), 0.55).toColor() : const Color(0x99969696);
    return Positioned(
      left: cx - d / 2,
      top: cy - d / 2,
      child: GestureDetector(
        onTap: () => widget.onSelect(l.id),
        onPanStart: (_) => widget.onSelect(l.id),
        onPanUpdate: (e) => _handle(l.id, e.globalPosition),
        child: Container(
          width: d,
          height: d,
          decoration: BoxDecoration(
            color: colour,
            shape: BoxShape.circle,
            border: Border.all(color: sel ? const Color(0xFFE3BE6A) : Colors.white, width: sel ? 3 : 3),
            boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 6, offset: Offset(0, 2))],
          ),
        ),
      ),
    );
  }
}

class _DiscPainter extends CustomPainter {
  _DiscPainter({required this.colour});
  final bool colour;

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.width / 2;
    final center = Offset(r, r);
    if (colour) {
      final hues = [for (var d = 0; d <= 360; d += 30) HSVColor.fromAHSV(1, d.toDouble() % 360, 0.9, 0.85).toColor()];
      canvas.drawCircle(center, r, Paint()..shader = SweepGradient(colors: hues, transform: const GradientRotation(-math.pi / 2)).createShader(Rect.fromCircle(center: center, radius: r)));
      canvas.drawCircle(center, r, Paint()..shader = RadialGradient(colors: [Colors.white, Colors.white.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: center, radius: r)));
    } else {
      canvas.drawCircle(center, r, Paint()..shader = const RadialGradient(
        center: Alignment(0, -0.15),
        colors: [Color(0xFFFFF6E2), Color(0xFFFFE9BD), Color(0xFFF4D79A)],
        stops: [0, 0.45, 1],
      ).createShader(Rect.fromCircle(center: center, radius: r)));
    }
    canvas.drawCircle(center, r - 0.5, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.black.withValues(alpha: 0.12));
  }

  @override
  bool shouldRepaint(_DiscPainter old) => old.colour != colour;
}
