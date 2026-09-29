/// ONE CONTROL LANGUAGE (Golden Master `grammar.js`): Residence Control, the Device Sheet and every
/// inline action draw from these words and nothing else, so a switch is one switch everywhere.
///
///   switch  — on/off: a hairline track and a point that travels; the word is always written
///   value   — the subject of a control, in the serif (a set temperature, a level)
///   step    — quiet − / + beside a value
///   options — a choice among named options; words, underlined when current
///   act     — a single named action (Play, Pause)
///   slider  — a continuous choice
///
/// State grammar, identical in all of them: CONFIRMED is plain (what the device reports);
/// PENDING (requested, not yet reported) is brass, dashed or dotted, and travels; a FAILED command
/// leaves the control showing what the device reports — its owner says the failure in words.
///
/// These widgets hold no device state. They are given the reported value and, separately, the
/// requested one, and they only ever call back with an intent.
library;

import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../shell/supreme_tappable.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_curves.dart';
import '../theme/supreme_theme.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

SupremeTextStyles get _t => SupremeTextStyles.resolve(SupremeDensity.comfortable);

bool _reduced(BuildContext c) => MediaQuery.maybeDisableAnimationsOf(c) ?? false;

const _dim = Color(0x9EF7F4EE); // text at 62 %

// ── the travelling line under a pending value ────────────────────────────────────────────

/// A 1 px brass line that travels along the bottom edge while [active] — "pending travels".
/// Static (a resting segment) under reduced motion.
class PendingTravel extends StatefulWidget {
  final bool active;
  final Widget child;
  const PendingTravel({super.key, required this.active, required this.child});
  @override
  State<PendingTravel> createState() => _PendingTravelState();
}

class _PendingTravelState extends State<PendingTravel>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: SupremeMotionCurves.pendingTravel);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(PendingTravel old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (widget.active && !_reduced(context)) {
      if (!_c.isAnimating) _c.repeat();
    } else {
      _c.stop();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) return widget.child;
    return CustomPaint(
      foregroundPainter: _TravelPainter(_c, _reduced(context)),
      child: widget.child,
    );
  }
}

class _TravelPainter extends CustomPainter {
  final Animation<double> t;
  final bool still;
  _TravelPainter(this.t, this.still) : super(repaint: t);
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width * .4;
    final x = still ? size.width * .3 : -w + (size.width + w * 2) * t.value;
    final rect = Rect.fromLTWH(x, size.height - 1, w, 1);
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.drawRect(
        rect,
        Paint()
          ..shader = const LinearGradient(colors: [
            Color(0x00DCC49A),
            Color(0xE6DCC49A),
            Color(0x00DCC49A)
          ]).createShader(rect));
    canvas.restore();
  }

  @override
  bool shouldRepaint(_TravelPainter o) => o.still != still;
}

// ── value ─────────────────────────────────────────────────────────────────────────────────

class SupremeValue extends StatelessWidget {
  final String text;
  final bool pending;
  final bool quiet;
  final double? fontSize;
  const SupremeValue(this.text,
      {super.key, this.pending = false, this.quiet = false, this.fontSize});

  @override
  Widget build(BuildContext context) {
    final color = quiet
        ? const Color(0x61F7F4EE)
        : pending
            ? _dim
            : SupremeColorScheme.text;
    return Semantics(
      liveRegion: true,
      child: PendingTravel(
        active: pending,
        child: AnimatedDefaultTextStyle(
          duration: SupremeMotionCurves.standard,
          style: _t.value.copyWith(fontSize: fontSize ?? 52, color: color, height: 1.05),
          child: Text(text),
        ),
      ),
    );
  }
}

// ── act ───────────────────────────────────────────────────────────────────────────────────

class SupremeAct extends StatelessWidget {
  final String text;
  final VoidCallback? onTap;
  final bool pending;
  final bool quiet;
  final double? fontSize;
  const SupremeAct(this.text,
      {super.key, required this.onTap, this.pending = false, this.quiet = false, this.fontSize});

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Opacity(
      opacity: enabled ? 1 : .35,
      child: SupremeTappable(
        onTap: onTap ?? () {},
        semanticLabel: text,
        radius: 4,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
          child: Align(
            alignment: Alignment.center,
            widthFactor: 1,
            child: Text(pending ? '$text…' : text,
                style: _t.body.copyWith(
                    fontSize: fontSize ?? (quiet ? 13 : 14),
                    color: quiet
                        ? const Color(0x75F7F4EE)
                        : SupremeColorScheme.brassPale)),
          ),
        ),
      ),
    );
  }
}

// ── step ──────────────────────────────────────────────────────────────────────────────────

class SupremeStepper extends StatelessWidget {
  final String label;
  final VoidCallback? onDown;
  final VoidCallback? onUp;
  const SupremeStepper(
      {super.key, required this.label, required this.onDown, required this.onUp});

  Widget _b(String glyph, String semantic, VoidCallback? f) => Opacity(
        opacity: f == null ? .25 : 1,
        child: SupremeTappable(
          onTap: f ?? () {},
          semanticLabel: semantic,
          radius: 2,
          child: SizedBox(
            width: 48,
            height: 48,
            child: Center(
                child: Text(glyph,
                    style: _t.body.copyWith(
                        fontSize: 24, fontWeight: FontWeight.w300, color: _dim))),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        _b('−', 'Lower — $label', onDown),
        const SizedBox(width: 2),
        _b('+', 'Higher — $label', onUp),
      ]);
}

// ── switch ────────────────────────────────────────────────────────────────────────────────

/// [on]: true, false, or null for "some on".
class SupremeSwitch extends StatelessWidget {
  final bool? on;
  final bool pending;
  final String label;
  final String? word;
  final bool showWord;
  final VoidCallback? onTap;
  const SupremeSwitch({
    super.key,
    required this.on,
    required this.label,
    required this.onTap,
    this.pending = false,
    this.word,
    this.showWord = true,
  });

  @override
  Widget build(BuildContext context) {
    final w = word ?? (on == true ? 'On' : on == null ? 'Some on' : 'Off');
    final reduce = _reduced(context);
    return Opacity(
      opacity: onTap == null ? .35 : 1,
      child: SupremeTappable(
        onTap: onTap ?? () {},
        semanticLabel: '$label — $w',
        radius: 4,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (showWord) ...[
              Text(w,
                  style: _t.body.copyWith(
                      fontSize: 13,
                      letterSpacing: .52,
                      color: on == true ? SupremeColorScheme.text : _dim)),
              const SizedBox(width: 12),
            ],
            SizedBox(
              width: 34,
              height: 20,
              child: TweenAnimationBuilder<double>(
                tween: Tween(end: on == true ? 25 : on == null ? 12.5 : 0),
                duration: reduce ? Duration.zero : const Duration(milliseconds: 350),
                curve: SupremeMotionCurves.settle,
                builder: (context, x, _) => CustomPaint(
                    painter: _SwitchPainter(x: x, on: on, pending: pending)),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _SwitchPainter extends CustomPainter {
  final double x;
  final bool? on;
  final bool pending;
  const _SwitchPainter({required this.x, required this.on, required this.pending});

  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    canvas.drawRect(Rect.fromLTWH(0, y, size.width, 1),
        Paint()..color = const Color(0x47F7F4EE));
    final c = Offset(x + 4.5, y + .5);
    const brass = SupremeColorScheme.brassPale;
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = on == false && !pending ? _dim : brass;
    if (pending) {
      // dashed ring: the request, not yet the fact
      for (var i = 0; i < 8; i += 2) {
        canvas.drawArc(Rect.fromCircle(center: c, radius: 4), i * math.pi / 4,
            math.pi / 4, false, ring);
      }
    } else {
      if (on != false) {
        canvas.drawCircle(
            c, 4.5, Paint()..color = on == true ? brass : const Color(0x80DCC49A));
      }
      canvas.drawCircle(c, 4.5, ring);
    }
  }

  @override
  bool shouldRepaint(_SwitchPainter o) =>
      o.x != x || o.on != on || o.pending != pending;
}

// ── options ───────────────────────────────────────────────────────────────────────────────

class SupremeOptions<T> extends StatelessWidget {
  final String label;
  final List<T> options;
  final T? value;
  final T? pending;
  final String Function(T) name;
  final ValueChanged<T>? onSelect;
  final double fontSize;
  const SupremeOptions({
    super.key,
    required this.label,
    required this.options,
    required this.name,
    required this.onSelect,
    this.value,
    this.pending,
    this.fontSize = 15,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      container: true,
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 16,
        runSpacing: 2,
        children: [
          for (final o in options)
            Builder(builder: (_) {
              final isPending = pending != null && pending == o;
              final current = (pending ?? value) == o;
              return Opacity(
                opacity: onSelect == null ? .35 : 1,
                child: SupremeTappable(
                  onTap: onSelect == null ? () {} : () => onSelect!(o),
                  semanticLabel: name(o),
                  selected: current,
                  radius: 2,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
                    child: Center(
                      widthFactor: 1,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 1),
                        decoration: BoxDecoration(
                            border: Border(
                                bottom: BorderSide(
                          color: current
                              ? (isPending
                                  ? SupremeColorScheme.brassPale
                                  : SupremeColorScheme.brass)
                              : const Color(0x00000000),
                        ))),
                        child: Text(name(o),
                            style: _t.body.copyWith(
                                fontSize: fontSize,
                                color: isPending
                                    ? SupremeColorScheme.brassPale
                                    : current
                                        ? SupremeColorScheme.text
                                        : const Color(0x85F7F4EE))),
                      ),
                    ),
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }
}

// ── status ────────────────────────────────────────────────────────────────────────────────

class SupremeStatus extends StatelessWidget {
  final String text;
  final String? pending;
  const SupremeStatus(this.text, {super.key, this.pending});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text.rich(TextSpan(children: [
          TextSpan(text: text),
          if (pending != null) ...[
            const TextSpan(text: ' · '),
            TextSpan(
                text: pending,
                style: const TextStyle(color: SupremeColorScheme.brassPale)),
          ],
        ]),
            style: _t.body.copyWith(fontSize: 14, color: const Color(0x8FF7F4EE))),
      );
}

// ── slider ────────────────────────────────────────────────────────────────────────────────

/// A continuous choice. [value] is what the devices report; [target] is the requested value while
/// a command is in flight (the thumb then sits at the request, in brass, with the travelling line).
/// While the finger is down the thumb follows it (gesture feedback only — never a device value);
/// [onCommit] fires once, on release.
class SupremeSlider extends StatefulWidget {
  final String label;
  final int min;
  final int max;
  final int? value;
  final int? target;
  final String Function(int) format;
  final String? readout;
  final bool enabled;
  final ValueChanged<int> onCommit;
  const SupremeSlider({
    super.key,
    required this.label,
    required this.min,
    required this.max,
    required this.value,
    required this.format,
    required this.onCommit,
    this.target,
    this.readout,
    this.enabled = true,
  });
  @override
  State<SupremeSlider> createState() => _SupremeSliderState();
}

class _SupremeSliderState extends State<SupremeSlider> {
  int? _drag;

  int _at(double dx, double width) {
    final f = (dx / width).clamp(0.0, 1.0);
    return (widget.min + f * (widget.max - widget.min)).round();
  }

  @override
  Widget build(BuildContext context) {
    final shown = _drag ?? widget.target ?? widget.value ?? widget.min;
    final pending = _drag == null && widget.target != null;
    return Semantics(
      slider: true,
      label: widget.label,
      value: widget.readout ?? widget.format(shown),
      enabled: widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : .5,
        child: PendingTravel(
          active: pending,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text(widget.label,
                    style: _t.body.copyWith(fontSize: 13, color: SupremeColorScheme.text2)),
                Text(widget.readout ?? widget.format(shown),
                    style: _t.body.copyWith(
                        fontSize: 13,
                        color: pending ? SupremeColorScheme.brassPale : SupremeColorScheme.text,
                        fontFeatures: const [FontFeature.tabularFigures()])),
              ]),
              const SizedBox(height: 4),
              LayoutBuilder(builder: (context, c) {
                const thumb = 28.0;
                final track = c.maxWidth - thumb;
                final f = (shown - widget.min) / (widget.max - widget.min);
                return GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onHorizontalDragStart: widget.enabled
                      ? (d) => setState(() => _drag = _at(d.localPosition.dx - thumb / 2, track))
                      : null,
                  onHorizontalDragUpdate: widget.enabled
                      ? (d) => setState(() => _drag = _at(d.localPosition.dx - thumb / 2, track))
                      : null,
                  onHorizontalDragEnd: widget.enabled
                      ? (_) {
                          final v = _drag;
                          setState(() => _drag = null);
                          if (v != null) widget.onCommit(v);
                        }
                      : null,
                  onTapUp: widget.enabled
                      ? (d) => widget.onCommit(_at(d.localPosition.dx - thumb / 2, track))
                      : null,
                  child: SizedBox(
                    height: 44,
                    child: Stack(alignment: Alignment.centerLeft, children: [
                      Container(
                          height: 2,
                          margin: const EdgeInsets.symmetric(horizontal: thumb / 2),
                          color: const Color(0x2EFFFFFF)),
                      Positioned(
                        left: track * f.clamp(0.0, 1.0),
                        child: Container(
                          width: thumb,
                          height: thumb,
                          alignment: Alignment.center,
                          child: Container(
                            width: 20,
                            height: 20,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: pending
                                  ? SupremeColorScheme.brassPale
                                  : const Color(0xFFFFFFFF),
                              boxShadow: const [
                                BoxShadow(color: Color(0x99000000), blurRadius: 8, offset: Offset(0, 2))
                              ],
                            ),
                          ),
                        ),
                      ),
                    ]),
                  ),
                );
              }),
            ]),
          ),
        ),
      ),
    );
  }
}
