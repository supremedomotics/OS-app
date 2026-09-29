import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

class _Rig {
  final clock = ManualScheduler();
  late final SimulatedResidence sim;
  late final ResidenceState state;
  late final CommandTracker tracker;
  int hubCalls = 0;
  _Rig() {
    sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    state = ResidenceState(
        get: (p) async => sim.read(p), frames: sim.stream.frames, now: clock.now);
    tracker = CommandTracker(
        send: (id, c) async => sim.command('v1/devices/$id/command', {'command': c}),
        state: state,
        schedule: clock.schedule,
        now: clock.now);
  }
  Future<void> start() => state.start();
  Future<void> advance(int ms) => clock.advance(Duration(milliseconds: ms));
  ResidenceSnapshot get snap => state.snapshot;
  Experience exp(String id) => snap.experiences.firstWhere((e) => e.id == id);
}

void main() {
  test('the space sentence and feel are derived, in words', () async {
    final r = _Rig();
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
    final r = _Rig();
    await r.start();
    // a plain command → Adjusting
    r.tracker.submit('kitchen-light', {'capability': 'onoff', 'action': 'on'});
    expect(spaceFeel(r.snap, 'kitchen', commands: r.tracker.inFlight), 'Adjusting…');
    await r.advance(600);

    // an Experience's steps → Becoming, then Feels like
    final plan = experiencePlan(r.exp('good-night'), r.snap);
    r.tracker.submitGroup([for (final c in plan) (deviceId: c.deviceId, command: c.command)],
        () async => r.sim.command('v1/scenes/good-night/activate', const {}));
    await r.advance(100);
    expect(spaceFeel(r.snap, 'living', commands: r.tracker.inFlight), 'Becoming Good Night…');
    await r.advance(6000);
    expect(spaceFeel(r.snap, 'living', commands: r.tracker.inFlight), 'Feels like Good Night.');
    expect(spaceFeel(r.snap, 'master', commands: r.tracker.inFlight), 'Feels like Good Night.');
  });

  test('a group makes ONE Hub call yet confirms each step from its own device', () async {
    final r = _Rig();
    await r.start();
    var calls = 0;
    final plan = experiencePlan(r.exp('dinner'), r.snap);
    expect(plan, hasLength(4));
    final recs = r.tracker.submitGroup(
        [for (final c in plan) (deviceId: c.deviceId, command: c.command)], () async {
      calls++;
      return r.sim.command('v1/scenes/dinner/activate', const {});
    });
    await r.advance(50);
    expect(calls, 1);
    expect(recs, hasLength(4));
    expect(r.tracker.inFlight, hasLength(4));
    r.sim.setSilent('dining-light', true); // one device never reports
    await r.advance(1000);
    final phases = {for (final c in plan) c.deviceId: r.tracker.latestFor(c.deviceId, c.command['capability'] as String)!.phase};
    expect(phases['living-light'], CommandPhase.confirmed);
    expect(phases['dining-light'], CommandPhase.pending, reason: 'not confirmed by anyone else\'s report');
    await r.advance(9000);
    expect(r.tracker.latestFor('dining-light', 'brightness')!.failure, CommandFailure.timeout);
    expect(experienceStatus(r.exp('dinner'), r.snap).phase, ExperiencePhase.partial);
  });

  test('a rejected group call fails every step together and changes nothing', () async {
    final r = _Rig();
    await r.start();
    final plan = experiencePlan(r.exp('dinner'), r.snap);
    r.tracker.submitGroup([for (final c in plan) (deviceId: c.deviceId, command: c.command)],
        () async => throw StateError('hub down'));
    await r.advance(50);
    expect(r.tracker.inFlight, isEmpty);
    for (final c in plan) {
      expect(r.tracker.latestFor(c.deviceId, c.command['capability'] as String)!.failure,
          CommandFailure.unreachable);
    }
    expect(experienceStatus(r.exp('dinner'), r.snap).phase, ExperiencePhase.inactive);
  });

  test('a plan skips unreachable devices and can be limited to one space', () async {
    final r = _Rig();
    r.sim.setReachability('living-audio', 'offline');
    await r.start();
    final whole = experiencePlan(r.exp('relax'), r.snap);
    expect(whole.map((c) => c.deviceId), isNot(contains('living-audio')));
    final dining = experiencePlan(r.exp('relax'), r.snap, spaceId: 'dining');
    expect(dining.map((c) => c.deviceId), ['dining-light']);
  });

  test('spaceExperiences: those that act in the space', () async {
    final r = _Rig();
    await r.start();
    expect(spaceExperiences(r.snap, 'kitchen').map((e) => e.id), ['dinner', 'good-night']);
    expect(spaceExperiences(r.snap, 'master').map((e) => e.id), ['good-night']);
  });
}
