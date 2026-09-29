import 'dart:io';

import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// The Dart `CapabilityKind` is a projection of `packages/domain-model/src/capabilities.ts`.
/// This reads the TS source of truth so the two vocabularies cannot drift silently.
File _tsCapabilities() {
  var dir = Directory.current.absolute;
  for (var i = 0; i < 8; i++) {
    final f = File('${dir.path}/packages/domain-model/src/capabilities.ts');
    if (f.existsSync()) return f;
    dir = dir.parent;
  }
  fail('packages/domain-model/src/capabilities.ts not found above '
      '${Directory.current.path} — the parity test must never silently skip.');
}

List<String> _tsKinds(String source) {
  final noBlock = source.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');
  final noLine = noBlock.replaceAll(RegExp(r'//[^\n]*'), '');
  final m = RegExp(r'export const CapabilityKind = z\.enum\(\[([\s\S]*?)\]\)')
      .firstMatch(noLine);
  if (m == null) fail('CapabilityKind z.enum not found in capabilities.ts');
  return RegExp(r'"(\w+)"')
      .allMatches(m.group(1)!)
      .map((e) => e.group(1)!)
      .toList();
}

void main() {
  test('Dart CapabilityKind matches the TypeScript domain-model vocabulary', () {
    final ts = _tsKinds(_tsCapabilities().readAsStringSync());
    final dart = CapabilityKind.values.map((e) => e.name).toList();

    expect(ts, isNotEmpty);
    expect(dart.toSet().difference(ts.toSet()), isEmpty,
        reason: 'capability in Dart but not in TS (invented)');
    expect(ts.toSet().difference(dart.toSet()), isEmpty,
        reason: 'capability in TS but missing from Dart (drift)');
    expect(dart, ts, reason: 'same order keeps the two files diffable');
  });

  test('remote and display exist in the Dart vocabulary', () {
    expect(CapabilityKind.values.map((e) => e.name),
        containsAll(['remote', 'display']));
  });

  test('the comment parser ignores capability names quoted inside comments', () {
    const src = '''
export const CapabilityKind = z.enum([
  "onoff", // generic "media" toggle
  /** mentions "ghost" in a block comment */
  "remote",
]);''';
    expect(_tsKinds(src), ['onoff', 'remote']);
  });
}
