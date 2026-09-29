import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/src/glyph/svg_path.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The SupremeOS icon family, ported from the Golden Master's own definitions, and the SVG path
/// parser that draws it.
Rect _b(String d) => parseSvgPath(d).getBounds();

/// The true extent of a path. `Path.getBounds()` includes curve control points, which lie outside
/// an arc, so a tight box needs the curve itself.
Rect _tight(Path p) {
  var l = double.infinity, t = double.infinity, r = -double.infinity, b = -double.infinity;
  for (final m in p.computeMetrics()) {
    for (var i = 0; i <= 64; i++) {
      final o = m.getTangentForOffset(m.length * i / 64)!.position;
      if (o.dx < l) l = o.dx;
      if (o.dx > r) r = o.dx;
      if (o.dy < t) t = o.dy;
      if (o.dy > b) b = o.dy;
    }
  }
  return Rect.fromLTRB(l, t, r, b);
}

void main() {
  group('svg path parser', () {
    test('absolute and relative lines, H and V', () {
      expect(_b('M4 8.5h17.5'), const Rect.fromLTRB(4, 8.5, 21.5, 8.5));
      expect(_b('M9.5 19.5h6.5v-11'), const Rect.fromLTRB(9.5, 8.5, 16, 19.5));
      expect(_b('M1 2L4 6H2V9'), const Rect.fromLTRB(1, 2, 4, 9));
    });

    test('a closed path returns to its start', () {
      final p = parseSvgPath('M0 0h10v10h-10z');
      expect(p.contains(const Offset(5, 5)), isTrue);
      expect(p.getBounds(), const Rect.fromLTRB(0, 0, 10, 10));
    });

    test('implicit repeated commands: pairs after M are lines, after m relative lines', () {
      expect(_b('M0 0 10 0 10 10'), const Rect.fromLTRB(0, 0, 10, 10));
      expect(_b('m1 1 2 0 0 3'), const Rect.fromLTRB(1, 1, 3, 4));
    });

    test('compact numbers: "5-2" and ".5.5" split correctly', () {
      expect(_b('M0 0l5-2'), const Rect.fromLTRB(0, -2, 5, 0));
      expect(_b('M0 0L.5.5'), const Rect.fromLTRB(0, 0, .5, .5));
    });

    test('an arc: a semicircle of radius 5 spans 10 across and 5 up', () {
      final r = _b('M0 5a5 5 0 0 1 10 0');
      expect(r.left, closeTo(0, 1e-6));
      expect(r.right, closeTo(10, 1e-6));
      expect(r.height, closeTo(5, 1e-6));
      expect(r.top, closeTo(0, 1e-6), reason: 'sweep=1 goes over the top in screen space');
    });

    test('arc flags may be written without separators', () {
      final a = _b('M0 5a5 5 0 0110 0');
      final b = _b('M0 5a5 5 0 0 1 10 0');
      expect(a, b);
    });

    test('cubic and smooth-cubic curves', () {
      final r = _b('M3.5 8.5c2.8-2 5.7-2 8.5 0s5.7 2 8.5 0');
      expect(r.left, closeTo(3.5, 1e-6));
      expect(r.right, closeTo(20.5, 1e-6));
      expect(r.top, lessThan(8.5), reason: 'the wave rises above its baseline');
      expect(r.bottom, greaterThan(8.5), reason: 'and dips below it');
    });

    test('a zero radius arc is a straight line', () {
      expect(_b('M0 0a0 0 0 0 1 4 4'), const Rect.fromLTRB(0, 0, 4, 4));
    });

    test('an unknown command is an error, never a silent wrong drawing', () {
      expect(() => parseSvgPath('M0 0X1 1'), throwsFormatException);
      expect(() => parseSvgPath('10 10'), throwsFormatException);
    });
  });

  group('the glyph family', () {
    test('it has the Golden Master\'s 19 glyphs, and the five navigation concepts', () {
      expect(SupremeGlyph.names.length, 19);
      for (final n in ['home', 'space', 'control', 'transform', 'calibration']) {
        expect(SupremeGlyph.resolve(n), n);
      }
    });

    test('concept names and generic aliases resolve to canonical glyphs', () {
      expect(SupremeGlyph.resolve('Home'), 'home');
      expect(SupremeGlyph.resolve('Control'), 'control');
      expect(SupremeGlyph.resolve('tune'), 'control');
      expect(SupremeGlyph.resolve('auto_awesome'), 'transform');
      expect(SupremeGlyph.resolve('settings'), 'calibration');
      expect(SupremeGlyph.resolve('space_dashboard'), 'space');
      expect(SupremeGlyph.resolve('nope'), isNull);
    });

    test('every glyph parses and stays on its 24 grid', () {
      for (final name in SupremeGlyph.names) {
        final paths = supremeGlyphPaths(name);
        expect(paths, isNotEmpty, reason: name);
        for (final p in paths) {
          final b = _tight(p);
          expect(b.left, greaterThanOrEqualTo(-0.01), reason: name);
          expect(b.top, greaterThanOrEqualTo(-0.01), reason: name);
          expect(b.right, lessThanOrEqualTo(24.01), reason: name);
          expect(b.bottom, lessThanOrEqualTo(24.01), reason: name);
        }
      }
    });

    testWidgets('every glyph draws ink, in the requested colour and nowhere else', (tester) async {
      const ink = Color(0xFFC9A66B);
      for (final name in SupremeGlyph.names) {
        final key = GlobalKey();
        await tester.pumpWidget(Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: RepaintBoundary(
              key: key,
              child: SupremeGlyph(name, size: 48, color: ink),
            ),
          ),
        ));
        final boundary =
            tester.renderObject<RenderRepaintBoundary>(find.byKey(key));
        final data = await tester.runAsync(() async {
          final image = await boundary.toImage();
          return image.toByteData(format: ui.ImageByteFormat.rawStraightRgba);
        });
        final px = data!.buffer.asUint8List();
        var painted = 0, wrongHue = 0;
        for (var i = 0; i < px.length; i += 4) {
          if (px[i + 3] == 0) continue;
          painted++;
          // Any well-covered pixel must be the requested colour (antialiasing only changes alpha).
          // Near-transparent pixels are skipped: un-premultiplying 8-bit data cannot recover a
          // colour from an alpha of a few /255.
          if (px[i + 3] < 64) continue;
          if ((px[i] - 0xC9).abs() > 2 ||
              (px[i + 1] - 0xA6).abs() > 2 ||
              (px[i + 2] - 0x6B).abs() > 2) {
            wrongHue++;
          }
        }
        expect(painted, greaterThan(30), reason: '$name drew (almost) nothing');
        expect(wrongHue, 0, reason: '$name drew outside the requested colour');
      }
    });

    testWidgets('the tonal plane is a translucent fill, not a solid one', (tester) async {
      // "home" carries a 32 % plane; its strokes are full strength. So the image must contain
      // both faint and strong ink.
      final key = GlobalKey();
      await tester.pumpWidget(Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: RepaintBoundary(
            key: key,
            child: const SupremeGlyph('home', size: 96, color: Color(0xFFFFFFFF)),
          ),
        ),
      ));
      final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(key));
      final data = await tester.runAsync(() async {
        final image = await boundary.toImage();
        return image.toByteData(format: ui.ImageByteFormat.rawStraightRgba);
      });
      final px = data!.buffer.asUint8List();
      var faint = 0, strong = 0;
      for (var i = 3; i < px.length; i += 4) {
        if (px[i] > 60 && px[i] < 110) faint++;
        if (px[i] > 240) strong++;
      }
      expect(faint, greaterThan(200), reason: 'the plane should read as ~32 % ink');
      expect(strong, greaterThan(50), reason: 'the strokes should be solid');
    });

    testWidgets('a glyph without a label is decorative; with one it is an image', (tester) async {
      await tester.pumpWidget(const Directionality(
        textDirection: TextDirection.ltr,
        child: Column(children: [
          SupremeGlyph('home'),
          SupremeGlyph('control', semanticLabel: 'Control'),
        ]),
      ));
      expect(find.bySemanticsLabel('Control'), findsOneWidget);
      final handle = tester.ensureSemantics();
      expect(find.bySemanticsLabel('home'), findsNothing);
      handle.dispose();
    });

    testWidgets('it takes the surrounding icon colour and the given size', (tester) async {
      await tester.pumpWidget(const Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: IconTheme(
            data: IconThemeData(color: Color(0xFFC9A66B)),
            child: SupremeGlyph('space', size: 40),
          ),
        ),
      ));
      expect(tester.getSize(find.byType(SupremeGlyph)), const Size(40, 40));
      expect(tester.takeException(), isNull);
    });
  });
}
