import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// The onboarding's field panel — the same ring language as Presence, "telling Act 1 of the story",
/// ported from `drawPanel` / `tweenPanel` / `setPanel` / `PANEL` in `SupremeOS_Onboarding_frozen.html`.
/// Welcome and Identity show SupremeOS alone (Identity gains the residence's field once it has a
/// name); Sign in and Ready show the five-ring resting mark; "not found" shows SupremeOS alone.

const _panelBg = Color(0xFFEFE9DF);
const _gold = Color(0xFFA78048);

/// Where the panel is heading: `a` SupremeOS field, `b` the residence's field, `mark` the resting
/// mark (0 → 1).
class PanelGoal {
  final double a, b, mark;
  const PanelGoal({this.a = 1, this.b = 0, this.mark = 0});

  static const alone = PanelGoal();
  static const resting = PanelGoal(mark: 1);

  @override
  bool operator ==(Object other) =>
      other is PanelGoal && other.a == a && other.b == b && other.mark == mark;
  @override
  int get hashCode => Object.hash(a, b, mark);
}

/// The tweened values (`P`). A critically damped approach — no bounce: `k = 1 - exp(-dt/220)`.
class FieldPanelValues {
  double a = 1, b = 0, mark = 0;

  /// Moves towards [g] by [dtMs] (clamped to 50, as the original). True while still moving.
  bool step(PanelGoal g, double dtMs) {
    final k = 1 - math.exp(-math.min(dtMs, 50) / 220);
    var moving = false;
    double go(double cur, double goal) {
      final d = goal - cur;
      if (d.abs() > .002) {
        moving = true;
        return cur + d * k;
      }
      return goal;
    }

    a = go(a, g.a);
    b = go(b, g.b);
    mark = go(mark, g.mark);
    return moving;
  }

  void jumpTo(PanelGoal g) {
    a = g.a;
    b = g.b;
    mark = g.mark;
  }
}

const _recv = [1, 0, 1, 0, 1, 1, 0, 1];
final _aR = [for (var i = 0; i < 8; i++) .28 + .72 * i / 7];
const _bR = [32 / 184, 70 / 184, 108 / 184, 146 / 184, 1.0];
const _bFall = [1, .9, .8, .7, .6];

class FieldPanelPainter extends CustomPainter {
  final double a, b, mark;
  const FieldPanelPainter(this.a, this.b, this.mark);

  void _ring(Canvas c, double x, double y, double r, double al, double w) {
    if (al <= .003 || r <= .5) return;
    c.drawCircle(
        Offset(x, y),
        r,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = w
          ..color = _gold.withValues(alpha: math.min(1, al)));
  }

  @override
  void paint(Canvas canvas, Size size) {
    final pw = size.width, ph = size.height;
    canvas.drawRect(Offset.zero & size, Paint()..color = _panelBg);
    final R = math.min(pw, ph) * .34, m = mark;
    final ax = pw * (.44 + .06 * m), ay = ph * (.56 - .06 * m);
    final s = 1 - .45 * m;
    for (var i = 0; i < 8; i++) {
      final keep = _recv[i] == 1 ? 1.0 : 1 - m;
      _ring(canvas, ax, ay, R * _aR[i] * s,
          .46 * a * keep * (_recv[i] == 1 ? 1 + .25 * m : 1), 1);
    }
    if (b > .003) {
      final bx = pw * .8, by = ph * .26, rb = R * .8;
      for (var i = 0; i < 5; i++) {
        _ring(canvas, bx, by, rb * _bR[i], .22 * b * _bFall[i], .8);
      }
      canvas.drawCircle(
          Offset(bx, by), 4, Paint()..color = _gold.withValues(alpha: .55 * b));
    }
    canvas.drawCircle(Offset(ax, ay), 7 + 2 * m, Paint()..color = _gold);
  }

  @override
  bool shouldRepaint(FieldPanelPainter o) =>
      o.a != a || o.b != b || o.mark != mark;
}

/// The panel as a widget: tweens to [goal] on a ticker (or jumps there under reduced motion).
class OnboardingFieldPanel extends StatefulWidget {
  final PanelGoal goal;
  final bool reduced;
  const OnboardingFieldPanel(
      {super.key, required this.goal, required this.reduced});

  @override
  State<OnboardingFieldPanel> createState() => _OnboardingFieldPanelState();
}

class _OnboardingFieldPanelState extends State<OnboardingFieldPanel>
    with SingleTickerProviderStateMixin {
  final _v = FieldPanelValues();
  late final Ticker _ticker;
  Duration _last = Duration.zero;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick);
    _v.jumpTo(widget.goal);
  }

  @override
  void didUpdateWidget(OnboardingFieldPanel old) {
    super.didUpdateWidget(old);
    if (widget.goal == old.goal && widget.reduced == old.reduced) return;
    if (widget.reduced) {
      setState(() => _v.jumpTo(widget.goal));
    } else if (!_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    }
  }

  void _onTick(Duration elapsed) {
    final dt = (elapsed - _last).inMicroseconds / 1000.0;
    _last = elapsed;
    final moving = _v.step(widget.goal, dt);
    setState(() {});
    if (!moving) _ticker.stop();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: CustomPaint(
            painter: FieldPanelPainter(_v.a, _v.b, _v.mark),
            child: const SizedBox.expand()),
      );
}
