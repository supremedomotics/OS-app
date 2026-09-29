import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

class _Rig {
  final clock = ManualScheduler();
  late final SimulatedResidence sim;
  late final ResidenceState state;
  late final CommandTracker tracker;
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
  List<DeviceRecord> devs(String room) => state.snapshot.devicesIn(room);
  void run(List<DeviceCommand> cs) {
    for (final c in cs) {
      tracker.submit(c.deviceId, c.command);
    }
  }
}

void main() {
  controlSystemsTests();
  test('controls exist only where a device declares the capability', () async {
    final r = _Rig();
    await r.start();
    expect(RoomLights.of(r.devs('kitchen'), []), isNotNull);
    expect(RoomShades.of(r.devs('kitchen'), []), isNull);
    expect(RoomClimate.allOf(r.devs('kitchen'), []), isEmpty);
    expect(RoomMusic.allOf(r.devs('kitchen'), []), isEmpty);
    expect(RoomLights.of(r.devs('terrace'), [])!.dimmable, isFalse,
        reason: 'an on/off light offers no brightness');
    expect(RoomClimate.allOf(r.devs('living'), []), hasLength(1));
    expect(RoomMusic.allOf(r.devs('living'), []), hasLength(1));
  });

  test('lights: pending is the request, level is the report; only the report is ever the value', () async {
    final r = _Rig();
    await r.start();
    var c = RoomLights.of(r.devs('living'), r.tracker.inFlight)!;
    expect(c.level, 60);
    expect(c.pendingLevel, isNull);
    r.run(c.setLevel(25));
    await r.advance(100);
    c = RoomLights.of(r.devs('living'), r.tracker.inFlight)!;
    expect(c.level, 60, reason: 'still what the device reports');
    expect(c.pendingLevel, 25);
    await r.advance(500);
    c = RoomLights.of(r.devs('living'), r.tracker.inFlight)!;
    expect(c.level, 25);
    expect(c.pendingLevel, isNull);
  });

  test('lights toggle: all on → off; off → on; mixed → all on', () async {
    final r = _Rig();
    await r.start();
    r.state.snapshot; // kitchen off
    final k = RoomLights.of(r.devs('kitchen'), [])!;
    expect(k.allOn, isFalse);
    expect(k.toggle().single.command, {'capability': 'brightness', 'action': 'on'});
    final both = [...r.devs('living'), ...r.devs('kitchen')].where((d) => d.id.endsWith('light')).toList();
    final mixed = RoomLights.of(both, [])!;
    expect(mixed.allOn, isNull);
    expect(mixed.toggle().every((c) => c.command['action'] == 'on'), isTrue);
  });

  test('an unreachable light is excluded from commands and named', () async {
    final r = _Rig();
    r.sim.setReachability('living-light', 'offline');
    await r.start();
    final c = RoomLights.of(r.devs('living'), [])!;
    expect(c.toggle(), isEmpty);
    expect(c.unresponsive, ['Living Room lights']);
    expect(c.allOn, isFalse);
  });

  test('shades: open/close use their own actions; set otherwise; pending follows the request', () async {
    final r = _Rig();
    await r.start();
    var s = RoomShades.of(r.devs('living'), [])!;
    expect(s.position, 100);
    expect(s.to(0).single.command['action'], 'close');
    expect(s.to(100).single.command['action'], 'open');
    expect(s.to(40).single.command, {'capability': 'position', 'action': 'set', 'position': 40});
    r.run(s.to(40));
    await r.advance(100);
    s = RoomShades.of(r.devs('living'), r.tracker.inFlight)!;
    expect(s.pendingPosition, 40);
    await r.advance(700);
    s = RoomShades.of(r.devs('living'), r.tracker.inFlight)!;
    expect(s.moving, isTrue);
    await r.advance(4000);
    s = RoomShades.of(r.devs('living'), r.tracker.inFlight)!;
    expect(s.position, 40);
    expect(s.moving, isFalse);
    expect(s.pendingPosition, isNull);
  });

  test('climate: steps from the requested target, clamps to the unit range, default step is 1°', () async {
    final r = _Rig();
    await r.start();
    var c = RoomClimate.allOf(r.devs("living"), []).single;
    expect(c.targetC, 22.0);
    expect(c.step, 1);
    expect(c.stepped(1)!.command['targetC'], 23.0);
    r.run([c.stepped(1)!]);
    await r.advance(100);
    c = RoomClimate.allOf(r.devs('living'), r.tracker.inFlight).single;
    expect(c.pendingTargetC, 23.0);
    expect(c.stepped(1)!.command['targetC'], 24.0, reason: 'a second tap builds on the request');
    await r.advance(500);
    c = RoomClimate.allOf(r.devs('living'), r.tracker.inFlight).single;
    expect(c.targetC, 23.0);
  });

  test('music: toggle follows the requested state; volume pending is tracked', () async {
    final r = _Rig();
    await r.start();
    var m = RoomMusic.allOf(r.devs('living'), []).single;
    expect(m.playing, isTrue);
    expect(m.toggle().command['action'], 'pause');
    r.run([m.toggle(), m.setVolume(55)]);
    await r.advance(100);
    m = RoomMusic.allOf(r.devs('living'), r.tracker.inFlight).single;
    expect(m.playing, isTrue);
    expect(m.pendingPlaying, isFalse);
    expect(m.pendingVolume, 55);
    expect(m.toggle().command['action'], 'play', reason: 'the next tap reverses the request');
    await r.advance(500);
    m = RoomMusic.allOf(r.devs('living'), r.tracker.inFlight).single;
    expect(m.playing, isFalse);
    expect(m.volume, 55);
  });

  test('a failed command is reported so the control can say so, and state is unchanged', () async {
    final r = _Rig();
    await r.start();
    r.sim.setSilent('living-light', true);
    r.run(RoomLights.of(r.devs('living'), [])!.setLevel(10));
    await r.advance(9000);
    expect(failedRecently(r.tracker, ['living-light'], 'brightness'), isNull,
        reason: 'a light gets its own 10 s before it is called unresponsive');
    await r.advance(1500);
    expect(failedRecently(r.tracker, ['living-light'], 'brightness'), CommandFailure.timeout);
    expect(RoomLights.of(r.devs('living'), r.tracker.inFlight)!.level, 60);
  });
}

void controlSystemsTests() {
  test('Control offers only the systems its scope has, each with its own summary', () async {
    final r = _Rig();
    await r.start();
    List<ControlSystem> of(Iterable<DeviceRecord> d) => controlSystems(d, r.tracker.inFlight);

    final kitchen = of(r.devs('kitchen'));
    expect(kitchen.map((s) => s.id), [ControlSystemId.lighting]);
    expect(kitchen.single.summary, 'All off');

    final living = of(r.devs('living'));
    expect(living.map((s) => s.id),
        [ControlSystemId.lighting, ControlSystemId.climate, ControlSystemId.shades, ControlSystemId.media]);
    expect(living.map((s) => s.summary), [
      '1 of 1 on · 60%',
      '22.5° · set to 22.0°',
      'Open',
      'Clair de Lune · Debussy',
    ]);

    final all = of(r.state.snapshot.devices.values);
    expect(all.firstWhere((s) => s.id == ControlSystemId.climate).summary, '2 zones · 21.0° – 22.5°');
    expect(all.firstWhere((s) => s.id == ControlSystemId.media).summary, 'Clair de Lune · Debussy');
    expect(all.firstWhere((s) => s.id == ControlSystemId.lighting).summary, '2 of 5 on · 50%');
  });
}
