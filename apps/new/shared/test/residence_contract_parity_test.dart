import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// `DeviceRecord`/`ExperienceStep` are read models of the Hub's `Device`/`SceneStep`. This fails if
/// the domain-model contract gains or renames a field the client reads, so the projection can
/// never drift silently (same idea as capability_parity_test.dart).
void main() {
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
