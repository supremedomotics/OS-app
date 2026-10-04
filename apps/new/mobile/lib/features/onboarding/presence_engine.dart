import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The Golden Master's Presence v11 — the boot/arrival choreography — ported value for value from
/// `SupremeOS_Onboarding_frozen.html` (the `presence` engine: `PRE`/`POST` phase boundaries, the
/// `LAYOUTS`, `fieldA`/`fieldB`/`glow`/`core`/`ring` primitives, `frame(t)` and `tick`). Every
/// number below is that file's number; nothing is retuned. It owns no residence state: it draws a
/// clock and a colour, and the onboarding flow tells it when the Hub has really answered.
///
/// `frame(t)` is a pure function of the virtual time `t` and the phase boundaries, which is what
/// lets `tools/golden-master-verify` compare a Flutter frame with the original at the same `t`.

const _bg = Color(0xFFF7F4EE);
const _ink = Color(0xFF2D2A25);
const _gr = 167, _gg = 128, _gb = 72;

Color _gold([double a = 1]) =>
    Color.fromRGBO(_gr, _gg, _gb, a.clamp(0.0, 1.0).toDouble());

/// Phase boundaries (ms, virtual clock). Pre-response phases are fixed; everything after RESPONSE
/// is placed relative to the moment the Hub actually answers — the residence field appears only
/// when the residence really responds (`place`).
class PresenceTimeline {
  static const double preSelf = 1200; // PRE.presence
  static const double preReach = 3100; // PRE.reach
  static const double minStill = 3900; // PRE.minStill — earliest possible response

  static const _post = <String, double>{
    'response': 1150,
    'two': 850,
    'approach': 1150,
    'datum': 500,
    'coherence': 1100,
    'arrival': 500,
    'calm': 450,
  };
  static const double welcome = 1200; // POST.welcome

  double presence = preSelf;
  double reach = preReach;
  double still = double.infinity;
  double response = double.infinity;
  double two = double.infinity;
  double approach = double.infinity;
  double datum = double.infinity;
  double coherence = double.infinity;
  double arrival = double.infinity;
  double calm = double.infinity;
  double end = double.infinity;

  PresenceTimeline();

  PresenceTimeline.placed(double r) {
    place(r);
  }

  /// [r] = the virtual time the response begins.
  void place(double r) {
    still = r;
    var t = r;
    for (final k in _post.keys) {
      t += _post[k]!;
      switch (k) {
        case 'response':
          response = t;
        case 'two':
          two = t;
        case 'approach':
          approach = t;
        case 'datum':
          datum = t;
        case 'coherence':
          coherence = t;
        case 'arrival':
          arrival = t;
        case 'calm':
          calm = t;
      }
    }
    end = t + welcome;
  }

  PresenceTimeline copy() => PresenceTimeline()
    ..presence = presence
    ..reach = reach
    ..still = still
    ..response = response
    ..two = two
    ..approach = approach
    ..datum = datum
    ..coherence = coherence
    ..arrival = arrival
    ..calm = calm
    ..end = end;
}

/// The engine's clock (`tick` / `begin` / `hubResponded`): virtual time that never jumps (a frame
/// is clamped to 50 ms, so a backgrounded app resumes calmly), runs 1.5× through the pre-response
/// phases when the Hub has already answered (never skipped), and places the response no earlier
/// than the minimum stillness.
class PresenceClock {
  static const double fastRate = 1.5;

  final PresenceTimeline timeline = PresenceTimeline();
  double vt = 0;
  double hubAt = -1; // virtual ms the real signal arrived; -1 = not yet
  bool hubReady = false; // the residence has answered at least once (survives replay)
  bool finished = false;
  bool _running = false;

  PresenceClock() {
    begin();
  }

  void begin() {
    finished = false;
    vt = 0;
    timeline.place(double.infinity); // every post-response phase waits for the residence
    hubAt = hubReady ? 0 : -1;
    _running = true;
  }

  /// The Hub really answered.
  void hubResponded() {
    if (hubReady) return;
    hubReady = true;
    if (finished || !_running) return;
    hubAt = vt;
  }

  /// Stops advancing (no answer: SupremeOS stays alone). The last frame is kept.
  void stop() => _running = false;

  /// Advances by [elapsedMs] of real time. Returns true on the tick that finishes the choreography.
  bool tick(double elapsedMs) {
    if (!_running || finished) return false;
    final dt = math.min(elapsedMs, 50.0);
    final rate = (hubAt >= 0 && vt < timeline.reach) ? fastRate : 1.0;
    vt += dt * rate;
    if (hubAt >= 0 && timeline.still.isInfinite) {
      timeline.place(math.max(PresenceTimeline.minStill, vt));
    }
    if (math.min(vt, timeline.end) >= timeline.end) {
      finished = true;
      return true;
    }
    return false;
  }

  double get t => math.min(vt, timeline.end);
}

// ── geometry ────────────────────────────────────────────────────────────────────────────────

class _Layout {
  final double w, h, ax, ay, bx, by, logoX, logoY, fs;
  const _Layout(this.w, this.h, this.ax, this.ay, this.bx, this.by, this.logoX,
      this.logoY,
      [this.fs = 1]);
}

const _land = _Layout(1280, 720, 640, 368, 956, 235, 62, 58);
const _port = _Layout(720, 1280, 360, 660, 540, 330, 40, 60);
const _compact = _Layout(1280, 720, 640, 368, 924, 250, 62, 58, .9);

_Layout _layoutFor(Size s) =>
    (s.width / s.height < .9) ? _port : (s.height < 480 ? _compact : _land);

const int _aN = 8;
final List<double> _aR = [
  for (var i = 0; i < _aN; i++) 228 * (.28 + .72 * i / (_aN - 1))
];
const double _aAlpha = .46;
const List<double> _bR = [32, 70, 108, 146, 184];
const List<int> _bTarget = [0, 2, 4, 5, 7];
const double _bAlpha = .2;
final List<bool> _received = [
  for (var i = 0; i < _aN; i++) _bTarget.contains(i)
];
const double _lean = .035;
const double _restS = .42;
const double _restA = _aAlpha * .8;
const double _trace = _bAlpha * .2;
final List<bool> _ack = [for (var i = 0; i < _aN; i++) i == 5 || i == 7];
const List<double> _bStart = [.17, .39, .47, .58, .63];
const double _bDur = .2;
const double _bW = .8;
const List<double> _bFall = [1, .9, .8, .7, .6];

// ── easing ──────────────────────────────────────────────────────────────────────────────────

double _clamp(double t) => t < 0 ? 0 : (t > 1 ? 1 : t);
double _ease(double t) {
  t = _clamp(t);
  return t * t * (3 - 2 * t);
}

double _smoother(double t) {
  t = _clamp(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

double _decisive(double t) => 1 - math.pow(1 - _clamp(t), 2.6).toDouble();
double _approachEase(double t) =>
    1 - math.pow(1 - _ease(t), 1.3).toDouble();
double _bell(double t) => math.sin(math.pi * _clamp(t));
double _seg(double t, double a, double b) => (t - a) / (b - a);
double _lerp(double a, double b, double t) => a + (b - a) * t;

/// Draws one frame of Presence at virtual time [t].
///
/// [title] is the word under the mark after CALM ("Welcome" at launch, the residence's name when
/// the onboarding withdraws — the engine's `rest(title)`); [reduced] is the engine's
/// `prefers-reduced-motion` path (the settled state, no choreography).
class PresencePainter extends CustomPainter {
  final double t;
  final PresenceTimeline timeline;
  final String title;
  final String sub;
  final bool reduced;
  final bool drawBackground;

  PresencePainter({
    required this.t,
    required this.timeline,
    this.title = 'Welcome',
    this.sub = '',
    this.reduced = false,
    this.drawBackground = true,
  });

  late _Layout _l;
  double _fs = 1;
  double _scale = 1;
  late Canvas _c;

  // primitives (the engine's glow/core/ring) ---------------------------------------------------

  void _glow(double x, double y, double r, double s) {
    if (s <= .002) return;
    final shader = ui.Gradient.radial(Offset(x, y), r, [
      _gold(s),
      _gold(s * .38),
      _gold(0),
    ], const [
      0,
      .45,
      1
    ]);
    _c.drawCircle(Offset(x, y), r, Paint()..shader = shader);
  }

  void _core(double x, double y, double r, [double a = 1]) {
    if (a <= .002) return;
    _c.drawCircle(Offset(x, y), r, Paint()..color = _gold(a));
  }

  void _ring(double x, double y, double r, double a, [double w = 1]) {
    if (a <= .002 || r <= .5) return;
    _c.drawCircle(
        Offset(x, y),
        r * _fs,
        Paint()
          ..style = PaintingStyle.stroke
          ..color = _gold(math.min(1, a))
          // never thinner than .75 CSS px on small screens
          ..strokeWidth = math.max(w, .75 / _scale));
  }

  void _fieldA(double x, double y, double s, double a,
      [double boost = 0, double all = 0, double ack = 0, double others = 1]) {
    for (var i = 0; i < _aN; i++) {
      final k = (_received[i] ? boost : 0) + (_ack[i] ? ack : 0);
      _ring(x, y, _aR[i] * s, (a * (1 + all) + k) * (_received[i] ? 1 : others),
          1 + k * 1.6);
    }
  }

  void _fieldB(double x, double y, double a, double h, double m) {
    final br = 1 + .018 * _bell((m - .72) / .28);
    for (var i = 0; i < 5; i++) {
      final mi = _smoother((m - _bStart[i]) / _bDur);
      if (mi <= 0) continue;
      final r = _lerp(_bR[i], _aR[_bTarget[i]], h) * (.95 + .05 * mi) * br;
      final fall = _lerp(_bFall[i], 1, h);
      _ring(x, y, r, a * mi * fall, _lerp(_bW, 1, h));
    }
  }

  void _coreB(double x, double y, double k, double a) {
    _glow(x, y, 44, .075 * k * a / .55);
    _core(x, y, 5 * k, a);
  }

  void _restingField(double x, double y, double glowS) {
    _fieldA(x, y, _restS, _restA, _trace, 0, 0, 0);
    _glow(x, y, 40, glowS);
    _core(x, y, 12.5);
  }

  void _text(String s, double x, double y, TextStyle style,
      {bool center = false, double alpha = 1}) {
    final tp = TextPainter(
      text: TextSpan(
          text: s,
          style: style.copyWith(
              color: _ink.withValues(alpha: alpha.clamp(0.0, 1.0)))),
      textDirection: TextDirection.ltr,
    )..layout();
    final base = tp.computeDistanceToActualBaseline(TextBaseline.alphabetic);
    tp.paint(_c, Offset(center ? x - tp.width / 2 : x, y - base));
  }

  TextStyle _sans(double size, FontWeight w, [double ls = 0]) => TextStyle(
      fontFamily: SupremeFonts.sans,
      package: SupremeFonts.package,
      fontSize: size,
      fontWeight: w,
      letterSpacing: ls,
      decoration: TextDecoration.none);

  TextStyle _serif(double size) => TextStyle(
      fontFamily: SupremeFonts.serif,
      package: SupremeFonts.package,
      fontSize: size,
      fontWeight: FontWeight.w300,
      decoration: TextDecoration.none);

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    _c = canvas;
    _l = _layoutFor(size);
    _fs = _l.fs;
    _scale = math.min(size.width / _l.w, size.height / _l.h);
    final ox = (size.width - _l.w * _scale) / 2;
    final oy = (size.height - _l.h * _scale) / 2;
    final T = timeline;

    canvas.save();
    canvas.clipRect(Offset.zero & size);
    if (drawBackground) canvas.drawRect(Offset.zero & size, Paint()..color = _bg);
    canvas.translate(ox, oy);
    canvas.scale(_scale);

    _text('SUPREMEOS', _l.logoX, _l.logoY, _sans(12, FontWeight.w400, 3.4));

    final ax = _l.ax, ay = _l.ay, bx = _l.bx, by = _l.by;
    final mx = _lerp(ax, bx, _lean), my = _lerp(ay, by, _lean);

    if (reduced || t >= T.calm) {
      // STILLNESS → WELCOME — the one field remains, still
      _restingField(ax, ay, .05);
      final q = reduced ? 1.0 : _ease(_seg(t, T.calm, T.end));
      if (q > 0) {
        _text(title, ax, ay + 160, _serif(50), center: true, alpha: .94 * q);
        if (sub.isNotEmpty) {
          _text(sub, ax, ay + 202, _sans(17, FontWeight.w300, .6),
              center: true, alpha: .84 * q);
        }
      }
    } else if (t < T.presence) {
      // PRESENCE
      final p = _smoother(t / T.presence);
      _glow(ax, ay, 45 + 28 * p, .045 + .045 * p);
      _core(ax, ay, 5.5 + 2.5 * p);
    } else if (t < T.reach) {
      // REACH — boundary first, then measured inward
      final u = t - T.presence;
      for (var i = _aN - 1; i >= 0; i--) {
        final k = (_aN - 1 - i);
        final q = _smoother((u - k * 160) / 650);
        if (q <= 0) continue;
        _ring(ax, ay, _aR[i] * (1.035 - .035 * q), _aAlpha * q);
      }
      final p = _smoother(u / (T.reach - T.presence));
      _glow(ax, ay, 73 - 18 * p, .09 - .035 * p);
      _core(ax, ay, 8 + 2 * p);
    } else if (t < T.still) {
      // STILLNESS — held until the residence actually answers
      _fieldA(ax, ay, 1, _aAlpha);
      _glow(ax, ay, 55, .055);
      _core(ax, ay, 10);
    } else if (t < T.response) {
      // RESIDENCE APPEARS — centre first, then one ring, then the rest
      final m = _clamp(_seg(t, T.still, T.response));
      final cm = _smoother(m / .2);
      _fieldA(ax, ay, 1, _aAlpha);
      _glow(ax, ay, 55, .055);
      _core(ax, ay, 10);
      _fieldB(bx, by, _bAlpha * 1.1, 0, m);
      _coreB(bx, by, .5 + .5 * cm, .55 * cm);
    } else if (t < T.two) {
      // TWO PRESENCES — a scene, not a transition: nothing moves
      _fieldA(ax, ay, 1, _aAlpha);
      _glow(ax, ay, 55, .055);
      _core(ax, ay, 10);
      _fieldB(bx, by, _bAlpha * 1.1, 0, 1);
      _coreB(bx, by, 1, .55);
    } else if (t < T.approach) {
      // MUTUAL RECOGNITION → APPROACH
      final e = t - T.two;
      final aNotice = _ease(e / 300);
      final bAnswer = _ease((e - 150) / 300);
      final h = _smoother((e - 250) / 950);
      final p = _approachEase((e - 300) / 900);
      final aX = _lerp(ax, mx, p), aY = _lerp(ay, my, p);
      final bX = _lerp(bx, mx, p), bY = _lerp(by, my, p);
      final allRecv = _bAlpha * .35 * _ease((e - 450) / 400);
      _fieldA(aX, aY, 1, _aAlpha * (1 + .06 * p), allRecv, 0,
          _bAlpha * .45 * aNotice * (1 - .4 * _ease((e - 450) / 400)));
      _glow(aX, aY, 55, .055 + .01 * p);
      _core(aX, aY, 10 + .6 * p);
      final quiet = 1 - .12 * _bell((e - 300) / 900);
      final firm = 1 + .35 * bAnswer;
      _fieldB(bX, bY, _bAlpha * 1.1 * firm * quiet * (1 + .2 * h), h, 1);
      final d = math.sqrt((bX - aX) * (bX - aX) + (bY - aY) * (bY - aY));
      _coreB(bX, bY, 1 + .12 * bAnswer,
          .55 * firm * quiet * (1 - .4 * h) * _clamp((d - 4) / 40));
    } else if (t < T.datum) {
      // COMMON DATUM — pause · breath · absorption
      final e = t - T.approach;
      final breath = _bell((e - 100) / 300) * .10;
      final abs = _ease((e - 100) / 450);
      _fieldA(mx, my, 1, _aAlpha * 1.06, _bAlpha * (.35 + .95 * abs), breath);
      for (var i = 0; i < 5; i++) {
        _ring(mx, my, _aR[_bTarget[i]], _bAlpha * 1.4 * (1 - abs));
      }
      _glow(mx, my, 55, .065 + .3 * breath);
      _core(mx, my, 10.6 + 1.2 * _ease(e / 400));
    } else if (t < T.coherence) {
      // COHERENCE — one system, simpler, contracts into the resting mark
      final e = t - T.datum;
      final settle = _ease(e / 300);
      final c = _smoother(e / 300);
      final r = _decisive((e - 700) / 400);
      final x = _lerp(mx, ax, c), y = _lerp(my, ay, c);
      final boost = _lerp(_bAlpha * 1.3, _trace, settle);
      _fieldA(x, y, _lerp(1, _restS, r), _lerp(_aAlpha * 1.06, _restA, r),
          boost, 0, 0, 1 - r);
      _glow(x, y, _lerp(55, 40, r), .065);
      _core(x, y, _lerp(11.8, 12.5, r));
    } else {
      // ARRIVAL — restrained warmth at the one centre
      final p = _smoother(_seg(t, T.coherence, T.arrival));
      _restingField(ax, ay, .05 + .05 * _bell(p));
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(PresencePainter old) =>
      old.t != t ||
      old.title != title ||
      old.sub != sub ||
      old.reduced != reduced ||
      old.timeline.still != timeline.still;
}
