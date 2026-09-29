import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

import 'support/residence_rig.dart';

void main() {
  test('whole residence: requested → pending → confirmed, derived from device state', () async {
    final r = Rig();
    await r.start();
    final seen = <ActivationPhase>[];
    r.activations.updates.listen((a) => seen.add(a.phase));

    final a = r.activations.activate(r.exp('good-night'));
    expect(a.phase, ActivationPhase.requested);
    expect(r.sent, ['v1/scenes/good-night/activate'], reason: 'one request; the client sends no device commands');
    await r.advance(50);
    expect(r.activations.latestFor('good-night')!.phase, ActivationPhase.pending);
    expect(r.activations.latestFor('good-night')!.runId, isNotNull);

    await r.advance(100000);
    expect(r.activations.latestFor('good-night')!.phase, ActivationPhase.confirmed);
    expect(seen.first, ActivationPhase.requested);
    expect(seen.last, ActivationPhase.confirmed);
    expect(r.sent.where((p) => p.contains('/command')), isEmpty);
    expect(r.status('good-night').phase, ExperiencePhase.active);
  });

  test('phases are ordered by the Hub: the curtains start before the light', () async {
    final r = Rig();
    await r.start();
    r.activations.activate(r.exp('relax'));
    await r.advance(50);
    final run = r.snap.runs.values.single;
    final byDevice = {for (final s in run.steps) s.deviceId: s};
    expect(byDevice['living-shade']!.state, RunStepState.sent);
    expect(byDevice['living-light']!.state, RunStepState.queued, reason: 'second phase waits on the first');
    await r.advance(100000);
    expect(r.snap.runs.values.single.status, RunStatus.completed);
    expect(r.activations.latestFor('relax')!.phase, ActivationPhase.confirmed);
  });

  test('a scoped activation is confirmed for that space only', () async {
    final r = Rig();
    await r.start();
    r.activations.activate(r.exp('relax'), spaceIds: ['dining']);
    await r.advance(5000);
    final a = r.activations.latestFor('relax', spaceIds: ['dining'])!;
    expect(a.phase, ActivationPhase.confirmed);
    expect(r.activations.latestFor('relax'), isNull, reason: 'a different scope is a different activation');
    expect(r.cap('living-light', 'brightness')?['level'], isNot(30));
  });

  test('unreachable Hub → failed(unreachable)', () async {
    final r = Rig();
    await r.start();
    final act = ExperienceActivations(
        post: (_, __) async => throw StateError('offline'), state: r.state, now: r.clock.now);
    act.activate(r.exp('relax'));
    await r.advance(10);
    expect(act.latestFor('relax')!.phase, ActivationPhase.failed);
    expect(act.latestFor('relax')!.failure, ActivationFailure.unreachable);
    await act.dispose();
  });

  test('a refusal → failed(rejected)', () async {
    final r = Rig();
    await r.start();
    final act = ExperienceActivations(
        post: (_, __) async => {'activated': false}, state: r.state, now: r.clock.now);
    act.activate(r.exp('relax'));
    await r.advance(10);
    expect(act.latestFor('relax')!.failure, ActivationFailure.rejected);
    await act.dispose();
  });

  test('a device that never reports → the run times out → failed(incomplete)', () async {
    final r = Rig();
    r.sim.setSilent('dining-light', true);
    await r.start();
    r.activations.activate(r.exp('dinner'));
    await r.advance(60000);
    final a = r.activations.latestFor('dinner')!;
    expect(a.phase, ActivationPhase.failed);
    expect(a.failure, ActivationFailure.incomplete);
    final run = r.snap.runs[a.runId]!;
    expect(run.unmetCount, greaterThan(0));
    expect(run.steps.firstWhere((s) => s.deviceId == 'dining-light').state, RunStepState.timeout);
  });

  test('a newer activation supersedes the earlier run', () async {
    final r = Rig();
    await r.start();
    r.activations.activate(r.exp('relax'));
    await r.advance(50);
    r.activations.activate(r.exp('good-night'));
    await r.advance(100000);
    expect(r.snap.runs.values.any((x) => x.supersededBy != null), isTrue);
    expect(r.activations.latestFor('good-night')!.phase, ActivationPhase.confirmed);
  });
}
