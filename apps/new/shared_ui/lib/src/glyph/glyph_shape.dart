/// One drawn element of a SupremeGlyph, in the glyph's 24×24 grid. A shape is a stroke, a tonal
/// fill, or both — never a colour: the colour is the surrounding text/icon colour, exactly like
/// the Golden Master's `currentColor`.
class GlyphShape {
  /// SVG path data (`d`) for a path; null for rect / circle.
  final String? d;
  final double? x, y, w, h, rx;
  final double? cx, cy, r;

  /// 0 means "not filled"; otherwise the fill opacity (the tonal plane).
  final double fill;
  final bool stroke;
  final double strokeOpacity;

  /// On/off lengths in grid units, or null for a solid stroke.
  final List<double>? dash;

  const GlyphShape.path(String this.d,
      {this.fill = 0, this.stroke = true, this.strokeOpacity = 1, this.dash})
      : x = null,
        y = null,
        w = null,
        h = null,
        rx = null,
        cx = null,
        cy = null,
        r = null;

  const GlyphShape.rect(double this.x, double this.y, double this.w,
      double this.h,
      {this.rx = 0,
      this.fill = 0,
      this.stroke = true,
      this.strokeOpacity = 1,
      this.dash})
      : d = null,
        cx = null,
        cy = null,
        r = null;

  const GlyphShape.circle(double this.cx, double this.cy, double this.r,
      {this.fill = 0,
      this.stroke = true,
      this.strokeOpacity = 1,
      this.dash})
      : d = null,
        x = null,
        y = null,
        w = null,
        h = null,
        rx = null;
}
