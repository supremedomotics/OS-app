import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

import 'support/residence_rig.dart';

void main() {
  test('the space sentence and feel are derived, in words', () async {
    final r = Rig();
    await r.start();
    expect(spaceSummary(r.snap, 'living'), 'Lights on · 22.5° · Curtains open · Music playing');
    expect(spaceSummary(r.snap, 'kitchen'), '', reason: 'nothing on → the page says "Nothing is on"');
    expect(spaceFeel(r.snap, 'living'), 'Its own atmosphere.');
    // The kitchen's only Good Night step is its light off — already true, so it is derived as such.
    expect(spaceFeel(r.snap, 'kitchen'), 'Feels like Good Night.');
    expect(spaceFeel(r.snap, 'dining'), 'Its own atmosphere.');
  });

  test('a space with nothing on and no Experience in effect is Resting.', () {
    const off = DeviceRecord(
        id: 'l', roomId: 'x', name: 'Lamp', supremeType: 'light',
        reachability: DeviceReachability.online,
        capabilities: {'onoff': {}}, state: {'onoff': {'kind': 'onoff', 'on': false}});
    const snap = ResidenceSnapshot(
        loaded: true, spaces: [Space(id: 'x', name: 'X')], devices: {'l': off});
    expect(spaceFeel(snap, 'x'), 'Resting.');
    expect(spaceSummary(snap, 'x'), '');
  });

  test('feel says Adjusting… then Becoming X… then Feels like X.', () async {
    final r = Rig();
    await r.start();
    r.tracker.submit('kitchen-light', {'capability': 'onoff', 'action': 'on'});
    expect(spaceFeel(r.snap, 'kitchen', commands: r.tracker.inFlight), 'Adjusting…');
    await r.advance(600);

    r.activations.activate(r.exp('good-night'));
    expect(spaceFeel(r.snap, 'living', activations: r.activations.inFlight),
        'Becoming Good Night…', reason: 'asked, before the Hub has even answered');
    await r.advance(100);
    expect(spaceFeel(r.snap, 'living', activations: r.activations.inFlight), 'Becoming Good Night…');
    await r.advance(7000);
    expect(spaceFeel(r.snap, 'living', activations: r.activations.inFlight), 'Feels like Good Night.');
    expect(spaceFeel(r.snap, 'master', activations: r.activations.inFlight), 'Feels like Good Night.');
  });

  test('a plan skips unreachable devices and can be limited to one space', () async {
    final r = Rig();
    r.sim.setReachability('living-audio', 'offline');
    await r.start();
    final whole = experiencePlan(r.exp('relax'), r.snap);
    expect(whole.map((c) => c.deviceId), isNot(contains('living-audio')));
    final dining = experiencePlan(r.exp('relax'), r.snap, spaceId: 'dining');
    expect(dining.map((c) => c.deviceId), ['dining-light']);
  });

  test('spaceExperiences: those that act in the space', () async {
    final r = Rig();
    await r.start();
    expect(spaceExperiences(r.snap, 'kitchen').map((e) => e.id), ['dinner', 'good-night']);
    expect(spaceExperiences(r.snap, 'master').map((e) => e.id), ['good-night']);
  });
}
