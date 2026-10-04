import 'dart:convert';
import 'dart:io';

import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records every visible text run in the render tree — where it is and how it is set — in the same
/// shape `tools/golden-master-verify/probe.mjs` records the Golden Master's, so
/// `typography.mjs` can match the two by text. Positions are logical px from the view's origin.
List<Map<String, Object?>> probeRuns(WidgetTester tester, Size logical) {
  final out = <Map<String, Object?>>[];
  final view = Offset.zero & logical;
  List<int> rgb(Color c) =>
      [(c.r * 255).round(), (c.g * 255).round(), (c.b * 255).round()];

  void visit(RenderObject o) {
    if (o is RenderOffstage && o.offstage) return;
    if (o is RenderOpacity && o.opacity == 0) return;
    if (o is RenderAnimatedOpacity && o.opacity.value == 0) return;
    if (o is RenderParagraph && o.hasSize) {
      final text = o.text
          .toPlainText(includeSemanticsLabels: false)
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim();
      final span = o.text;
      final style = span is TextSpan ? span.style : null;
      if (text.isNotEmpty && style != null) {
        final tl = o.localToGlobal(Offset.zero);
        final r = tl & o.size;
        if (r.overlaps(view)) {
          final c = style.color ?? const Color(0xFF000000);
          out.add({
            'text': text,
            'x': double.parse(r.left.toStringAsFixed(2)),
            'y': double.parse(r.top.toStringAsFixed(2)),
            'w': double.parse(r.width.toStringAsFixed(2)),
            'h': double.parse(r.height.toStringAsFixed(2)),
            'fontSize': style.fontSize,
            'fontWeight': style.fontWeight?.value ?? 400,
            'letterSpacing': style.letterSpacing ?? 0,
            'lineHeight': style.height == null || style.fontSize == null
                ? null
                : style.height! * style.fontSize!,
            'color': [...rgb(c), double.parse(c.a.toStringAsFixed(3))],
            'family': (style.fontFamily ?? '').split('/').last,
            'upper': false,
          });
        }
      }
    }
    o.visitChildren(visit);
  }

  visit(tester.binding.renderViews.first);
  return out;
}

void writeProbe(String path, List<Map<String, Object?>> runs) {
  File(path)
    ..createSync(recursive: true)
    ..writeAsStringSync(const JsonEncoder.withIndent(' ').convert(runs));
}
