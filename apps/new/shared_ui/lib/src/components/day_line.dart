import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../theme/supreme_colors.dart';

/// The sun's line (Golden Master `.sos-day`): an arc from sunrise to sunset with the sun on it,
/// the part of the day beside it ("AFTERNOON") and the day's span ("7:49 – 19:29"). A function of
/// the residence's location and the instant — drawn only when the Hub holds a location, never
/// guessed. Re-reads the clock each minute.
class SupremeDayLine extends StatefulWidget {
  final ResidenceLocation location;

  /// The instant to draw; defaults to now. A test (or a replay) supplies its own.
  final DateTime Function() now;
  final bool compact;
  const SupremeDayLine({super.key, required this.location, required this.now, this.compact = false});

  @override
  State<SupremeDayLine> createState() => _SupremeDayLineState();
}

class _SupremeDayLineState extends State<SupremeDayLine> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = widget.now();
    final d = dayLineAt(now, widget.location);
    final span = d.span;
    final small = widget.compact;
    final label = TextStyle(
        fontSize: small ? 10.5 : 11.5,
        letterSpacing: 1.6,
        fontWeight: FontWeight.w500,
        color: SupremeColorScheme.brassPale);
    return Semantics(
      label: d.line(now),
      excludeSemantics: true,
      child: Wrap(
        key: const ValueKey('day-line'),
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 10,
        runSpacing: 4,
        children: [
          SizedBox(
              width: small ? 96 : 104,
              height: small ? 20 : 22,
              child: CustomPaint(painter: _DayArcPainter(d))),
          Text(d.phaseName.toUpperCase(), key: const ValueKey('day-phase'), style: label),
          if (span != null)
            Text(span,
                key: const ValueKey('day-span'),
                style: label.copyWith(letterSpacing: .8, color: SupremeColorScheme.textIdle)),
        ],
      ),
    );
  }
}

/// viewBox 200×40 in the original: a horizon, the day's arc above it, the sun on the arc by day
/// (a dimmer moon-grey dot travelling below the horizon by night).
class _DayArcPainter extends CustomPainter {
  final DayLine d;
  _DayArcPainter(this.d);

  @override
  void paint(Canvas canvas, Size size) {
    final sx = size.width / 200, sy = size.height / 40;
    canvas.scale(sx, sy);
    const horizon = 26.0, amp = 18.0;
    final rule = Paint()
      ..color = SupremeColorScheme.brassPale.withValues(alpha: .28)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1 / sy;
    canvas.drawLine(const Offset(0, horizon), const Offset(200, horizon), rule);

    final arc = Path()..moveTo(0, horizon);
    for (var i = 1; i <= 40; i++) {
      final f = i / 40;
      arc.lineTo(200 * f, horizon - amp * _bow(f));
    }
    canvas.drawPath(
        arc,
        Paint()
          ..color = SupremeColorScheme.brassPale.withValues(alpha: d.up ? .55 : .22)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2 / sy
          ..strokeCap = StrokeCap.round);

    final f = d.along.clamp(0.0, 1.0);
    final x = 200 * f;
    final y = d.up ? horizon - amp * _bow(f) : horizon + 7 * _bow(f);
    canvas.drawCircle(
        Offset(x, y),
        d.up ? 3.4 : 2.6,
        Paint()..color = d.up ? SupremeColorScheme.brassLight : const Color(0xFF9AA3B2));
  }

  /// The arc's height 0..1 along the day: a half sine, like the sun's own climb.
  static double _bow(double f) => _sin(f * 3.141592653589793);
  static double _sin(double x) {
    // Bhaskara's approximation is plenty at 1px over 18px of height, and avoids a dart:math import.
    final t = x / 3.141592653589793;
    return 16 * t * (1 - t) / (5 - 4 * t * (1 - t));
  }

  @override
  bool shouldRepaint(_DayArcPainter old) => old.d.along != d.along || old.d.up != d.up;
}
