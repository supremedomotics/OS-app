import 'dart:ui';

/// Parses SVG path data into a Flutter [Path]. Supports the commands the SupremeOS glyph family
/// (and ordinary icon sets) use: M m L l H h V v C c S s Q q A a Z z, with implicit repeated
/// commands, compact numbers ("1.2.5", "5-2") and compact arc flags. An unknown command throws —
/// a glyph must never silently draw the wrong thing.
Path parseSvgPath(String d) {
  final path = Path();
  final t = _Tokens(d);
  var cx = 0.0, cy = 0.0; // current point
  var sx = 0.0, sy = 0.0; // start of subpath
  double? lcx, lcy; // last cubic control point, reflected by S
  String? cmd;

  while (true) {
    t.skipSeparators();
    if (t.done) break;
    if (t.peekIsCommand) {
      cmd = t.readCommand();
    } else if (cmd == null) {
      throw FormatException('path data must start with a command', d);
    } else if (cmd == 'M') {
      cmd = 'L'; // implicit lineto after a moveto
    } else if (cmd == 'm') {
      cmd = 'l';
    } else if (cmd == 'Z' || cmd == 'z') {
      throw FormatException('numbers after a closepath', d);
    }
    final rel = cmd == cmd.toLowerCase();
    final up = cmd.toUpperCase();
    double ox() => rel ? cx : 0;
    double oy() => rel ? cy : 0;

    switch (up) {
      case 'M':
        final x = ox() + t.number(), y = oy() + t.number();
        path.moveTo(x, y);
        cx = sx = x;
        cy = sy = y;
        lcx = lcy = null;
      case 'L':
        final x = ox() + t.number(), y = oy() + t.number();
        path.lineTo(x, y);
        cx = x;
        cy = y;
        lcx = lcy = null;
      case 'H':
        final x = ox() + t.number();
        path.lineTo(x, cy);
        cx = x;
        lcx = lcy = null;
      case 'V':
        final y = oy() + t.number();
        path.lineTo(cx, y);
        cy = y;
        lcx = lcy = null;
      case 'C':
        final x1 = ox() + t.number(), y1 = oy() + t.number();
        final x2 = ox() + t.number(), y2 = oy() + t.number();
        final x = ox() + t.number(), y = oy() + t.number();
        path.cubicTo(x1, y1, x2, y2, x, y);
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
      case 'S':
        final x1 = lcx == null ? cx : 2 * cx - lcx;
        final y1 = lcy == null ? cy : 2 * cy - lcy;
        final x2 = ox() + t.number(), y2 = oy() + t.number();
        final x = ox() + t.number(), y = oy() + t.number();
        path.cubicTo(x1, y1, x2, y2, x, y);
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
      case 'Q':
        final x1 = ox() + t.number(), y1 = oy() + t.number();
        final x = ox() + t.number(), y = oy() + t.number();
        path.quadraticBezierTo(x1, y1, x, y);
        lcx = lcy = null;
        cx = x;
        cy = y;
      case 'A':
        final rx = t.number().abs(), ry = t.number().abs();
        final rot = t.number();
        final large = t.flag(), sweep = t.flag();
        final x = ox() + t.number(), y = oy() + t.number();
        if (rx == 0 || ry == 0) {
          path.lineTo(x, y);
        } else {
          path.arcToPoint(Offset(x, y),
              radius: Radius.elliptical(rx, ry),
              rotation: rot,
              largeArc: large,
              clockwise: sweep);
        }
        cx = x;
        cy = y;
        lcx = lcy = null;
      case 'Z':
        path.close();
        cx = sx;
        cy = sy;
        lcx = lcy = null;
        cmd = null; // nothing may follow without a new command
      default:
        throw FormatException('unsupported path command "$cmd"', d);
    }
  }
  return path;
}

class _Tokens {
  final String s;
  int i = 0;
  _Tokens(this.s);

  bool get done => i >= s.length;

  void skipSeparators() {
    while (i < s.length) {
      final c = s.codeUnitAt(i);
      if (c == 0x20 || c == 0x2C || c == 0x0A || c == 0x09 || c == 0x0D) {
        i++;
      } else {
        break;
      }
    }
  }

  bool get peekIsCommand {
    final c = s.codeUnitAt(i);
    return (c >= 0x41 && c <= 0x5A || c >= 0x61 && c <= 0x7A) &&
        c != 0x65 && // 'e' is an exponent, never a command
        c != 0x45;
  }

  String readCommand() => s[i++];

  double number() {
    skipSeparators();
    final start = i;
    if (i < s.length && (s[i] == '-' || s[i] == '+')) i++;
    var seenDot = false, seenDigit = false;
    while (i < s.length) {
      final c = s[i];
      if (c.codeUnitAt(0) >= 0x30 && c.codeUnitAt(0) <= 0x39) {
        seenDigit = true;
        i++;
      } else if (c == '.' && !seenDot) {
        seenDot = true;
        i++;
      } else {
        break;
      }
    }
    if (seenDigit && i < s.length && (s[i] == 'e' || s[i] == 'E')) {
      final save = i;
      i++;
      if (i < s.length && (s[i] == '-' || s[i] == '+')) i++;
      var expDigits = false;
      while (i < s.length &&
          s.codeUnitAt(i) >= 0x30 &&
          s.codeUnitAt(i) <= 0x39) {
        expDigits = true;
        i++;
      }
      if (!expDigits) i = save;
    }
    if (!seenDigit) throw FormatException('expected a number', s, start);
    return double.parse(s.substring(start, i));
  }

  /// An arc flag is a single 0 or 1, and may be written without a separator ("011").
  bool flag() {
    skipSeparators();
    if (i >= s.length || (s[i] != '0' && s[i] != '1')) {
      throw FormatException('expected an arc flag', s, i);
    }
    return s[i++] == '1';
  }
}
