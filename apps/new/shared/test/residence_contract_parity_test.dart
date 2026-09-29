import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// `DeviceRecord`/`ExperienceStep` are read models of the Hub's `Device`/`SceneStep`. This fails if
/// the domain-model contract gains or renames a field the client reads, so the projection can
/// never drift silently (same idea as capability_parity_test.dart).
void main() {
  phase3Parity();
  final ts =
      File('../../../packages/domain-model/src/entities.ts').readAsStringSync();

  Set<String> fields(String schema) {
    final m = RegExp('export const $schema = z\\.object\\(\\{(.*?)\\n\\}\\);',
            dotAll: true)
        .firstMatch(ts)!;
    return RegExp(r'^  (\w+):', multiLine: true)
        .allMatches(m.group(1)!)
        .map((x) => x.group(1)!)
        .toSet();
  }

  test('Device fields the client reads exist in the contract', () {
    final device = fields('Device');
    for (final f in [
      'id',
      'roomId',
      'name',
      'supremeType',
      'status',
      'capabilities',
      'state'
    ]) {
      expect(device, contains(f), reason: 'Device.$f');
    }
    final json = {
      for (final f in device) f: null,
      'id': 'd',
      'name': 'n',
      'capabilities': <dynamic>[],
      'state': <String, dynamic>{}
    };
    expect(DeviceRecord.fromJson(json), isNotNull);
  });

  test('SceneStep and Room fields the client reads exist in the contract', () {
    expect(
        fields('SceneStep'), containsAll(['deviceId', 'capability', 'values']));
    expect(
        fields('Room'), containsAll(['id', 'name', 'floor', 'heroImageUrl']));
    expect(fields('Scene'),
        containsAll(['id', 'name', 'roomId', 'steps', 'icon']));
  });

  test('every DeviceStatus value maps to a reachability', () {
    final m = RegExp(r'DeviceStatus = z\.enum\(\[(.*?)\]\)').firstMatch(ts)!;
    final values =
        RegExp(r'"(\w+)"').allMatches(m.group(1)!).map((x) => x.group(1)!);
    expect(values.toSet(), {'online', 'offline', 'unavailable'});
    for (final v in values) {
      final d = DeviceRecord.fromJson({
        'id': 'd',
        'name': 'n',
        'status': v,
        'capabilities': <dynamic>[],
        'state': <String, dynamic>{}
      })!;
      expect(d.reachability.name, v);
    }
  });
}

/// Phase 3: the Hub-orchestrated Experience contract and the assets it serves. Field names are read
/// from the TypeScript source of truth, so the Dart projection cannot drift silently.
void phase3Parity() {
  final runs = File('../../../packages/supreme-contracts/src/scene-runs.ts').readAsStringSync();
  final entities = File('../../../packages/domain-model/src/entities.ts').readAsStringSync();

  Set<String> fieldsIn(String src, String schema) {
    final m = RegExp('export const $schema = (?:\\w+\\.extend\\(|z\\.object\\()\\{(.*?)\\n\\}\\);', dotAll: true)
        .firstMatch(src);
    if (m == null) fail('schema $schema not found');
    return RegExp(r'^  (\w+):', multiLine: true).allMatches(m.group(1)!).map((x) => x.group(1)!).toSet();
  }

  List<String> enumValues(String src, String name) {
    final m = RegExp('export const $name = z\\.enum\\(\\[(.*?)\\]\\)', dotAll: true).firstMatch(src)!;
    return RegExp(r'"(\w+)"').allMatches(m.group(1)!).map((x) => x.group(1)!).toList();
  }

  test('SceneRun and SceneRunStep: every contract field is read by the client model', () {
    expect(fieldsIn(runs, 'SceneRun'),
        {'runId', 'sceneId', 'spaceIds', 'status', 'startedAt', 'finishedAt', 'phase', 'phases', 'steps', 'supersededBy'});
    expect(fieldsIn(runs, 'SceneRunStep'),
        {'stepId', 'deviceId', 'roomId', 'capability', 'state', 'verifiable', 'reason'});
    final json = {
      'runId': 'r', 'sceneId': 's', 'spaceIds': <dynamic>[], 'status': 'running',
      'startedAt': '2026-01-01T00:00:00.000Z', 'finishedAt': null, 'phase': 0, 'phases': 0,
      'supersededBy': null,
      'steps': [
        {'stepId': 's:0', 'deviceId': 'd', 'roomId': null, 'capability': 'onoff', 'state': 'queued', 'verifiable': true, 'reason': null}
      ],
    };
    final r = SceneRun.fromJson(json)!;
    expect(r.steps.single.state, RunStepState.queued);
    expect(r.isRunning, isTrue);
  });

  test('every step and run status the Hub can send is known to the client', () {
    expect(enumValues(runs, 'SceneRunStepState').toSet(), RunStepState.values.map((e) => e.name).toSet());
    expect(enumValues(runs, 'SceneRunStatus').toSet(), RunStatus.values.map((e) => e.name).toSet());
  });

  test('the Scene fields the client reads exist in the contract', () {
    expect(fieldsIn(entities, 'Scene'), containsAll(['description', 'phases', 'steps', 'icon']));
    expect(fieldsIn(runs, 'SceneView'), contains('roomIds'));
    expect(fieldsIn(entities, 'Home'), contains('heroImageUrl'));
  });

  test('a run frame is a full snapshot under type "run"', () {
    expect(runs, contains('type: z.literal("run")'));
    expect(runs, contains('run: SceneRun'));
  });
}
