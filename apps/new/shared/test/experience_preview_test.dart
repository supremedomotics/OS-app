import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

void main() {
  late ManualScheduler clock;
  late SimulatedResidence sim;
  late ResidenceState state;
  late CommandTracker tracker;

  Future<void> boot() async {
    clock = ManualScheduler();
    sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    state = ResidenceState(get: (p) async => sim.read(p), frames: sim.stream.frames, now: clock.now);
    tracker = CommandTracker(
        send: (id, c) async => sim.command('v1/devices/$id/command', {'command': c}),
        state: state,
        schedule: clock.schedule,
        now: clock.now);
    await state.start();
  }

  Experience exp(String id) => state.snapshot.experiences.firstWhere((e) => e.id == id);

  test('What changes: one row per system, said from the step targets, counts agree', () async {
    await boot();
    final rows = experiencePreview(exp('relax'), state.snapshot);
    expect(rows.map((r) => r.label), ['Lighting', 'Shades', 'Music']);
    expect(rows[0].effect, 'Set to 20–30%');
    expect(rows[0].count, '2 lights');
    expect(rows[1].effect, 'Set to 60% open');
    expect(rows[1].count, '1 curtain or shade');
    expect(rows[2].effect, 'Play');

    final night = experiencePreview(exp('good-night'), state.snapshot);
    expect(night.first.effect, 'Off');
    expect(night.firstWhere((r) => r.system == PreviewSystem.shades).effect, 'Closed');
  });

  test('a space sees only its share', () async {
    await boot();
    final rows = experiencePreview(exp('relax'), state.snapshot, spaceId: 'dining');
    expect(rows.map((r) => r.label), ['Lighting']);
    expect(rows.single.count, '1 light');
  });

  test('arrival is counted from device state, and unreachable devices are counted, not hidden', () async {
    await boot();
    sim.setReachability('living-audio', 'offline');
    await state.refresh();
    var rows = experiencePreview(exp('relax'), state.snapshot);
    final music = rows.firstWhere((r) => r.system == PreviewSystem.music);
    expect(music.unreachable, 1);
    expect(music.arrived, 0);

    for (final c in experiencePlan(exp('relax'), state.snapshot)) {
      tracker.submit(c.deviceId, c.command);
    }
    await clock.advance(const Duration(milliseconds: 100));
    rows = experiencePreview(exp('relax'), state.snapshot, commands: tracker.inFlight);
    expect(rows.firstWhere((r) => r.system == PreviewSystem.lighting).changing, 2);
    await clock.advance(const Duration(seconds: 6));
    rows = experiencePreview(exp('relax'), state.snapshot, commands: tracker.inFlight);
    expect(rows.firstWhere((r) => r.system == PreviewSystem.lighting).allArrived, isTrue);
    expect(rows.firstWhere((r) => r.system == PreviewSystem.shades).allArrived, isTrue);
  });

  test('the hero light is the light the Experience intends, before it is set', () async {
    await boot();
    final relax = intendedLight(exp('relax'), state.snapshot);
    expect(relax.on, isTrue);
    expect(relax.level, 25);
    expect(lookFor(relax).exposure, lessThan(lookFor(intendedLight(
        const Experience(id: 'b', name: 'Bright', spaceIds: [], steps: [
          ExperienceStep(deviceId: 'living-light', capability: 'brightness',
              values: {'action': 'set', 'level': 100})
        ]), state.snapshot)).exposure));
    final night = intendedLight(exp('good-night'), state.snapshot);
    expect(night.on, isFalse);
  });

  test('the line and status are derived, never authored', () async {
    await boot();
    expect(experienceLine(exp('relax'), state.snapshot), 'Changes lighting, curtains and music.');
    expect(experienceStatusText(experienceStatus(exp('relax'), state.snapshot)), 'Partially active');
    expect(experienceStatusText(experienceStatus(exp('dinner'), state.snapshot)), 'Not active');
    for (final c in experiencePlan(exp('dinner'), state.snapshot)) {
      tracker.submit(c.deviceId, c.command);
    }
    await clock.advance(const Duration(milliseconds: 100));
    expect(
        experienceStatusText(experienceStatus(exp('dinner'), state.snapshot, commands: tracker.inFlight)),
        'Becoming…');
    await clock.advance(const Duration(seconds: 2));
    expect(experienceStatusText(experienceStatus(exp('dinner'), state.snapshot)), 'Active now');
    expect(experienceStatusText(const ExperienceStatus(ExperiencePhase.indeterminate)), '');
  });
}
