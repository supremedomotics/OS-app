import 'dart:math' as math;

import 'package:flutter/material.dart'
    show TextField, InputDecoration, UnderlineInputBorder, BorderSide;
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The Golden Master onboarding's values, as `SupremeOS_Onboarding_frozen.html` declares them (its
/// `:root`, type scale, `.btn` / `.link` / `.field` / `.meta` / `.eyebrow` rules and media queries).
/// Nothing here is a Flutter interpretation: each constant names the CSS it comes from.
abstract final class Gm {
  // :root
  static const bg = Color(0xFFF7F4EE); // --bg
  static const panel = Color(0xFFEFE9DF); // --panel
  static const ink = Color(0xFF2D2A25); // --ink
  static const ink2 = Color(0xFF5B554C); // --ink-2
  static const ink3 = Color(0xFF8A8277); // --ink-3
  static const gold = Color(0xFFA78048); // --gold
  static const goldSoft = Color.fromRGBO(167, 128, 72, .14); // --gold-soft
  static const line = Color.fromRGBO(45, 42, 37, .14); // --line
  static const lineStrong = Color.fromRGBO(45, 42, 37, .32); // --line-strong
  static const error = Color(0xFF9A3B2C); // --error
  static const ease = Cubic(.2, .7, .2, 1); // --ease
  static const btnHover = Color(0xFF1E1C19); // .btn:hover

  /// `--sans` at the body weight (300) unless a rule says 400.
  static TextStyle sans(double size, Color color,
          {FontWeight weight = FontWeight.w300,
          double? height,
          double letterSpacing = 0}) =>
      TextStyle(
        fontFamily: SupremeFonts.sans,
        package: SupremeFonts.package,
        fontSize: size,
        fontWeight: weight,
        height: height,
        letterSpacing: letterSpacing,
        color: color,
        decoration: TextDecoration.none,
      );

  /// `--serif` (300).
  static TextStyle serif(double size, Color color,
          {double height = 1.04, double letterSpacing = 0}) =>
      TextStyle(
        fontFamily: SupremeFonts.serif,
        package: SupremeFonts.package,
        fontSize: size,
        fontWeight: FontWeight.w300,
        height: height,
        letterSpacing: letterSpacing,
        color: color,
        decoration: TextDecoration.none,
      );
}

double _clamp(double lo, double v, double hi) => math.min(hi, math.max(lo, v));

/// The responsive rules of the frozen CSS, evaluated for the area the flow is given
/// (`w` × `h` stand in for the viewport's `vw` / `dvh`).
class GmMetrics {
  final double w, h;
  const GmMetrics(this.w, this.h);

  bool get landscape => w >= h;

  /// `@media (min-width:1800px) and (min-height:1000px)` — wall-mounted and large displays.
  bool get big => w >= 1800 && h >= 1000;

  /// `@media (max-height:520px) and (orientation:landscape)`.
  bool get shortLandscape => h <= 520 && landscape;

  /// `@media (max-width:900px),(orientation:portrait)` — one column.
  bool get narrow => w <= 900 || !landscape;

  /// The grid is one column unless the short-landscape rule re-splits it.
  bool get singleColumn => narrow && !shortLandscape;

  /// `@media (max-width:520px)` — actions stack, the button stretches.
  bool get phone => w <= 520;

  /// `--gutter: clamp(20px, 4.5vw, 64px)` — and never more than half the width there is, so that
  /// the two gutters can't exceed the area (Android lays the surface out at ~0 px first; a
  /// negative constraint is not a layout).
  double get gutter => math.min(_clamp(20, .045 * w, 64), math.max(0, w) / 2);
  double get mainPadV => _clamp(28, .05 * h, 64);
  double get headerPad => shortLandscape ? 16 : 28;
  double get columnGap => narrow ? 28 : _clamp(32, .06 * w, 96);
  double get leftFr => shortLandscape ? .8 : 1.05;
  double get screensMaxWidth => big ? 620 : (narrow ? double.infinity : 520);

  double get h1Size => shortLandscape ? 40 : _clamp(44, .054 * w, 74);
  double get h2Size => _clamp(34, .036 * w, 48);
  double get ledeSize => big ? 21 : 17;
  double get inputSize => big ? 20 : 17;
  double get inputHeight => big ? 54 : 46;
  double get smallCaps => big ? 13 : 11; // .field label, .eyebrow, .meta
  double get altSize => big ? 17 : 15;
  double get btnHeight => big ? 60 : 52;
  double get btnSize => big ? 14 : 12;
  double get btnPadH => big ? 34 : 28;

  /// `.panel`: `aspect-ratio` 4/3.4 (16/7 in one column, 1/1 in short landscape) and
  /// `max-height: calc(100dvh - 190px)` (none in the narrow rule).
  double panelHeight(double width) {
    final ratio = shortLandscape ? 1.0 : (singleColumn ? 7 / 16 : 3.4 / 4);
    final natural = width * ratio;
    return math.max(0, narrow ? natural : math.min(natural, h - 190));
  }
}

/// Two auto-sized grid rows with a gap, as the frozen CSS lays out its single column
/// (`main.stagewrap { display: grid; gap: 28px }` inside `.app { grid-template-rows: auto 1fr }`).
///
/// A CSS grid stretches its `auto` tracks to fill the container, giving each an equal share of the
/// free space; items sit at the start of their track (`align-items: start`). So when the page is
/// taller than its content, the second row starts lower by half of what is left over — the
/// distance between the field panel and the screen below it is the gap *plus* that half.
class GmGridRows extends MultiChildRenderObjectWidget {
  final double gap;
  GmGridRows({super.key, required this.gap, required Widget first, required Widget second})
      : super(children: [first, second]);

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderGridRows(gap);

  @override
  void updateRenderObject(BuildContext context, covariant RenderObject renderObject) =>
      (renderObject as _RenderGridRows).gap = gap;
}

class _GridRowsParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderGridRows extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _GridRowsParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _GridRowsParentData> {
  _RenderGridRows(this._gap);
  double _gap;
  set gap(double v) {
    if (v == _gap) return;
    _gap = v;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _GridRowsParentData) child.parentData = _GridRowsParentData();
  }

  // `SliverFillRemaining` sizes its child from the intrinsic height: two rows and the gap.
  @override
  double computeMinIntrinsicHeight(double width) =>
      firstChild!.getMinIntrinsicHeight(width) +
      _gap +
      childAfter(firstChild!)!.getMinIntrinsicHeight(width);

  @override
  double computeMaxIntrinsicHeight(double width) =>
      firstChild!.getMaxIntrinsicHeight(width) +
      _gap +
      childAfter(firstChild!)!.getMaxIntrinsicHeight(width);

  @override
  double computeMinIntrinsicWidth(double height) => math.max(
      firstChild!.getMinIntrinsicWidth(height),
      childAfter(firstChild!)!.getMinIntrinsicWidth(height));

  @override
  double computeMaxIntrinsicWidth(double height) => math.max(
      firstChild!.getMaxIntrinsicWidth(height),
      childAfter(firstChild!)!.getMaxIntrinsicWidth(height));

  @override
  void performLayout() {
    final first = firstChild!, second = childAfter(first)!;
    final loose = BoxConstraints(maxWidth: constraints.maxWidth);
    first.layout(loose, parentUsesSize: true);
    second.layout(loose, parentUsesSize: true);
    final natural = first.size.height + _gap + second.size.height;
    final height = math.max(constraints.minHeight, natural);
    final extra = height - natural;
    (first.parentData! as _GridRowsParentData).offset = Offset.zero;
    (second.parentData! as _GridRowsParentData).offset =
        Offset(0, first.size.height + extra / 2 + _gap);
    size = constraints.constrain(Size(constraints.maxWidth, height));
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}

class GmScope extends InheritedWidget {
  final GmMetrics metrics;
  const GmScope({super.key, required this.metrics, required super.child});

  static GmMetrics of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<GmScope>()!.metrics;

  @override
  bool updateShouldNotify(GmScope old) =>
      old.metrics.w != metrics.w || old.metrics.h != metrics.h;
}

/// Text the Golden Master uppercases with CSS: drawn in capitals, announced as written.
class _Upper extends StatelessWidget {
  final String text;
  final TextStyle style;
  const _Upper(this.text, this.style);
  @override
  Widget build(BuildContext context) => Semantics(
      label: text,
      excludeSemantics: true,
      child: Text(text.toUpperCase(),
          textDirection: TextDirection.ltr, style: style));
}

// ── type ───────────────────────────────────────────────────────────────────────────────────

/// `.eyebrow`
class GmEyebrow extends StatelessWidget {
  final String text;
  const GmEyebrow(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: _Upper(
          text,
          Gm.sans(m.smallCaps, Gm.ink3,
              weight: FontWeight.w400, letterSpacing: .24 * m.smallCaps)),
    );
  }
}

/// `.meta` — a gold dot and a small uppercase line.
class GmMeta extends StatelessWidget {
  final String text;
  final double top, bottom;
  const GmMeta(this.text, {super.key, this.top = 0, this.bottom = 22});
  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    return Padding(
      padding: EdgeInsets.only(top: top, bottom: bottom),
      child: Row(children: [
        Container(
            width: 6,
            height: 6,
            decoration:
                const BoxDecoration(color: Gm.gold, shape: BoxShape.circle)),
        const SizedBox(width: 10),
        Expanded(
          child: _Upper(
              text,
              Gm.sans(m.smallCaps, Gm.ink2,
                  weight: FontWeight.w400, letterSpacing: .2 * m.smallCaps)),
        ),
      ]),
    );
  }
}

/// `h1` / `h2` — the serif at 300, `letter-spacing:-.005em`, `line-height:1.04`.
class GmHeading extends StatelessWidget {
  final String text;
  final bool h1;
  const GmHeading(this.text, {super.key, this.h1 = false});
  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    final size = h1 ? m.h1Size : m.h2Size;
    return Semantics(
      header: true,
      label: text.replaceAll('\n', ' '),
      excludeSemantics: true,
      child: Text(text,
          textDirection: TextDirection.ltr,
          style: Gm.serif(size, Gm.ink, letterSpacing: -.005 * size)),
    );
  }
}

/// `.lede` — 17/1.6, `--ink-2`, 22 above, at most 40ch (the width of forty "0"s).
class GmLede extends StatelessWidget {
  final String text;
  const GmLede(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    final style = Gm.sans(m.ledeSize, Gm.ink2, height: 1.6);
    final zero = (TextPainter(
            text: TextSpan(text: '0', style: style),
            textDirection: TextDirection.ltr)
          ..layout())
        .width;
    return Padding(
      padding: const EdgeInsets.only(top: 22),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 40 * zero),
        child: Text(text, textDirection: TextDirection.ltr, style: style),
      ),
    );
  }
}

// ── controls ───────────────────────────────────────────────────────────────────────────────

class _Arrow extends CustomPainter {
  final Color color;
  final bool back;
  const _Arrow(this.color, this.back);
  @override
  void paint(Canvas canvas, Size size) {
    // viewBox 0 0 16 16, stroke 1.2, no caps or joins set (butt / miter)
    final p = Path();
    if (back) {
      p
        ..moveTo(14, 8)
        ..lineTo(2, 8)
        ..moveTo(6.5, 3.5)
        ..lineTo(2, 8)
        ..lineTo(6.5, 12.5);
    } else {
      p
        ..moveTo(2, 8)
        ..lineTo(14, 8)
        ..moveTo(9.5, 3.5)
        ..lineTo(14, 8)
        ..lineTo(9.5, 12.5);
    }
    canvas.drawPath(
        p,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..color = color);
  }

  @override
  bool shouldRepaint(_Arrow o) => o.color != color || o.back != back;
}

class _StretchScope extends InheritedWidget {
  const _StretchScope({required super.child});
  static bool of(BuildContext c) =>
      c.dependOnInheritedWidgetOfExactType<_StretchScope>() != null;
  @override
  bool updateShouldNotify(_StretchScope old) => false;
}

/// `.btn` (and `.btn.quiet`): 52 high, 2-radius, ink fill / hairline, 12px 400 at .22em in
/// capitals, a 16px arrow 14 away; pressing scales to .985.
class GmButton extends StatefulWidget {
  final String text;
  final VoidCallback? onTap;
  final bool quiet;
  final bool arrow;
  final bool busy;
  const GmButton(this.text,
      {super.key,
      required this.onTap,
      this.quiet = false,
      this.arrow = false,
      this.busy = false});

  @override
  State<GmButton> createState() => _GmButtonState();
}

class _GmButtonState extends State<GmButton> {
  bool _down = false, _hover = false;

  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    final enabled = widget.onTap != null;
    final stretch = _StretchScope.of(context);
    final fg = widget.quiet ? Gm.ink : Gm.bg;
    final fill = widget.quiet
        ? null
        : (_hover && enabled ? Gm.btnHover : Gm.ink);
    final border = widget.quiet
        ? (_hover && enabled ? Gm.ink : Gm.lineStrong)
        : Gm.ink;
    final label = Text(widget.text.toUpperCase(),
        textDirection: TextDirection.ltr,
        style: Gm.sans(m.btnSize, fg,
            weight: FontWeight.w400, letterSpacing: .22 * m.btnSize));
    return Opacity(
      opacity: widget.busy ? .6 : (enabled ? 1 : .4),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: Listener(
          onPointerDown: (_) => setState(() => _down = true),
          onPointerUp: (_) => setState(() => _down = false),
          onPointerCancel: (_) => setState(() => _down = false),
          child: AnimatedScale(
            scale: _down && enabled ? .985 : 1,
            duration: const Duration(milliseconds: 120),
            child: SupremeTappable(
              onTap: widget.onTap ?? () {},
              semanticLabel: widget.text,
              radius: 2,
              child: Container(
                constraints: BoxConstraints(minHeight: m.btnHeight),
                padding: EdgeInsets.symmetric(horizontal: m.btnPadH),
                decoration: BoxDecoration(
                  color: fill,
                  borderRadius: BorderRadius.circular(2),
                  border: Border.all(color: border),
                ),
                child: Row(
                  mainAxisSize: stretch ? MainAxisSize.max : MainAxisSize.min,
                  mainAxisAlignment: stretch
                      ? MainAxisAlignment.spaceBetween
                      : MainAxisAlignment.start,
                  children: [
                    // A long label wraps inside the button, as the inline-flex `.btn` does.
                    Flexible(child: label),
                    if (widget.arrow) ...[
                      const SizedBox(width: 14),
                      CustomPaint(
                          size: const Size(16, 16),
                          painter: _Arrow(fg, false)),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// `.link` with the back arrow: 44 high, 12px at .2em in capitals, `--ink-2`.
class GmBack extends StatelessWidget {
  final VoidCallback? onTap;
  const GmBack({super.key, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onTap == null ? .4 : 1,
      child: SupremeTappable(
        onTap: onTap ?? () {},
        semanticLabel: 'Back',
        radius: 2,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            CustomPaint(
                size: const Size(16, 16), painter: const _Arrow(Gm.ink2, true)),
            const SizedBox(width: 10),
            Text('BACK',
                textDirection: TextDirection.ltr,
                style: Gm.sans(12, Gm.ink2, letterSpacing: .2 * 12)),
          ]),
        ),
      ),
    );
  }
}

/// `.actions` — a row, space-between, 36 above; on a phone the controls stack (`column-reverse`)
/// and the button stretches.
class GmActions extends StatelessWidget {
  final List<Widget> children;
  final double top;
  const GmActions(this.children, {super.key, this.top = 36});

  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    if (m.phone) {
      return Padding(
        padding: EdgeInsets.only(top: top),
        child: _StretchScope(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children.reversed.toList()),
        ),
      );
    }
    return Padding(
      padding: EdgeInsets.only(top: top),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 16,
        runSpacing: 16,
        children: children,
      ),
    );
  }
}

/// `.alt` — a quiet line (15px, `--ink-2`) with an inline link (14px, underlined).
class GmAlt extends StatelessWidget {
  final String text;
  final String? link;
  final VoidCallback? onTap;
  const GmAlt({super.key, required this.text, this.link, this.onTap});

  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 28),
      child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
        Text(text,
            textDirection: TextDirection.ltr,
            style: Gm.sans(m.altSize, Gm.ink2)),
        if (link != null)
          SupremeTappable(
            onTap: onTap ?? () {},
            semanticLabel: link!,
            radius: 2,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Center(
                widthFactor: 1,
                child: Text(link!,
                    textDirection: TextDirection.ltr,
                    style: Gm.sans(14, Gm.ink2).copyWith(
                        decoration: TextDecoration.underline,
                        decorationColor: Gm.ink2)),
              ),
            ),
          ),
      ]),
    );
  }
}

// ── forms ──────────────────────────────────────────────────────────────────────────────────

/// `form { margin-top: 34px }`
class GmForm extends StatelessWidget {
  final List<Widget> children;
  final double top;
  const GmForm(this.children, {super.key, this.top = 34});
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(top: top),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: children),
      );
}

/// `.field`: a 400 capital label, a 46-high underlined input (17px, 300), an error or hint below.
class GmField extends StatelessWidget {
  final String label;
  final String hint;
  final String? hintBelow;
  final String? error;
  final TextEditingController controller;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  const GmField({
    super.key,
    required this.label,
    required this.hint,
    required this.controller,
    this.hintBelow,
    this.error,
    this.onChanged,
    this.onSubmitted,
  });

  @override
  Widget build(BuildContext context) {
    final m = GmScope.of(context);
    final invalid = error != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 26),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: _Upper(
                label,
                Gm.sans(m.smallCaps, Gm.ink2,
                    weight: FontWeight.w400, letterSpacing: .2 * m.smallCaps)),
          ),
          SizedBox(
            height: m.inputHeight,
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              autocorrect: false,
              style: Gm.sans(m.inputSize, Gm.ink),
              cursorColor: Gm.ink,
              cursorWidth: 1,
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: Gm.sans(m.inputSize, Gm.ink3),
                contentPadding: const EdgeInsets.only(right: 40),
                isCollapsed: false,
                enabledBorder: UnderlineInputBorder(
                    borderSide: BorderSide(
                        color: invalid ? Gm.error : Gm.lineStrong, width: 1)),
                focusedBorder: UnderlineInputBorder(
                    borderSide: BorderSide(
                        color: invalid ? Gm.error : Gm.gold, width: 1)),
              ),
            ),
          ),
          if (invalid)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(error!,
                  textDirection: TextDirection.ltr,
                  style: Gm.sans(13, Gm.error)),
            )
          else if (hintBelow != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(hintBelow!,
                  textDirection: TextDirection.ltr,
                  style: Gm.sans(13, Gm.ink3, height: 1.5)),
            ),
        ],
      ),
    );
  }
}

/// `.formerr` — 14px, `--error`, 18 below.
class GmFormError extends StatelessWidget {
  final String text;
  const GmFormError(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Semantics(
          liveRegion: true,
          child: Text(text,
              textDirection: TextDirection.ltr, style: Gm.sans(14, Gm.error)),
        ),
      );
}

/// `.divider.disclose` — a quiet line-flanked label that opens a folded form ("or connect manually").
class GmDisclose extends StatelessWidget {
  final String label;
  final bool open;
  final VoidCallback onTap;
  const GmDisclose({super.key, required this.label, required this.open, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final line = Expanded(child: Container(height: 1, color: Gm.line));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 26),
      child: SupremeTappable(
        onTap: onTap,
        semanticLabel: label,
        selected: open,
        radius: 2,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(children: [
            line,
            const SizedBox(width: 16),
            Text(label.toUpperCase(),
                textDirection: TextDirection.ltr,
                style: Gm.sans(11, Gm.ink2, letterSpacing: .22 * 11)),
            const SizedBox(width: 16),
            line,
          ]),
        ),
      ),
    );
  }
}

/// The recovery screen's `.formerr`: no alarm colour — ink, with a hairline of gold at its edge.
class GmFormNote extends StatelessWidget {
  final String main;
  final String sub;
  const GmFormNote({super.key, required this.main, required this.sub});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.only(left: 14),
            decoration: const BoxDecoration(border: Border(left: BorderSide(color: Gm.gold))),
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: main, style: Gm.sans(14, Gm.ink, height: 1.55)),
                TextSpan(text: sub, style: Gm.sans(14, Gm.ink2, height: 1.55)),
              ]),
              textDirection: TextDirection.ltr,
            ),
          ),
        ),
      );
}
