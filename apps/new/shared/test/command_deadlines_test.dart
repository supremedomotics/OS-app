import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

import 'support/residence_rig.dart';

void main() {
  test('the deadline table is the Hub scene runner\'s own (parsed from the TS source)', () {
    final src = File('../../../services/gateway/src/scene-runs.ts').readAsStringSync();
    final block =
        RegExp(r'DEFAULT_DEADLINES[^{]*\{([^}]*)\}').firstMatch(src)!.group(1)!;
    final ts = {
      for (final m in RegExp(r'(\w+):\s*([\d_]+)').allMatches(block))
        m.group(1)!: Duration(milliseconds: int.parse(m.group(2)!.replaceAll('_', '')))
    };
    expect(ts, isNotEmpty);
    expect(defaultCommandDeadlines, ts);
    final fallback = RegExp(r'FALLBACK_DEADLINE\s*=\s*([\d_]+)').firstMatch(src)!.group(1)!;
    expect(fallbackCommandDeadline, Duration(milliseconds: int.parse(fallback.replaceAll('_', ''))));
  });

  test('each capability has its own deadline; an unknown one falls back; overrides win', () async {
    final r = Rig();
    await r.start();
    expect(r.tracker.deadlineFor('onoff'), const Duration(seconds: 10));
    expect(r.tracker.deadlineFor('temperature'), const Duration(seconds: 15));
    expect(r.tracker.deadlineFor('position'), const Duration(seconds: 90));
    expect(r.tracker.deadlineFor('somethingelse'), fallbackCommandDeadline);
    final pinned = Rig(commandTimeout: const Duration(seconds: 3));
    expect(pinned.tracker.deadlineFor('position'), const Duration(seconds: 3));
    final over = Rig(deadlines: {'media': const Duration(seconds: 4)});
    expect(over.tracker.deadlineFor('media'), const Duration(seconds: 4));
    expect(over.tracker.deadlineFor('onoff'), const Duration(seconds: 10));
  });

  test('a light that never answers is failed at ITS deadline, not before', () async {
    final r = Rig();
    r.sim.setSilent('living-light', true);
    await r.start();
    final rec = r.tracker.submit('living-light', {'capability': 'brightness', 'action': 'set', 'level': 20});
    await r.advance(9000);
    expect(r.tracker.latestFor('living-light', 'brightness')!.phase, CommandPhase.pending);
    await r.advance(1500);
    final done = r.tracker.latestFor('living-light', 'brightness')!;
    expect(done.id, rec.id);
    expect(done.failure, CommandFailure.timeout);
  });

  test('a curtain that never answers is not called unresponsive at 8 s or at a minute', () async {
    final r = Rig();
    r.sim.setSilent('living-shade', true);
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(60000);
    expect(r.tracker.latestFor('living-shade', 'position')!.inFlight, isTrue,
        reason: 'a curtain takes a minute; the residence must not say it did not respond yet');
    await r.advance(31000);
    expect(r.tracker.latestFor('living-shade', 'position')!.failure, CommandFailure.timeout);
  });

  test('a device still reporting movement restarts its deadline and is not failed by it', () async {
    // ~18.5 s of travel (ten 2 s steps after the report latency) against a 5 s deadline: only the
    // movement reports keep it alive.
    final r = Rig(deadlines: {'position': const Duration(seconds: 5)}, shadeStep: const Duration(seconds: 2));
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(15000);
    expect(r.tracker.latestFor('living-shade', 'position')!.inFlight, isTrue,
        reason: 'three deadlines have passed, but the curtain keeps reporting movement');
    await r.advance(6000);
    final rec = r.tracker.latestFor('living-shade', 'position')!;
    expect(rec.phase, CommandPhase.confirmed);
    expect(rec.confirmedBy, ConfirmedBy.deviceReport);
  });

  test('and the same 5 s deadline fails a silent curtain, so the extension is the movement\'s', () async {
    final r = Rig(deadlines: {'position': const Duration(seconds: 5)});
    r.sim.setSilent('living-shade', true);
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(6000);
    expect(r.tracker.latestFor('living-shade', 'position')!.failure, CommandFailure.timeout);
  });
}
