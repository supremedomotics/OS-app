import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

void main() {
  const palma = ResidenceLocation(lat: 39.57, lon: 2.65, utcOffsetMinutes: 120);

  test('Palma on 4 Oct: afternoon, sun up, rise/set where the almanac has them', () {
    final d = dayLineAt(DateTime.utc(2026, 10, 4, 13), palma); // 15:00 local
    expect(d.up, isTrue);
    expect(d.phase, DayPhase.afternoon);
    expect(d.along, inInclusiveRange(.5, .7));
    final span = d.span!.split(' – ');
    expect(span[0], matches(RegExp(r'^7:(4|5)\d$')));
    expect(span[1], matches(RegExp(r'^19:[1-4]\d$')));
  });

  test('night: sun below the horizon, line travels under it', () {
    final d = dayLineAt(DateTime.utc(2026, 10, 4, 1), palma); // 03:00 local
    expect(d.up, isFalse);
    expect(d.phase, DayPhase.night);
    expect(d.along, inInclusiveRange(0, 1));
  });

  test('no clock without an offset: no span drawn', () {
    final d = dayLineAt(DateTime.utc(2026, 10, 4, 13), const ResidenceLocation(lat: 39.57, lon: 2.65));
    expect(d.span, isNull);
  });
}
