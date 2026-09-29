import 'dart:convert';
import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// The Hub and the client must agree on what "done" means. Both implementations of
/// `expectationOf` are pinned to the same fixture (`packages/domain-model/fixtures/
/// state-expectation.json`, exercised on the TS side by `state-expectation.test.ts`).
void main() {
  final raw = jsonDecode(File('../../../packages/domain-model/fixtures/state-expectation.json')
      .readAsStringSync()) as Map<String, dynamic>;
  for (final c in (raw['cases'] as List).cast<Map<String, dynamic>>()) {
    final cap = c['capability'] as String;
    final cmd = (c['command'] as Map).cast<String, dynamic>();
    test('$cap $cmd', () {
      final e = expectationOf(cap, {'capability': cap, ...cmd});
      if (c['verifiable'] != true) {
        expect(e, isNull);
        return;
      }
      expect(e, isNotNull);
      for (final s in (c['states'] as List).cast<Map<String, dynamic>>()) {
        expect(e!.matches((s['state'] as Map).cast<String, dynamic>()), s['matches'],
            reason: '${s['state']}');
      }
    });
  }
}
