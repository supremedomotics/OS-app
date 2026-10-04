/// The sky outside, from where the residence is — a port of the Golden Master's `ui/sky.js`
/// (standard astronomical formulas, the NOAA / SunCalc basis, accurate to about a minute). Pure
/// Dart: nothing here reads a clock, a platform or a Hub; it is a function of an instant and a
/// place. The residence's own clock is used (its UTC offset), never this device's.
library;

import 'dart:math' as math;

/// Where the residence is, as the Hub keeps it (`GET /v1/home` → `home.location`).
class ResidenceLocation {
  final double lat;
  final double lon;
  final String? timeZone;
  final String? label;

  /// The zone's current offset from UTC in minutes, reported by the Hub (Dart has no time-zone
  /// database). Null → the residence's clock is not known and no clock times are drawn.
  final int? utcOffsetMinutes;
  const ResidenceLocation(
      {required this.lat,
      required this.lon,
      this.timeZone,
      this.label,
      this.utcOffsetMinutes});

  static ResidenceLocation? fromJson(Object? j) {
    if (j is! Map) return null;
    final lat = j['lat'], lon = j['lon'];
    if (lat is! num || lon is! num) return null;
    return ResidenceLocation(
      lat: lat.toDouble(),
      lon: lon.toDouble(),
      timeZone: j['timeZone'] as String?,
      label: j['label'] as String?,
      utcOffsetMinutes: (j['utcOffsetMinutes'] as num?)?.toInt(),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is ResidenceLocation &&
      other.lat == lat &&
      other.lon == lon &&
      other.timeZone == timeZone &&
      other.label == label &&
      other.utcOffsetMinutes == utcOffsetMinutes;
  @override
  int get hashCode => Object.hash(lat, lon, timeZone, label, utcOffsetMinutes);
}

const double _rad = math.pi / 180;
const double _dayMs = 864e5;
const double _j1970 = 2440588;
const double _j2000 = 2451545;
final double _e = _rad * 23.4397;

double _toDays(DateTime d) => d.millisecondsSinceEpoch / _dayMs - .5 + _j1970 - _j2000;
DateTime _fromJ(double j) => DateTime.fromMillisecondsSinceEpoch(
    ((j + .5 - _j1970) * _dayMs).round(),
    isUtc: true);
double _m(double d) => _rad * (357.5291 + .98560028 * d);
double _l(double m) =>
    m +
    _rad * (1.9148 * math.sin(m) + .02 * math.sin(2 * m) + .0003 * math.sin(3 * m)) +
    _rad * 102.9372 +
    math.pi;
double _dec(double l) => math.asin(math.sin(_e) * math.sin(l));
double _ra(double l) => math.atan2(math.sin(l) * math.cos(_e), math.cos(l));

/// JavaScript's `Math.round` (halves go up), which the original's day numbering relies on.
double _jsRound(double x) => (x + .5).floorToDouble();

/// The sun's height above the horizon in degrees at [date] for a place.
double sunElevation(DateTime date, double lat, double lon) {
  final d = _toDays(date), m = _m(d), l = _l(m);
  final lw = -lon * _rad, phi = lat * _rad;
  final h = _rad * (280.16 + 360.9856235 * d) - lw - _ra(l), dc = _dec(l);
  return math.asin(math.sin(phi) * math.sin(dc) +
          math.cos(phi) * math.cos(dc) * math.cos(h)) /
      _rad;
}

class SunTimes {
  final DateTime noon, midnight, midnightNext;

  /// Null in polar day / night, when the sun does not rise or set.
  final DateTime? rise, set;
  const SunTimes(this.noon, this.midnight, this.midnightNext, this.rise, this.set);
}

SunTimes sunTimes(DateTime date, double lat, double lon) {
  final lw = -lon * _rad, phi = lat * _rad, d = _toDays(date);
  final n = _jsRound(d - .0009 - lw / (2 * math.pi));
  final ds = .0009 + lw / (2 * math.pi) + n;
  final m = _m(ds), l = _l(m), dc = _dec(l);
  final jn = _j2000 + ds + .0053 * math.sin(m) - .0069 * math.sin(2 * l);
  final w = math.acos((math.sin(-.833 * _rad) - math.sin(phi) * math.sin(dc)) /
      (math.cos(phi) * math.cos(dc)));
  DateTime? rise, set;
  if (!w.isNaN) {
    final a = .0009 + (w + lw) / (2 * math.pi) + n;
    final js = _j2000 + a + .0053 * math.sin(m) - .0069 * math.sin(2 * l);
    set = _fromJ(js);
    rise = _fromJ(jn - (js - jn));
  }
  return SunTimes(_fromJ(jn), _fromJ(jn - .5), _fromJ(jn + .5), rise, set);
}

/// The hour of day (0–23) on the residence's own clock.
int residenceHourOf(DateTime instant, ResidenceLocation loc) => DateTime
    .fromMillisecondsSinceEpoch(
        instant.millisecondsSinceEpoch + (loc.utcOffsetMinutes ?? 0) * 60000,
        isUtc: true)
    .hour;

/// "7:49" — the residence's clock, 24-hour, hour unpadded (as the original draws it).
String clockLabel(DateTime instant, ResidenceLocation loc) {
  final t = DateTime.fromMillisecondsSinceEpoch(
      instant.millisecondsSinceEpoch + (loc.utcOffsetMinutes ?? 0) * 60000,
      isUtc: true);
  return '${t.hour}:${t.minute.toString().padLeft(2, '0')}';
}

enum DayPhase { dawn, morning, noon, afternoon, evening, night, midnight }

String dayPhaseName(DayPhase p) => switch (p) {
      DayPhase.dawn => 'Early morning',
      DayPhase.morning => 'Morning',
      DayPhase.noon => 'Noon',
      DayPhase.afternoon => 'Afternoon',
      DayPhase.evening => 'Evening',
      DayPhase.night => 'Night',
      DayPhase.midnight => 'Midnight',
    };

/// The part of the day, from the sun (not from the clock face): Noon within an hour of solar
/// noon; Morning/Afternoon/Evening by elevation; Early morning before dawn light; Midnight is a
/// clock idea (23:00–00:59 on the residence's clock).
DayPhase phaseAt(DateTime date, ResidenceLocation loc) {
  final el = sunElevation(date, loc.lat, loc.lon);
  final t = sunTimes(date, loc.lat, loc.lon);
  final ms = date.millisecondsSinceEpoch, noon = t.noon.millisecondsSinceEpoch;
  final hr = residenceHourOf(date, loc);
  final nearMid = hr == 23 || hr == 0;
  const hour = 36e5;
  if (el >= -.833) {
    if ((ms - noon).abs() < hour) return DayPhase.noon;
    if (ms < noon) return DayPhase.morning;
    return el < 12 ? DayPhase.evening : DayPhase.afternoon;
  }
  if (el >= -12) return ms < noon ? DayPhase.dawn : DayPhase.evening;
  return nearMid ? DayPhase.midnight : DayPhase.night;
}

/// What the day line draws: the sun's place on the residence's day (the original's `dayLine`).
class DayLine {
  final DayPhase phase;

  /// Sunrise and sunset today; null in polar day / night.
  final DateTime? rise, set;

  /// The sun is above the horizon.
  final bool up;

  /// Along the line, 0..1: through the day (when [up]) or through the night (when not).
  final double along;
  final ResidenceLocation location;
  const DayLine(this.phase, this.rise, this.set, this.up, this.along, this.location);

  String get phaseName => dayPhaseName(phase);

  /// "7:49 – 19:29", or null when the sun does not rise and set today (or the clock is unknown).
  String? get span => rise != null && set != null && location.utcOffsetMinutes != null
      ? '${clockLabel(rise!, location)} – ${clockLabel(set!, location)}'
      : null;

  /// "Evening outside · sunset 19:42" — the original's sentence, for assistive technology.
  String line(DateTime now) {
    final t = sunTimes(now, location.lat, location.lon);
    final ms = now.millisecondsSinceEpoch;
    String next = '';
    String f(DateTime d) => location.utcOffsetMinutes == null ? '' : ' ${clockLabel(d, location)}';
    if (t.rise != null && ms < t.rise!.millisecondsSinceEpoch) {
      next = 'sunrise${f(t.rise!)}';
    } else if (t.set != null && ms < t.set!.millisecondsSinceEpoch) {
      next = 'sunset${f(t.set!)}';
    } else {
      final tm = sunTimes(DateTime.fromMillisecondsSinceEpoch(ms + (_dayMs * .6).round(), isUtc: true),
          location.lat, location.lon);
      if (tm.rise != null) next = 'sunrise${f(tm.rise!)}';
    }
    return '$phaseName outside${next.isEmpty ? '' : ' · $next'}';
  }
}

DayLine dayLineAt(DateTime now, ResidenceLocation loc) {
  final ms = now.millisecondsSinceEpoch;
  final t = sunTimes(now, loc.lat, loc.lon);
  final rise = t.rise, set = t.set;
  final phase = phaseAt(now, loc);
  final up = rise != null && set != null && ms >= rise.millisecondsSinceEpoch && ms <= set.millisecondsSinceEpoch;
  if (up) {
    final f = (ms - rise.millisecondsSinceEpoch) / (set.millisecondsSinceEpoch - rise.millisecondsSinceEpoch);
    return DayLine(phase, rise, set, true, f, loc);
  }
  // Night: the sun travels under the horizon from the last sunset to the next sunrise.
  DateTime? prevSet;
  if (rise != null && ms < rise.millisecondsSinceEpoch) {
    prevSet = sunTimes(DateTime.fromMillisecondsSinceEpoch(ms - _dayMs.round(), isUtc: true), loc.lat, loc.lon).set;
  }
  final setMs = set?.millisecondsSinceEpoch;
  double s0, r1;
  if (setMs != null && ms >= setMs) {
    s0 = setMs.toDouble();
    final next = sunTimes(DateTime.fromMillisecondsSinceEpoch(ms + (_dayMs * .6).round(), isUtc: true), loc.lat, loc.lon).rise;
    r1 = (next?.millisecondsSinceEpoch ?? setMs + _dayMs).toDouble();
  } else {
    s0 = ((prevSet ?? set)?.millisecondsSinceEpoch ?? ms - _dayMs * .5) - (prevSet == null ? _dayMs : 0);
    r1 = (rise?.millisecondsSinceEpoch ?? ms + _dayMs * .5).toDouble();
  }
  final nf = ((ms - s0) / math.max(1, r1 - s0)).clamp(0.0, 1.0);
  return DayLine(phase, rise, set, false, nf, loc);
}
