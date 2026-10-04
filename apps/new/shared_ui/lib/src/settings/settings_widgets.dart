import 'package:flutter/material.dart' show Material, MaterialType;
import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/surface_scope.dart';
import '../glyph/glyph.dart';
import '../shell/supreme_tappable.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_curves.dart';
import '../theme/supreme_theme.dart';

SupremeTextStyles get _t => SupremeTextStyles.resolve(SupremeDensity.comfortable);

/// A settings section (Golden Master `.sos-set`): a serif title and its content, in two columns
/// (title 180–260 wide, then the content) from 760 dp, stacked below it; a hairline above.
class SettingsSection extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const SettingsSection({super.key, required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    final p = SurfaceScope.of(context);
    final watch = p.skeleton == SurfaceSkeleton.watch;
    final wide = p.widthDp >= 760 && !watch;
    final heading = Text(title,
        style: _t.name.copyWith(fontSize: watch ? 18 : wide ? 26 : 24, height: 1.15));
    final body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
    return Container(
      padding: EdgeInsets.symmetric(vertical: wide ? 34 : 26),
      decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: SupremeColorScheme.rule))),
      child: wide
          ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 260, child: heading),
              const SizedBox(width: 48),
              Expanded(child: body),
            ])
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              heading,
              const SizedBox(height: 10),
              body,
            ]),
    );
  }
}

/// One fact: a quiet label and its value in the serif (Golden Master `.sos-dl`).
class SettingsFact extends StatelessWidget {
  final String label;
  final String value;
  const SettingsFact(this.label, this.value, {super.key});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: _t.body.copyWith(fontSize: 14, color: SupremeColorScheme.text3)),
          const SizedBox(width: 16),
          Expanded(
              child: Text(value,
                  textAlign: TextAlign.end, style: _t.name.copyWith(fontSize: 19))),
        ]),
      );
}

/// A way in to a sub-page: serif label, a line of what is inside, a drawn chevron.
class SettingsLink extends StatelessWidget {
  final String label;
  final String summary;
  final VoidCallback onTap;
  const SettingsLink(
      {super.key, required this.label, required this.summary, required this.onTap});

  @override
  Widget build(BuildContext context) => SupremeTappable(
        onTap: onTap,
        semanticLabel: '$label. $summary',
        radius: 4,
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 2),
          decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
          child: Row(children: [
            Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(label, style: _t.name.copyWith(fontSize: 21)),
                    if (summary.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(summary,
                            style: _t.body.copyWith(fontSize: 13, color: SupremeColorScheme.text3)),
                      ),
                  ]),
            ),
            const SizedBox(width: 12, height: 16, child: CustomPaint(painter: _Chev())),
          ]),
        ),
      );
}

/// The Golden Master's consequential action (`.sos-danger`): one quiet pill set apart from the
/// rows — 44 high, 18 across, a hairline border `rgba(220,150,130,.45)`, text `#e9c3b6` at 14,
/// 12 above it. Used for the single act that ends something (leaving a simulated residence).
class SettingsActionPill extends StatelessWidget {
  final String text;
  final VoidCallback onTap;
  const SettingsActionPill(this.text, {super.key, required this.onTap});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Align(
          alignment: Alignment.centerLeft,
          child: IntrinsicWidth(
            child: SupremeTappable(
              onTap: onTap,
              semanticLabel: text,
              radius: 999,
              child: Container(
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(horizontal: 18),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: const Color(0x73DC9682)),
                ),
                child: Text(text,
                    style: _t.body
                        .copyWith(fontSize: 14, color: const Color(0xFFE9C3B6))),
              ),
            ),
          ),
        ),
      );
}

class _Chev extends CustomPainter {
  const _Chev();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawPath(
        Path()
          ..moveTo(1.5, 1.5)
          ..lineTo(size.width - 1.5, size.height / 2)
          ..lineTo(1.5, size.height - 1.5),
        Paint()
          ..color = const Color(0x59F7F4EE)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round);
  }

  @override
  bool shouldRepaint(_Chev o) => false;
}

/// A labelled choice row: the serif label and a segmented choice (Golden Master `.sos-choice-row`
/// and `.sos-seg`): pill options, the chosen one edged and washed in brass.
class SettingsChoice<T> extends StatelessWidget {
  final String label;
  final List<T> options;
  final T value;
  final String Function(T) name;
  final ValueChanged<T> onChanged;
  const SettingsChoice(
      {super.key,
      required this.label,
      required this.options,
      required this.value,
      required this.name,
      required this.onChanged});

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(minHeight: 64),
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: 8,
          spacing: 16,
          children: [
            Text(label, style: _t.name.copyWith(fontSize: 19)),
            Semantics(
              container: true,
              label: label,
              child: Wrap(spacing: 6, runSpacing: 6, children: [
                for (final o in options)
                  IntrinsicWidth(
                    child: SupremeTappable(
                    key: ValueKey('choice-$label-${name(o)}'),
                    onTap: () => onChanged(o),
                    semanticLabel: name(o),
                    selected: o == value,
                    radius: 999,
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 40, minWidth: 44),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                            color: o == value
                                ? SupremeColorScheme.brass
                                : const Color(0x24FFFFFF)),
                        color: o == value ? const Color(0x26B48A4F) : null,
                      ),
                      child: Text(name(o),
                          style: _t.body.copyWith(
                              fontSize: 14,
                              color: o == value
                                  ? SupremeColorScheme.champagne
                                  : const Color(0xD1F7F4EE))),
                    ),
                  )),
              ]),
            ),
          ],
        ),
      );
}

/// A sub-page's header: a quiet back chip, then kicker, title and a lede.
class SettingsSubHead extends StatelessWidget {
  final String back;
  final VoidCallback onBack;
  final String kicker;
  final String title;
  final String? lede;
  const SettingsSubHead(
      {super.key,
      required this.back,
      required this.onBack,
      required this.kicker,
      required this.title,
      this.lede});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 26),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: SupremeTappable(
              key: const ValueKey('settings-back'),
              onTap: onBack,
              semanticLabel: 'Back to $back',
              radius: 999,
              child: Container(
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: SupremeColorScheme.rule),
                    color: SupremeColorScheme.veil),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const SizedBox(width: 2),
                  const SupremeGlyph('arrow_back', size: 18),
                  const SizedBox(width: 8),
                  Text(back, style: _t.body.copyWith(fontSize: 14)),
                ]),
              ),
            ),
          ),
          Text(kicker.toUpperCase(), style: _t.kicker.copyWith(letterSpacing: 12 * .24)),
          const SizedBox(height: 4),
          Text(title, style: _t.pageTitle.copyWith(fontSize: 34, height: 1.0)),
          if (lede != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(lede!,
                  style: _t.body.copyWith(
                      fontSize: 17, fontWeight: FontWeight.w300, color: SupremeColorScheme.text2)),
            ),
        ]),
      );
}

/// A quiet dialog in the shell's own surface — a serif title, words, and acts (no Material dialog).
Future<T?> showSupremeDialog<T>(
  BuildContext context, {
  required String title,
  required WidgetBuilder body,
  required List<Widget> Function(BuildContext) actions,
}) =>
    showGeneralDialog<T>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Close',
      barrierColor: SupremeColorScheme.veil,
      transitionDuration: const Duration(milliseconds: 250),
      pageBuilder: (c, _, __) => SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Material(
              type: MaterialType.transparency,
              child: Container(
                margin: const EdgeInsets.all(20),
                padding: const EdgeInsets.fromLTRB(24, 22, 24, 12),
                decoration: BoxDecoration(
                  color: SupremeColorScheme.glassSolid,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: SupremeColorScheme.glassEdge),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: _t.name.copyWith(fontSize: 24)),
                    const SizedBox(height: 14),
                    body(c),
                    const SizedBox(height: 8),
                    Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                      for (final a in actions(c)) ...[const SizedBox(width: 8), a],
                    ]),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      transitionBuilder: (c, a, _, child) => FadeTransition(
          opacity: CurvedAnimation(parent: a, curve: SupremeMotionCurves.settle), child: child),
    );
