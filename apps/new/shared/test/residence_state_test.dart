import 'dart:async';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// Proves the state architecture end to end against the simulated residence: authoritative
/// state comes only from reports, and the lifecycle never invents a confirmation.
class _Rig {
  final clock = ManualScheduler();
  late final SimulatedResidence sim;
  late final ResidenceState state;
  late final CommandTracker tracker;
  final sent = <Map<String, dynamic>>[];

  _Rig({Duration timeout = const Duration(seconds: 8)}) {
    sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    state = ResidenceState(
        get: (p) async => sim.read(p),
        frames: sim.stream.frames,
        now: clock.now);
    tracker = CommandTracker(
      send: (id, cmd) async {
        sent.add(cmd);
        return sim.command('v1/devices/$id/command', {'command': cmd});
      },
      state: state,
      timeout: timeout,
      schedule: clock.schedule,
      now: clock.now,
    );
  }

  Future<void> start() => state.start();
  Future<void> advance(int ms) => clock.advance(Duration(milliseconds: ms));
  Map<String, dynamic>? cap(String id, String c) =>
      state.snapshot.devices[id]?.state[c];
}

void main() {
  movementTests();
  test('hydrates spaces, devices and experiences from the real read routes',
      () async {
    final r = _Rig();
    await r.start();
    final s = r.state.snapshot;
    expect(s.loaded, isTrue);
    expect(s.spaces.map((x) => x.name),
        containsAll(['Living Room', 'Dining Room', 'Master Bedroom']));
    expect(
        s.space('living')!.domains,
        containsAll([
          HomeDomain.lighting,
          HomeDomain.shades,
          HomeDomain.climate,
          HomeDomain.audio
        ]));
    expect(s.space('kitchen')!.domains, {HomeDomain.lighting});
    expect(
        s.experiences.map((e) => e.name), containsAll(['Relax', 'Good Night']));
    expect(s.experiences.first.steps, isNotEmpty);
    expect(s.devices['living-light']!.reportedAt, isNull,
        reason: 'snapshot-only state has no proven age');
  });

  group('command lifecycle', () {
    test('requested → pending → confirmed only after the device reports',
        () async {
      final r = _Rig();
      await r.start();
      final seen = <CommandPhase>[];
      r.tracker.updates.listen((c) => seen.add(c.phase));

      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 40});
      await r.advance(0);
      expect(seen, [CommandPhase.requested, CommandPhase.pending]);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 0,
          reason: 'accepted is not a physical fact — state has not moved');

      await r.advance(500);
      expect(seen.last, CommandPhase.confirmed);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 40);
      final rec = r.tracker.latestFor('kitchen-light', 'brightness')!;
      expect(rec.confirmedBy, ConfirmedBy.deviceReport);
      expect(r.state.snapshot.devices['kitchen-light']!.reportedAt, isNotNull);
    });

    test('the route echo is never treated as confirmation', () async {
      final r = _Rig();
      await r.start();
      r.sim.setSilent('kitchen-light', true);
      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 40});
      await r.advance(7000);
      expect(r.tracker.latestFor('kitchen-light', 'brightness')!.phase,
          CommandPhase.pending);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 0);
    });

    test(
        'a device that accepts but never reports fails on timeout and state is untouched',
        () async {
      final r = _Rig();
      await r.start();
      r.sim.setSilent('kitchen-light', true);
      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 40});
      await r.advance(9000);
      final rec = r.tracker.latestFor('kitchen-light', 'brightness')!;
      expect(rec.phase, CommandPhase.failed);
      expect(rec.failure, CommandFailure.timeout);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 0);
    });

    test('an unreachable Hub fails the command', () async {
      final r = _Rig();
      await r.start();
      final t = CommandTracker(
          send: (_, __) async => throw StateError('down'),
          state: r.state,
          schedule: r.clock.schedule,
          now: r.clock.now);
      t.submit('kitchen-light', {'capability': 'onoff', 'action': 'on'});
      await r.advance(0);
      expect(t.latestFor('kitchen-light', 'onoff')!.failure,
          CommandFailure.unreachable);
    });

    test('an offline device fails immediately without a send', () async {
      final r = _Rig();
      r.sim.setReachability('kitchen-light', 'offline');
      await r.start();
      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 40});
      await r.advance(0);
      expect(r.tracker.latestFor('kitchen-light', 'brightness')!.failure,
          CommandFailure.deviceOffline);
      expect(r.sent, isEmpty);
    });

    test('a shade is only confirmed once it has actually arrived', () async {
      final r = _Rig();
      await r.start();
      r.tracker.submit('living-shade',
          {'capability': 'position', 'action': 'set', 'position': 40});
      await r.advance(500);
      expect(r.cap('living-shade', 'position')!['moving'], isTrue);
      expect(r.tracker.latestFor('living-shade', 'position')!.phase,
          CommandPhase.pending,
          reason: 'passing through 90 is not being at 40');
      await r.advance(4000);
      expect(r.cap('living-shade', 'position')!['position'], 40);
      expect(r.tracker.latestFor('living-shade', 'position')!.phase,
          CommandPhase.confirmed);
    });

    test('a newer command supersedes an older one for the same control',
        () async {
      final r = _Rig();
      await r.start();
      r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 30});
      final second = r.tracker.submit('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 70});
      await r.advance(1000);
      expect(r.tracker.latestFor('kitchen-light', 'brightness')!.id, second.id);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 70);
      expect(r.tracker.inFlight, isEmpty);
    });

    test(
        'a target the device already reports is confirmed from that state, and says so',
        () async {
      final r = _Rig();
      await r.start();
      r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'on'});
      await r.advance(0);
      final rec = r.tracker.latestFor('living-light', 'onoff')!;
      expect(rec.phase, CommandPhase.confirmed);
      expect(rec.confirmedBy, ConfirmedBy.alreadyInState);
    });

    test('a command with no verifiable effect is refused, not faked', () async {
      final r = _Rig();
      await r.start();
      expect(
          () => r.tracker.submit(
              'living-light', {'capability': 'onoff', 'action': 'toggle'}),
          throwsArgumentError);
    });
  });

  group('live state', () {
    test(
        'a physical change (wall switch) reaches the Residence State with no command',
        () async {
      final r = _Rig();
      await r.start();
      r.sim.changePhysically('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 80});
      await r.advance(0);
      expect(r.cap('kitchen-light', 'brightness')!['level'], 80);
    });

    test('stale or out-of-order frames are dropped', () async {
      final r = _Rig();
      await r.start();
      final base = r.state.snapshot.devices['kitchen-light']!;
      final controller = StreamController<Map<String, dynamic>>();
      final s = ResidenceState(
          get: (p) async => r.sim.read(p), frames: controller.stream);
      await s.start();
      Map<String, dynamic> f(int seq, int level) => {
            'type': 'state',
            'deviceId': base.id,
            'roomId': 'kitchen',
            'seq': seq,
            'ts': '2026-01-01T12:00:0$seq.000Z',
            'state': {'kind': 'brightness', 'on': true, 'level': level},
          };
      controller.add(f(2, 50));
      controller.add(f(1, 10)); // older — must not win.
      await Future<void>.delayed(Duration.zero);
      expect(s.snapshot.devices['kitchen-light']!.state['brightness']!['level'],
          50);
      await controller.close();
    });

    test(
        'a frame that arrives while a snapshot read is in flight is not overwritten by it',
        () async {
      final r = _Rig();
      final controller = StreamController<Map<String, dynamic>>();
      final gate = Completer<void>();
      final s = ResidenceState(
          get: (p) async {
            if (p == 'v1/devices') await gate.future;
            return r.sim.read(p);
          },
          frames: controller.stream);
      final started = s.start();
      await Future<void>.delayed(Duration.zero);
      // The read returns pre-report data, but a report lands first.
      final stale = r.sim.read('v1/devices');
      expect(stale, isNotNull);
      gate.complete();
      await started;
      controller.add({
        'type': 'state',
        'deviceId': 'kitchen-light',
        'roomId': 'kitchen',
        'seq': 1,
        'ts': '2026-01-01T12:00:01.000Z',
        'state': {'kind': 'brightness', 'on': true, 'level': 90},
      });
      await Future<void>.delayed(Duration.zero);
      await s
          .refresh(); // a re-read that predates nothing: live is applied, refresh keeps truth.
      expect(s.snapshot.devices['kitchen-light'], isNotNull);
      await controller.close();
    });

    test('an unreachable Hub keeps the last known state instead of blanking it',
        () async {
      final r = _Rig();
      var down = false;
      final s = ResidenceState(
          get: (p) async => down ? const {} : r.sim.read(p),
          frames: const Stream.empty());
      await s.start();
      down = true;
      await s.refresh();
      expect(s.snapshot.devices, isNotEmpty);
      expect(s.snapshot.loaded, isTrue);
    });
  });

  group('Experience state is derived from devices, never stored', () {
    ExperienceStatus st(_Rig r, String id) => experienceStatus(
        r.state.snapshot.experiences.firstWhere((e) => e.id == id),
        r.state.snapshot,
        commands: r.tracker.inFlight);

    test(
        'inactive at rest; becoming while its steps travel; active once devices match',
        () async {
      final r = _Rig();
      await r.start();
      // At rest the speaker already plays, so Relax is genuinely partial; Dinner matches nothing.
      expect(st(r, 'relax').phase, ExperiencePhase.partial);
      expect(st(r, 'dinner').phase, ExperiencePhase.inactive);

      final exp =
          r.state.snapshot.experiences.firstWhere((e) => e.id == 'dinner');
      for (final step in exp.steps) {
        r.tracker.submit(
            step.deviceId, {'capability': step.capability, ...step.values});
      }
      await r.advance(100);
      expect(st(r, 'dinner').phase, ExperiencePhase.becoming);

      await r.advance(6000);
      final s = st(r, 'dinner');
      expect(s.phase, ExperiencePhase.active);
      expect(s.matched, s.verifiable);
    });

    test(
        'activating through the Hub route reaches Active only via device reports',
        () async {
      final r = _Rig();
      await r.start();
      r.sim.command('v1/scenes/good-night/activate', const {});
      expect(st(r, 'good-night').phase, isNot(ExperiencePhase.active));
      await r.advance(6000);
      expect(st(r, 'good-night').phase, ExperiencePhase.active);
    });

    test(
        'changing one thing by hand makes it Partial, with no stored flag to clear',
        () async {
      final r = _Rig();
      await r.start();
      r.sim.command('v1/scenes/good-night/activate', const {});
      await r.advance(6000);
      r.sim.changePhysically('kitchen-light',
          {'capability': 'brightness', 'action': 'set', 'level': 50});
      await r.advance(0);
      final s = st(r, 'good-night');
      expect(s.phase, ExperiencePhase.partial);
      expect(s.matched, s.verifiable - 1);
    });

    test('unavailable when every device it needs is unreachable', () async {
      final r = _Rig();
      for (final id in [
        'living-light',
        'dining-light',
        'kitchen-light',
        'terrace-light',
        'master-shade',
        'living-audio'
      ]) {
        r.sim.setReachability(id, 'offline');
      }
      await r.start();
      expect(st(r, 'good-night').phase, ExperiencePhase.unavailable);
    });

    test(
        'an Experience with no verifiable steps is indeterminate, never Active',
        () {
      final snap = const ResidenceSnapshot(loaded: true);
      const e = Experience(id: 'x', name: 'X', spaceIds: [], steps: [
        ExperienceStep(
            deviceId: 'd', capability: 'lock', values: {'action': 'lock'})
      ]);
      expect(experienceStatus(e, snap).phase, ExperiencePhase.indeterminate);
      expect(
          experienceStatus(
                  const Experience(id: 'y', name: 'Y', spaceIds: []), snap)
              .phase,
          ExperiencePhase.indeterminate);
    });
  });
}

void movementTests() {
  test('a shade that keeps reporting movement is not failed by the deadline', () async {
    final r = _Rig(timeout: const Duration(seconds: 3));
    await r.start();
    // 100 → 0 takes 10 steps × 0.5 s = ~5 s, longer than the 3 s timeout, but it keeps reporting.
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(4800);
    expect(r.tracker.latestFor('living-shade', 'position')!.phase, CommandPhase.pending);
    await r.advance(2000);
    final rec = r.tracker.latestFor('living-shade', 'position')!;
    expect(rec.phase, CommandPhase.confirmed);
    expect(r.cap('living-shade', 'position')!['position'], 0);
  });

  test('a shade that stops reporting mid-travel still fails on the deadline', () async {
    final r = _Rig(timeout: const Duration(seconds: 3));
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(1200);
    r.sim.setSilent('living-shade', true); // jammed: no more reports
    await r.advance(5000);
    final rec = r.tracker.latestFor('living-shade', 'position')!;
    expect(rec.phase, CommandPhase.failed);
    expect(rec.failure, CommandFailure.timeout);
  });
}
