import 'dart:math' as math;

import 'package:flutter/material.dart';

/// An HSV colour wheel (§11.1 rich domain controls): hue around the circle, saturation
/// from centre (white) to edge (full colour), with a draggable node. Drag anywhere on the
/// disc to pick; the brightness/value is controlled separately by the brightness dial.
class ColorWheel extends StatelessWidget {
  const ColorWheel({
    super.key,
    required this.hue,
    required this.saturation,
    required this.onChanged,
    this.size = 240,
  });

  /// Hue in degrees 0..360.
  final double hue;

  /// Saturation 0..1.
  final double saturation;

  /// Disc diameter.
  final double size;

  /// Called with (hue 0..360, saturation 0..1) while dragging.
  final void Function(double hue, double saturation) onChanged;

  void _handle(Offset local) {
    final r = size / 2;
    final dx = local.dx - r;
    final dy = local.dy - r;
    final dist = math.sqrt(dx * dx + dy * dy);
    final sat = (dist / r).clamp(0.0, 1.0);
    var deg = math.atan2(dy, dx) * 180 / math.pi;
    if (deg < 0) deg += 360;
    onChanged(deg, sat);
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onPanDown: (d) => _handle(d.localPosition),
      onPanUpdate: (d) => _handle(d.localPosition),
      child: CustomPaint(
        size: Size.square(size),
        painter: _WheelPainter(hue: hue, saturation: saturation),
      ),
    );
  }
}

class _WheelPainter extends CustomPainter {
  _WheelPainter({required this.hue, required this.saturation});

  final double hue;
  final double saturation;

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.width / 2;
    final center = Offset(r, r);

    // Hue sweep.
    final hueColors = [
      for (var d = 0; d <= 360; d += 30) HSVColor.fromAHSV(1, d.toDouble() % 360, 1, 1).toColor(),
    ];
    final huePaint = Paint()
      ..shader = SweepGradient(colors: hueColors, transform: const GradientRotation(-math.pi / 2)).createShader(
        Rect.fromCircle(center: center, radius: r),
      );
    canvas.drawCircle(center, r, huePaint);

    // Saturation: white centre fading to transparent edge.
    final satPaint = Paint()
      ..shader = RadialGradient(
        colors: [Colors.white, Colors.white.withValues(alpha: 0)],
      ).createShader(Rect.fromCircle(center: center, radius: r));
    canvas.drawCircle(center, r, satPaint);

    // Subtle rim.
    canvas.drawCircle(center, r - 0.5, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.black.withValues(alpha: 0.18));

    // Selection node — start hue from the top (−90°) to match the sweep rotation.
    final ang = (hue - 90) * math.pi / 180;
    final nodeR = saturation.clamp(0.0, 1.0) * r;
    final node = Offset(center.dx + nodeR * math.cos(ang), center.dy + nodeR * math.sin(ang));
    final selected = HSVColor.fromAHSV(1, hue % 360, saturation.clamp(0.0, 1.0), 1).toColor();
    canvas.drawCircle(node, 13, Paint()..color = selected);
    canvas.drawCircle(node, 13, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..color = Colors.white);
    canvas.drawCircle(node, 15, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.black.withValues(alpha: 0.25));
  }

  @override
  bool shouldRepaint(_WheelPainter old) => old.hue != hue || old.saturation != saturation;
}
