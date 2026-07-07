import 'dart:math' as math;

/// Local sunset — a compact NOAA/SunCalc computation from latitude, longitude and date. No network:
/// real astronomy on the device, so the home can say something warm and true ("Sunset in 28 minutes")
/// without asking anyone. Returns null near the poles where the sun doesn't set. Mirrors the web helper.
const _rad = math.pi / 180;
const _dayMs = 86400000;
const _j1970 = 2440588;
const _j2000 = 2451545;
const _j0 = 0.0009;

double _toDays(DateTime date) => date.millisecondsSinceEpoch / _dayMs - 0.5 + _j1970 - _j2000;
double _solarMeanAnomaly(double d) => _rad * (357.5291 + 0.98560028 * d);
double _eclipticLongitude(double m) {
  final c = _rad * (1.9148 * math.sin(m) + 0.02 * math.sin(2 * m) + 0.0003 * math.sin(3 * m));
  const p = _rad * 102.9372;
  return m + c + p + math.pi;
}

double _declination(double l) => math.asin(math.sin(_rad * 23.4397) * math.sin(l));
double _solarTransitJ(double ds, double m, double l) => _j2000 + ds + 0.0053 * math.sin(m) - 0.0069 * math.sin(2 * l);
double _hourAngle(double h, double phi, double dec) =>
    math.acos((math.sin(h) - math.sin(phi) * math.sin(dec)) / (math.cos(phi) * math.cos(dec)));

/// Sunset for the given location today (local time), or null if the sun doesn't set.
DateTime? sunset(double lat, double lon, [DateTime? at]) {
  final date = at ?? DateTime.now();
  final lw = _rad * -lon;
  final phi = _rad * lat;
  final d = _toDays(date);
  final n = (d - _j0 - lw / (2 * math.pi)).round();
  final ds = _j0 + lw / (2 * math.pi) + n;
  final m = _solarMeanAnomaly(ds);
  final l = _eclipticLongitude(m);
  final dec = _declination(l);
  final w = _hourAngle(_rad * -0.833, phi, dec);
  if (w.isNaN) return null;
  final a = _j0 + (w + lw) / (2 * math.pi) + n;
  final jset = _solarTransitJ(a, m, l);
  if (jset.isNaN) return null;
  return DateTime.fromMillisecondsSinceEpoch(((jset + 0.5 - _j1970) * _dayMs).round());
}
