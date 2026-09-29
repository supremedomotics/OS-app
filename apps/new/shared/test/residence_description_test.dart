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
  void set(String id, Map<String, dynamic> cmd) {
    sim.changePhysically(id, cmd);
  }
}

void main() {
  group('a space, in words', () {
    test('never says what its devices cannot prove', () async {
      final r = _Rig();
      await r.start();
      final c = spaceCondition(r.state.snapshot, 'living');
      // 60 % dimmer, no colour capability: no warm/cool claim; playing speaker: Music.
      expect(c.words, ['Lights on', 'Music']);
      expect(c.line, 'Lights on · Music');
      expect(c.attention, isNull);
    });

    test('lights off reads daylight or dark by the hour, not by a guess about the sun', () async {
      final r = _Rig();
      await r.start();
      expect(spaceCondition(r.state.snapshot, 'kitchen').words, ['Daylight only']);
      expect(spaceCondition(r.state.snapshot, 'kitchen', sunUp: false).words, ['Dark']);
    });

    test('follows confirmed state only', () async {
      final r = _Rig();
      await r.start();
      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 90});
      await r.advance(100);
      expect(spaceCondition(r.state.snapshot, 'kitchen', commands: r.tracker.inFlight).words,
          ['Daylight only'],
          reason: 'requested, not yet reported');
      expect(spaceCondition(r.state.snapshot, 'kitchen', commands: r.tracker.inFlight).adjusting, isTrue);
      await r.advance(500);
      expect(spaceCondition(r.state.snapshot, 'kitchen').words, ['Bright light']);
    });

    test('a device that stops responding is said plainly', () async {
      final r = _Rig();
      r.sim.setReachability('living-audio', 'offline');
      await r.start();
      final c = spaceCondition(r.state.snapshot, 'living');
      expect(c.attention, '1 not responding');
      expect(c.words, isNot(contains('Music')), reason: 'an unreachable speaker is not "playing"');
    });

    test('names the Experience in effect, derived from devices', () async {
      final r = _Rig();
      await r.start();
      expect(spaceCondition(r.state.snapshot, 'kitchen').experience, isNull);
      r.sim.command('v1/scenes/good-night/activate', const {});
      await r.advance(6000);
      expect(spaceCondition(r.state.snapshot, 'kitchen').experience?.name, 'Good Night');
    });
  });

  group('Home, in one sentence', () {
    test('settled by day; resting at night when nothing is on', () async {
      final r = _Rig();
      await r.start();
      expect(describeHome(r.state.snapshot, hour: 15).sentence, 'Everything is settled.');
      r.sim.command('v1/scenes/good-night/activate', const {});
      await r.advance(6000);
      // Good Night pauses the speaker and turns lights off; the terrace/master remain off.
      final night = describeHome(r.state.snapshot, hour: 23);
      expect(night.sentence, 'The residence is resting.');
      expect(night.experience?.name, 'Good Night');
    });

    test('signals come from device state', () async {
      final r = _Rig();
      await r.start();
      final h = describeHome(r.state.snapshot, hour: 19);
      expect(h.signals, ['Evening light', '21.8°', 'Music in the living room']);
    });

    test('never claims everything is settled while something is out', () async {
      final r = _Rig();
      r.sim.setReachability('dining-shade', 'offline');
      await r.start();
      final h = describeHome(r.state.snapshot, hour: 15);
      expect(h.sentence, 'Settled, except the dining room shades.');
      expect(h.note, 'The dining room shades aren’t responding.');
    });

    test('says it is adjusting while commands are in flight', () async {
      final r = _Rig();
      await r.start();
      r.tracker.submit('kitchen-light', {'capability': 'onoff', 'action': 'on'});
      final h = describeHome(r.state.snapshot, hour: 15, commands: r.tracker.inFlight);
      expect(h.sentence, 'Adjusting the residence…');
    });

    test('prepositions: on the terrace, in the living room', () {
      expect(spaceAt('Terrace'), 'on the terrace');
      expect(spaceAt('Living Room'), 'in the living room');
    });
  });

  group('room tone follows confirmed light', () {
    test('lights off darkens and desaturates; warm light shifts red; level is exposure', () {
      const off = RoomLight(lightsTotal: 1, lightsOn: 0, level: 0, kelvin: null);
      final dark = lookFor(off);
      expect(dark.exposure, lessThan(.5));
      expect(dark.saturation, lessThan(1));
      final warm = lookFor(const RoomLight(lightsTotal: 1, lightsOn: 1, level: 100, kelvin: 2200));
      final cool = lookFor(const RoomLight(lightsTotal: 1, lightsOn: 1, level: 100, kelvin: 6500));
      expect(warm.gain[0], greaterThan(warm.gain[2]));
      expect(cool.gain[2], greaterThan(cool.gain[0]));
      final dim = lookFor(const RoomLight(lightsTotal: 1, lightsOn: 1, level: 10, kelvin: null));
      final full = lookFor(const RoomLight(lightsTotal: 1, lightsOn: 1, level: 100, kelvin: null));
      expect(dim.exposure, lessThan(full.exposure));
      expect(colorMatrix(full), hasLength(20));
    });

    test('no reported colour temperature keeps the photograph white balance', () {
      final l = lookFor(const RoomLight(lightsTotal: 1, lightsOn: 1, level: 100, kelvin: null));
      expect(l.gain[0], closeTo(l.gain[2], 1e-9));
    });
  });
}
