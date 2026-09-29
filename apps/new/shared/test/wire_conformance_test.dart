import 'dart:convert';
import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// Contract drift gate, Dart half (Phase 3, step 8): the simulator's wire shapes are held to the
/// shapes the REAL gateway produces, recorded in `packages/domain-model/fixtures/wire-shapes.json`
/// by `services/gateway/src/wire-shapes.e2e.test.ts`. The gateway changing fails that test until
/// the fixture is regenerated; regenerating fails THIS test until the simulator follows.
///
/// Rules: a key without `?` in the fixture is required; a key the fixture does not know is drift
/// (the simulator may not invent fields); `null` / `mixed` in the fixture match any value; a null
/// value matches any expected type (nullable there); `["empty"]` matches any list.
final _fixture = jsonDecode(
        File('../../../packages/domain-model/fixtures/wire-shapes.json').readAsStringSync())
    as Map<String, dynamic>;

String _bare(String k) => k.endsWith('?') ? k.substring(0, k.length - 1) : k;

void _check(Object? shape, Object? actual, String path, List<String> errors) {
  if (actual == null) return;
  if (shape == 'null' || shape == 'mixed') return;
  if (shape is String) {
    final ok = switch (shape) {
      'string' => actual is String,
      'number' => actual is num,
      'boolean' => actual is bool,
      'object' => actual is Map, // open by contract (a command's values, a driver's config)
      _ => false,
    };
    if (!ok) errors.add('$path: expected $shape, got ${actual.runtimeType}');
    return;
  }
  if (shape is List) {
    if (actual is! List) {
      errors.add('$path: expected a list, got ${actual.runtimeType}');
      return;
    }
    if (shape.isEmpty || shape.first == 'empty') return;
    for (var i = 0; i < actual.length; i++) {
      _check(shape.first, actual[i], '$path[$i]', errors);
    }
    return;
  }
  final fields = (shape as Map).cast<String, dynamic>();
  if (actual is! Map) {
    errors.add('$path: expected an object, got ${actual.runtimeType}');
    return;
  }
  final known = {for (final k in fields.keys) _bare(k): k};
  for (final entry in known.entries) {
    final required = !entry.value.endsWith('?');
    if (!actual.containsKey(entry.key)) {
      if (required) errors.add('$path.${entry.key}: required by the gateway, missing here');
      continue;
    }
    _check(fields[entry.value], actual[entry.key], '$path.${entry.key}', errors);
  }
  for (final k in actual.keys) {
    if (!known.containsKey(k)) errors.add('$path.$k: not a gateway field');
  }
}

void _conforms(String name, Object? actual) {
  final errors = <String>[];
  _check(_fixture[name], actual, name, errors);
  expect(errors, isEmpty, reason: errors.take(12).join('\n'));
}

void main() {
  test('fixture covers everything the client reads', () {
    expect(_fixture.keys.toSet(),
        {'home', 'devices', 'scenes', 'activate', 'runFrame', 'stateFrame', 'command'});
  });

  test('GET /v1/home', () {
    _conforms('home', SimulatedResidence().read('v1/home'));
  });

  test('GET /v1/devices', () {
    _conforms('devices', SimulatedResidence().read('v1/devices'));
  });

  test('GET /v1/scenes', () {
    _conforms('scenes', SimulatedResidence().read('v1/scenes'));
  });

  test('POST /v1/scenes/:id/activate, the run frames and the device state frames', () async {
    final clock = ManualScheduler();
    final sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    final frames = <Map<String, dynamic>>[];
    final sub = sim.stream.frames.listen(frames.add);
    final res = sim.command('v1/scenes/relax/activate', {});
    _conforms('activate', res);
    await clock.advance(const Duration(seconds: 60));
    final run = frames.firstWhere((f) => f['type'] == 'run');
    final state = frames.firstWhere((f) => f['type'] == 'state');
    _conforms('runFrame', run);
    _conforms('stateFrame', state);
    expect((state['state'] as Map)['kind'], isA<String>(), reason: 'every report names its capability');
    await sub.cancel();
    await sim.dispose();
  });

  test('POST /v1/devices/:id/command', () async {
    final clock = ManualScheduler();
    final sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    _conforms(
        'command',
        sim.command('v1/devices/living-light/command',
            {'command': {'capability': 'onoff', 'action': 'on'}}));
    await clock.advance(const Duration(seconds: 2));
    await sim.dispose();
  });

  test('the checker itself catches an invented field, a missing one and a wrong type', () {
    final errors = <String>[];
    _check({'a': 'string', 'b?': 'number'}, {'a': 1, 'c': true}, 'x', errors);
    expect(errors, containsAll(['x.a: expected string, got int', 'x.c: not a gateway field']));
    final missing = <String>[];
    _check({'a': 'string'}, <String, dynamic>{}, 'x', missing);
    expect(missing.single, contains('required by the gateway'));
  });
}
