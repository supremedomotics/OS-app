import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/features/spaces/space_screen.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../support/sim_app.dart';

/// Visual QA capture harness (not a test of behaviour): renders every homeowner surface at every
/// physical surface size against the simulated residence, with the REAL bundled fonts, and writes
/// PNGs for side-by-side review against `docs/design/golden-master/`.
///
///   CAPTURE_DIR=/some/dir flutter test test/tools/capture_test.dart
///
/// Skipped unless CAPTURE_DIR is set, so it never runs in the normal suite.
final _dir = Platform.environment['CAPTURE_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, List<String> files) async {
    final l = FontLoader(family);
    for (final f in files) {
      final b = await File('../shared_ui/assets/fonts/$f').readAsBytes();
      l.addFont(Future.value(ByteData.view(b.buffer)));
    }
    await l.load();
  }

  await load(
      'packages/supreme_os_ui/SOSSans', ['Jost-Light.ttf', 'Jost-Regular.ttf']);
  await load(
      'packages/supreme_os_ui/SOSSerif', ['CormorantGaramond-Light.ttf']);
}

class _Shot {
  final String name;
  final Size size;
  final double dpr;
  final TargetPlatform platform;
  const _Shot(this.name, this.size,
      {this.dpr = 2, this.platform = TargetPlatform.android});
}

const _sizes = [
  _Shot('phone', Size(390, 844)),
  _Shot('phone-landscape', Size(844, 390)),
  _Shot('tablet', Size(834, 1112)),
  _Shot('desktop', Size(1440, 900), dpr: 1, platform: TargetPlatform.macOS),
  _Shot('ultrawide', Size(2560, 1440), dpr: 1, platform: TargetPlatform.macOS),
  _Shot('watch', Size(198, 242)),
];

Future<void> _write(WidgetTester tester, GlobalKey key, String file) async {
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_dir/$file.png').writeAsBytes(bytes!.buffer.asUint8List());
  });
}

void main() {
  final skip = _dir == null ? 'set CAPTURE_DIR to capture' : null;

  setUpAll(() async {
    if (skip == null) {
      TestWidgetsFlutterBinding.ensureInitialized();
      await _loadFonts();
      await Directory(_dir!).create(recursive: true);
    }
  });

  for (final s in _sizes) {
    testWidgets('capture ${s.name}', skip: skip != null, (tester) async {
      debugDefaultTargetPlatformOverride = s.platform;
      final app = SimApp(hour: 15);
      final key = GlobalKey();
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = s.size * s.dpr;
      tester.view.devicePixelRatio = s.dpr;
      addTearDown(tester.view.reset);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
      });
      try {
        await tester.pumpWidget(ProviderScope(
            overrides: app.overrides,
            child: RepaintBoundary(key: key, child: const SupremeMobileApp())));
        await app.settle(tester, 200);
        await tester.pump(const Duration(milliseconds: 1200));

        await _write(tester, key, '${s.name}-home');
      // The watch has no navigation (its glance is Phase 4): Home is all there is to capture.
      if (s.name == 'watch') {
        debugDefaultTargetPlatformOverride = null;
        return;
      }

        await tester.tap(find.text('Spaces').last);
        await app.settle(tester);
        await tester.pump(const Duration(milliseconds: 1200));
        await _write(tester, key, '${s.name}-spaces');

        final plate = find.byKey(const ValueKey('space-living'));
        if (plate.evaluate().isNotEmpty) {
          await tester.ensureVisible(plate);
          await tester.pump();
          await tester.tapAt(tester.getTopLeft(plate) + const Offset(30, 30));
          await app.settle(tester);
          await tester.pump(const Duration(milliseconds: 1200));
          await _write(tester, key, '${s.name}-space');

          final control = s.name == 'desktop' || s.name == 'ultrawide'
              ? find.text('Residence control')
              : find.text('Control');
          if (control.evaluate().isNotEmpty) {
            await tester.tap(control.last);
            await app.settle(tester);
            await tester.pump(const Duration(milliseconds: 700));
            await _write(tester, key, '${s.name}-control');
            final light = find.byKey(const ValueKey('control-system-lighting'));
            if (light.evaluate().isNotEmpty) {
              await tester.tap(light);
              await app.settle(tester);
              await tester.pump(const Duration(milliseconds: 400));
              await _write(tester, key, '${s.name}-control-lighting');
            }
            final back = find.byKey(const ValueKey('control-back'));
            if (back.evaluate().isNotEmpty) {
              await tester.tap(back);
              await app.settle(tester);
            }
            final devices = find.byKey(const ValueKey('control-devices'));
            if (devices.evaluate().isNotEmpty) {
              await tester.tap(devices);
              await app.settle(tester);
              await tester.pump(const Duration(milliseconds: 700));
              await _write(tester, key, '${s.name}-devices');
              final row = find.byKey(const ValueKey('device-living-light'));
              if (row.evaluate().isNotEmpty) {
                await tester.ensureVisible(row.first);
                await tester.tap(row.first);
                await app.settle(tester);
                await tester.pump(const Duration(milliseconds: 700));
                await _write(tester, key, '${s.name}-device-sheet');
                await tester.tap(find.byKey(const ValueKey('layer-close')).last);
                await app.settle(tester);
                await tester.pump(const Duration(milliseconds: 700));
              }
              await tester.tap(find.byKey(const ValueKey('layer-close')).last);
              await app.settle(tester);
              await tester.pump(const Duration(milliseconds: 700));
            }
            final close = find.byKey(const ValueKey('control-close'));
            if (close.evaluate().isNotEmpty) {
              await tester.tap(close);
              await app.settle(tester);
              await tester.pump(const Duration(milliseconds: 700));
            }
          }
        }

        await tester.tap(find.text('Experiences').last);
        await app.settle(tester);
        await tester.pump(const Duration(milliseconds: 1200));
        await _write(tester, key, '${s.name}-experiences');

      await tester.tap(find.text('Settings').last);
      await app.settle(tester);
      await tester.pump(const Duration(milliseconds: 1200));
      await _write(tester, key, '${s.name}-settings');
      } finally {
        // Must be undone inside the test: the framework checks foundation variables on exit.
        debugDefaultTargetPlatformOverride = null;
      }
    });
  }

  testWidgets('capture room-panel', skip: skip != null, (tester) async {
    final app = SimApp(hour: 15);
    final key = GlobalKey();
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(320, 480) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
    });
    await tester.pumpWidget(ProviderScope(
      overrides: app.overrides,
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          theme: buildSupremeTheme(),
          debugShowCheckedModeBanner: false,
          builder: (c, child) => SurfaceScope(
              installedPanel: SurfacePanelBinding.room,
              physicalSizeInches: 4,
              child: AdaptiveScope(child: child!)),
          home: Scaffold(body: SpaceScreen(spaceId: 'living', onBack: () {})),
        ),
      ),
    ));
    await app.settle(tester, 200);
    await tester.pump(const Duration(milliseconds: 1200));
    await _write(tester, key, 'room-panel-space');
  });
}
