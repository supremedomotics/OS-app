/// A room's photograph takes on the room's CONFIRMED light (Golden Master `tone.js`): colour
/// temperature shifts white balance relative to the temperature the photograph was taken at,
/// level is exposure, lights off falls to ambient darkness. Driven only by reported device state
/// ([RoomLight] from the Residence State), never by a slider's position.
///
/// Pure maths — returns a 4×5 colour matrix (row-major, the same layout as `feColorMatrix` and
/// Flutter's `ColorFilter.matrix`), and [RoomLook] values a widget can ease between.
library;

import 'dart:math' as math;

import 'residence_description.dart';

/// The demo photographs were taken in warm-white light.
const roomToneReferenceKelvin = 3000;

class RoomLook {
  final List<double> gain; // r, g, b
  final double exposure;
  final double saturation;
  const RoomLook(this.gain, this.exposure, this.saturation);

  static RoomLook lerp(RoomLook a, RoomLook b, double t) => RoomLook([
        for (var i = 0; i < 3; i++) a.gain[i] + (b.gain[i] - a.gain[i]) * t
      ], a.exposure + (b.exposure - a.exposure) * t,
          a.saturation + (b.saturation - a.saturation) * t);
}

/// Tanner Helland's black-body approximation, 0..1 per channel.
List<double> kelvinRgb(num kelvin) {
  final t = kelvin.clamp(1000, 40000) / 100;
  double r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  double c(double v) => v.clamp(0, 255) / 255;
  return [c(r), c(g), c(b)];
}

final _ref = kelvinRgb(roomToneReferenceKelvin);

/// [kelvin] null = the room's lights report no colour temperature: the photograph's own white
/// balance is kept (the Golden Master assumed 2700 K; that is a claim the device never made).
RoomLook lookFor(RoomLight light, {int? referenceKelvin}) {
  if (!light.on) return const RoomLook([1, 1, 1], .42, .72);
  final ref = referenceKelvin == null || referenceKelvin == roomToneReferenceKelvin
      ? _ref
      : kelvinRgb(referenceKelvin);
  final rgb = light.kelvin == null ? ref : kelvinRgb(light.kelvin!);
  // ~60 % of the literal black-body shift, luminance held constant (tone.js STRENGTH).
  final m = [for (var i = 0; i < 3; i++) 1 + (rgb[i] / ref[i] - 1) * .6];
  final y = .2126 * m[0] + .7152 * m[1] + .0722 * m[2];
  final e = .5 + .5 * math.pow(math.max(1, light.level) / 100, .65);
  return RoomLook([for (final v in m) v / y], e, 1);
}

List<double> colorMatrix(RoomLook l) {
  final s = l.saturation;
  final lr = .2126 * (1 - s), lg = .7152 * (1 - s), lb = .0722 * (1 - s);
  final sm = [
    [lr + s, lg, lb],
    [lr, lg + s, lb],
    [lr, lg, lb + s],
  ];
  final out = <double>[];
  for (var i = 0; i < 3; i++) {
    final g = l.gain[i] * l.exposure;
    out.addAll([sm[i][0] * g, sm[i][1] * g, sm[i][2] * g, 0, 0]);
  }
  out.addAll([0, 0, 0, 1, 0]);
  return out;
}
