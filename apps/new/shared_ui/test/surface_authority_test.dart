import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// SURFACE AUTHORITY INVARIANT (static half) — mirrors the reference `tests/authority.js`.
/// Raw surface inputs are read only by `SurfaceScope`; the legacy classifier is reachable only
/// from the compatibility adapter. A planted rogue proves the scan can fail.
const _scanRoots = [
  '../shared/lib',
  '../shared_ui/lib',
  '../mobile/lib',
  '../touchpanel/lib',
];

/// Files allowed to read raw surface inputs.
const _authority = 'shared_ui/lib/src/adaptive/surface_scope.dart';

/// The legacy classifier's definition and its one adapter.
const _legacyClassifier = {
  'shared/lib/src/design/adaptive.dart',
  'shared_ui/lib/src/adaptive/adaptive_scope.dart',
};

final _rawInput = RegExp(
    r'MediaQuery\s*\.\s*(maybeOf|of|sizeOf|maybeSizeOf|orientationOf|maybeOrientationOf|displayFeaturesOf|maybeDisplayFeaturesOf)\b'
    r'|PlatformDispatcher|\bView\s*\.\s*(maybeOf|of)\s*\(');
final _legacyCall = RegExp(r'classifyAdaptive\s*\(');

String _stripComments(String source) => source
    .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '')
    .replaceAll(RegExp(r'//[^\n]*'), '');

List<String> rawInputViolations(String source) => _rawInput
    .allMatches(_stripComments(source))
    .map((m) => m.group(0)!)
    .toList();

List<String> legacyClassifierCalls(String source) => _legacyCall
    .allMatches(_stripComments(source))
    .map((m) => m.group(0)!)
    .toList();

Iterable<File> _dartFiles() sync* {
  for (final root in _scanRoots) {
    final dir = Directory(root);
    expect(dir.existsSync(), isTrue,
        reason: '$root not found from ${Directory.current.path} — '
            'the authority scan must never silently skip a package');
    yield* dir
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'));
  }
}

String _rel(File f) {
  final p = f.path.replaceAll('\\', '/');
  final i = p.indexOf('/lib/');
  final pkgStart = p.lastIndexOf('/', p.lastIndexOf('/', i) - 1);
  return p.substring(pkgStart + 1);
}

void main() {
  test('only SurfaceScope reads raw surface inputs', () {
    final offenders = <String>[];
    var scanned = 0;
    for (final f in _dartFiles()) {
      scanned++;
      final rel = _rel(f);
      if (rel == _authority) continue;
      final hits = rawInputViolations(f.readAsStringSync());
      if (hits.isNotEmpty) offenders.add('$rel: ${hits.join(', ')}');
    }
    expect(scanned, greaterThan(20), reason: 'scan found suspiciously few files');
    expect(offenders, isEmpty);
  });

  test('the legacy classifier is called only from the compatibility adapter', () {
    final offenders = <String>[];
    for (final f in _dartFiles()) {
      final rel = _rel(f);
      if (_legacyClassifier.contains(rel)) continue;
      if (legacyClassifierCalls(f.readAsStringSync()).isNotEmpty) {
        offenders.add(rel);
      }
    }
    expect(offenders, isEmpty);
  });

  test('the authority file itself reads the raw inputs (the scan is looking at the right file)',
      () {
    final authority = _dartFiles().firstWhere((f) => _rel(f) == _authority);
    expect(rawInputViolations(authority.readAsStringSync()), isNotEmpty);
  });

  test('negative control: a planted rogue classifier is detected', () {
    const rogue = '''
      Widget build(BuildContext context) {
        final w = MediaQuery.sizeOf(context).width;
        return w < 600 ? const PhoneLayout() : const DesktopLayout();
      }
    ''';
    expect(rawInputViolations(rogue), isNotEmpty);
    expect(rawInputViolations('final x = MediaQuery.of(context).size;'),
        isNotEmpty);
    expect(legacyClassifierCalls('final p = classifyAdaptive(widthDp: 1, heightDp: 2);'),
        isNotEmpty);
  });

  test('comments mentioning the inputs are not violations; padding/insets are allowed', () {
    expect(rawInputViolations('// MediaQuery.sizeOf(context) is read in SurfaceScope'),
        isEmpty);
    expect(rawInputViolations('/// see MediaQuery.of\n'), isEmpty);
    expect(rawInputViolations('final p = MediaQuery.paddingOf(context);'),
        isEmpty);
    expect(rawInputViolations('final k = MediaQuery.viewInsetsOf(context);'),
        isEmpty);
  });
}
