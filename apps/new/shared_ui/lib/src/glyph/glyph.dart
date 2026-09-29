import 'package:flutter/widgets.dart';

import 'glyph_data.dart';
import 'glyph_shape.dart';
import 'svg_path.dart';

/// The SupremeOS icon family — one hairline set on a 24 grid (1.4 stroke, round ends, at most one
/// tonal plane), drawn for this product. It is the ONLY icon vocabulary of the homeowner UI:
/// Material icons are not part of the Golden Master.
///
/// A glyph takes the colour of the surrounding [IconTheme] (the Golden Master's `currentColor`) unless
/// [color] is given. Without a [semanticLabel] it is decorative and hidden from assistive technology;
/// with one it is a meaningful image.
class SupremeGlyph extends StatelessWidget {
  /// A canonical concept ("home", "control"…), one of the Golden Master's concept names
  /// ("Home", "Control"…), or a generic alias ("tune" → control).
  final String name;
  final double size;
  final Color? color;
  final String? semanticLabel;

  const SupremeGlyph(this.name,
      {super.key, this.size = 24, this.color, this.semanticLabel});

  /// The canonical name for [name], or null when the family has no such glyph.
  static String? resolve(String name) {
    if (kSupremeGlyphs.containsKey(name)) return name;
    final concept = kSupremeGlyphConcepts[name];
    if (concept != null && kSupremeGlyphs.containsKey(concept)) return concept;
    final alias = kSupremeGlyphAliases[name];
    if (alias != null && kSupremeGlyphs.containsKey(alias)) return alias;
    return null;
  }

  /// Every canonical glyph name.
  static Iterable<String> get names => kSupremeGlyphs.keys;

  @override
  Widget build(BuildContext context) {
    final canonical = resolve(name);
    assert(canonical != null, 'No SupremeGlyph named "$name"');
    final c = color ?? IconTheme.of(context).color ?? const Color(0xFFF7F6F2);
    Widget w = SizedBox(
      width: size,
      height: size,
      child: canonical == null
          ? null
          : CustomPaint(painter: _GlyphPainter(canonical, c)),
    );
    if (semanticLabel != null) {
      w = Semantics(label: semanticLabel, image: true, child: ExcludeSemantics(child: w));
    } else {
      w = ExcludeSemantics(child: w);
    }
    return w;
  }
}

/// The geometry of a glyph as [Path]s — exposed for tests and for measuring, not for drawing
/// (draw with [SupremeGlyph]).
@visibleForTesting
List<Path> supremeGlyphPaths(String canonicalName) =>
    [for (final s in kSupremeGlyphs[canonicalName]!) _pathOf(s)];

const _grid = 24.0;
const _strokeWidth = 1.4;

final Map<GlyphShape, Path> _pathCache = {};

Path _pathOf(GlyphShape s) => _pathCache.putIfAbsent(s, () {
      if (s.d != null) return parseSvgPath(s.d!);
      if (s.r != null) {
        return Path()
          ..addOval(Rect.fromCircle(center: Offset(s.cx!, s.cy!), radius: s.r!));
      }
      final rect = Rect.fromLTWH(s.x!, s.y!, s.w!, s.h!);
      return (s.rx ?? 0) > 0
          ? (Path()..addRRect(RRect.fromRectXY(rect, s.rx!, s.rx!)))
          : (Path()..addRect(rect));
    });

class _GlyphPainter extends CustomPainter {
  final String name;
  final Color color;
  _GlyphPainter(this.name, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / _grid, size.height / _grid);
    for (final s in kSupremeGlyphs[name]!) {
      final path = _pathOf(s);
      if (s.fill > 0) {
        canvas.drawPath(
            path,
            Paint()
              ..style = PaintingStyle.fill
              ..color = color.withValues(alpha: color.a * s.fill));
      }
      if (s.stroke) {
        final paint = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = _strokeWidth
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round
          ..color = color.withValues(alpha: color.a * s.strokeOpacity);
        canvas.drawPath(s.dash == null ? path : _dashed(path, s.dash!), paint);
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GlyphPainter old) => old.name != name || old.color != color;
}

/// A dashed copy of [source]: `dash` is the on/off pattern in grid units.
Path _dashed(Path source, List<double> dash) {
  final out = Path();
  for (final metric in source.computeMetrics()) {
    var d = 0.0, i = 0;
    var on = true;
    while (d < metric.length) {
      final len = dash[i % dash.length];
      final end = (d + len).clamp(0.0, metric.length);
      if (on) out.addPath(metric.extractPath(d, end), Offset.zero);
      d += len;
      i++;
      on = !on;
    }
  }
  return out;
}

