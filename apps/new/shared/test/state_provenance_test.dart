import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

import 'support/residence_rig.dart';

/// State provenance on the client (physical-driver validation gate, Option A): only a device's own
/// observed report is state, and only such a report can confirm a command.
Map<String, dynamic> _frame(String id, String kind, Map<String, dynamic> state,
        {String? provenance, int seq = 900, String room = 'living'}) =>
    {
      'type': 'state',
      'homeId': 'sim-home',
      'roomId': room,
      'deviceId': id,
      'state': {'kind': kind, ...state},
      if (provenance != null) 'provenance': provenance,
      'seq': seq,
      'ts': DateTime.utc(2026, 1, 1, 12).toIso8601String(),
    };

void main() {
  test('silent actuator: the command stays pending and ultimately fails — never confirmed', () async {
    final r = Rig();
    r.sim.setSilent('living-light', true);
    await r.start();
    r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'off'});
    await r.advance(9000);
    expect(r.tracker.latestFor('living-light', 'onoff')!.phase, CommandPhase.pending);
    await r.advance(2000);
    final rec = r.tracker.latestFor('living-light', 'onoff')!;
    expect(rec.phase, CommandPhase.failed);
    expect(rec.failure, CommandFailure.timeout);
    expect(rec.physicallyConfirmed, isFalse);
  });

  test('a real (observed) status report confirms the command, by the device\'s report', () async {
    final r = Rig();
    await r.start();
    r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'off'});
    await r.advance(1000);
    final rec = r.tracker.latestFor('living-light', 'onoff')!;
    expect(rec.phase, CommandPhase.confirmed);
    expect(rec.confirmedBy, ConfirmedBy.deviceReport);
    expect(rec.physicallyConfirmed, isTrue);
  });

  test('a COMMANDED frame that satisfies the target never confirms, never changes state, never advances seq', () async {
    final r = Rig();
    r.sim.setSilent('living-light', true);
    await r.start();
    final before = r.snap.devices['living-light']!;
    r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'off'});
    await r.advance(100);
    for (final p in ['commanded', 'assumed', 'unknown']) {
      r.sim.injectFrame(_frame('living-light', 'onoff', {'on': false}, provenance: p));
    }
    await r.advance(100);

    expect(r.state.nonObservedFrames, 3);
    expect(r.tracker.latestFor('living-light', 'onoff')!.phase, CommandPhase.pending);
    expect(r.snap.devices['living-light']!.state['onoff'], before.state['onoff'],
        reason: 'the residence still holds what the device last REPORTED');
    expect(r.snap.devices['living-light']!.seq, before.seq);

    // A genuine observed report afterwards is accepted even with a seq lower than the ignored frames'.
    r.sim.injectFrame(_frame('living-light', 'onoff', {'on': false}, provenance: 'observed', seq: 1));
    await r.advance(10);
    expect(r.tracker.latestFor('living-light', 'onoff')!.phase, CommandPhase.confirmed);
    expect(r.tracker.latestFor('living-light', 'onoff')!.physicallyConfirmed, isTrue);
  });

  test('a frame from a Hub that predates provenance is an observed report (unchanged behaviour)', () async {
    final r = Rig();
    r.sim.setSilent('living-light', true);
    await r.start();
    r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'off'});
    await r.advance(100);
    r.sim.injectFrame(_frame('living-light', 'onoff', {'on': false}, seq: 5));
    await r.advance(10);
    expect(r.tracker.latestFor('living-light', 'onoff')!.confirmedBy, ConfirmedBy.deviceReport);
    expect(r.state.nonObservedFrames, 0);
  });

  test('a control that DECLARES no feedback is "sent, unverified" — never physically confirmed, no state fabricated', () async {
    final r = Rig();
    r.sim.declareNoFeedback('living-light', 'onoff');
    await r.start();
    final before = r.snap.devices['living-light']!.state['onoff'];
    r.tracker.submit('living-light', {'capability': 'onoff', 'action': 'off'});
    await r.advance(50);

    final rec = r.tracker.latestFor('living-light', 'onoff')!;
    expect(rec.phase, CommandPhase.confirmed, reason: 'the lifecycle is unchanged: it settles');
    expect(rec.confirmedBy, ConfirmedBy.sentOnly);
    expect(rec.physicallyConfirmed, isFalse);
    expect(r.snap.devices['living-light']!.state['onoff'], before, reason: 'nothing was reported, so nothing changed');
    await r.advance(20000);
    expect(r.tracker.latestFor('living-light', 'onoff')!.confirmedBy, ConfirmedBy.sentOnly,
        reason: 'it is not later called a timeout: it could never have answered');
  });

  test('a control WITH feedback is never given the sent-only outcome', () async {
    final r = Rig();
    r.sim.setSilent('dining-light', true);
    await r.start();
    r.tracker.submit('dining-light', {'capability': 'brightness', 'action': 'off'});
    await r.advance(100);
    expect(r.tracker.latestFor('dining-light', 'brightness')!.inFlight, isTrue);
  });

  test('shade motion: unknown is neither moving nor not moving', () async {
    final r = Rig();
    await r.start();
    // A KNX-style position report: where it is, nothing about travel.
    r.sim.injectFrame(_frame('living-shade', 'position', {'position': 40, 'moving': null},
        provenance: 'observed', seq: 50));
    await r.advance(10);
    final shades = RoomShades.of(r.snap.devicesIn('living'), const [])!;
    expect(r.cap('living-shade', 'position')!['moving'], isNull);
    expect(shades.position, 40);
    expect(shades.moving, isFalse, reason: 'nothing says it is moving');
    expect(shades.motionKnown, isFalse, reason: '…and nothing says it is standing still either');
    expect(deviceStateSentence(r.snap.devices['living-shade']!), '40% open',
        reason: 'no claim of "Moving" and none of "Settled"');

    // A protocol that DOES report motion is known.
    r.sim.injectFrame(_frame('living-shade', 'position', {'position': 45, 'moving': true},
        provenance: 'observed', seq: 51));
    await r.advance(10);
    final moving = RoomShades.of(r.snap.devicesIn('living'), const [])!;
    expect(moving.moving, isTrue);
    expect(moving.motionKnown, isTrue);
  });

  test('unknown motion never extends a deadline (only reported movement does)', () async {
    final r = Rig(deadlines: {'position': const Duration(seconds: 5)});
    r.sim.setSilent('living-shade', true);
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(2000);
    // An observed report that does not satisfy the target and says nothing about motion.
    r.sim.injectFrame(_frame('living-shade', 'position', {'position': 80, 'moving': null},
        provenance: 'observed', seq: 60));
    await r.advance(4000);
    expect(r.tracker.latestFor('living-shade', 'position')!.failure, CommandFailure.timeout,
        reason: 'the deadline was not restarted by a report that does not claim movement');
  });
}
