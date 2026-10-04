@Tags(['golden-master'])
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/data/home_location.dart';
import 'package:supreme_mobile_next/data/simulation_photography.dart';
import 'package:supreme_mobile_next/features/onboarding/presence_engine.dart';
import 'package:supreme_mobile_next/features/settings/home_settings_screen.dart'
    show PairHomeResult;
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../support/sim_app.dart';
import 'probe.dart';

/// Captures the Flutter homeowner app at the same profiles and surfaces as the Golden Master
/// (`tools/golden-master-verify/capture-gm.mjs`), for `compare.mjs` to set side by side.
///
///   flutter test test/golden_master/capture_test.dart --tags golden-master
///   env: GMV_OUT (default ../../../build/golden-master), GMV_PROFILES (comma list)
///
/// Real fonts (the same Cormorant Garamond / Jost the Golden Master embeds) are loaded, so text is
/// drawn as it is on a device, not in the test font. Onboarding is captured as a production build
/// would show it (no simulator, no Demo); the app surfaces need the simulated residence, so they
/// carry the DEMO banner a simulation build always shows.
final _cfg = jsonDecode(
        File('../../../tools/golden-master-verify/profiles.json').readAsStringSync())
    as Map<String, dynamic>;
final _out = Directory(
    Platform.environment['GMV_OUT'] ?? '../../../build/golden-master');

Future<void> _loadFonts() async {
  const root = '../shared_ui/assets/fonts';
  ByteData bytes(String f) =>
      ByteData.sublistView(File('$root/$f').readAsBytesSync());
  final serif = FontLoader('packages/supreme_os_ui/SOSSerif')
    ..addFont(Future.value(bytes('CormorantGaramond-Light.ttf')));
  final sans = FontLoader('packages/supreme_os_ui/SOSSans')
    ..addFont(Future.value(bytes('Jost-Light.ttf')))
    ..addFont(Future.value(bytes('Jost-Regular.ttf')));
  await serif.load();
  await sans.load();
}

class _Profile {
  final String name;
  final Size logical;
  final double dpr;
  _Profile(this.name, Map<String, dynamic> j)
      : logical = Size((j['width'] as num).toDouble(), (j['height'] as num).toDouble()),
        dpr = (j['dpr'] as num).toDouble();
}

List<_Profile> get _profiles {
  // Runs only when the verification asks for it (tools/golden-master-verify/run.ps1 sets GMV_OUT).
  if (Platform.environment['GMV_OUT'] == null) return const [];
  final all = (_cfg['profiles'] as Map<String, dynamic>)
      .entries
      .map((e) => _Profile(e.key, e.value as Map<String, dynamic>))
      .toList();
  final want = Platform.environment['GMV_PROFILES']?.split(',');
  // The installed room panel is the touch panel app (`apps/new/touchpanel`), captured there; the
  // personal-device app is never an installed panel.
  return all
      .where((p) => p.name != 'room-panel' && (want == null || want.contains(p.name)))
      .toList();
}

Future<void> _snap(WidgetTester tester, GlobalKey key, _Profile p, String name,
    {bool probe = true}) async {
  if (probe) {
    writeProbe('${_out.path}/flutter/${p.name}/$name.json', probeRuns(tester, p.logical));
  }
  await tester.runAsync(() async {
    final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: p.dpr);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final f = File('${_out.path}/flutter/${p.name}/$name.png')
      ..createSync(recursive: true);
    f.writeAsBytesSync(data!.buffer.asUint8List());
  });
  stdout.writeln('  ✓ flutter/${p.name}/$name.png');
}

void _view(WidgetTester tester, _Profile p) {
  tester.view.physicalSize = p.logical * p.dpr;
  tester.view.devicePixelRatio = p.dpr;
  addTearDown(tester.view.reset);
}

class _FakeDiscovery implements HubDiscovery {
  final List<DiscoveredHub> hubs;
  _FakeDiscovery(this.hubs);
  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async =>
      hubs.isEmpty ? null : hubs.first.controlUri;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs;
}

final _hub = DiscoveredHub(
    identity: const HubIdentity(hubId: 'hub-1', displayName: 'SupremeOS Hub'),
    address: '192.168.0.10');

void main() {
  setUpAll(_loadFonts);

  // ── boot: Presence frames, stepped exactly as the original's virtual clock is ─────────────
  for (final p in _profiles) {
    testWidgets('boot · ${p.name}', (tester) async {
      _view(tester, p);
      final boot = _cfg['boot'] as Map<String, dynamic>;
      final step = (boot['stepMs'] as num).toDouble();
      final answerAt = (boot['hubAnswerMs'] as num).toDouble();
      final clock = PresenceClock();
      var now = 0.0;
      var answered = false;
      final key = GlobalKey();
      for (final t in (boot['frames'] as List).cast<num>().map((n) => n.toDouble())) {
        while (now < t) {
          now += step;
          if (!answered && now >= answerAt) {
            clock.hubResponded(); // the original's timer fires before its frame callback
            answered = true;
          }
          clock.tick(step);
        }
        await tester.pumpWidget(Directionality(
          textDirection: TextDirection.ltr,
          child: RepaintBoundary(
            key: key,
            child: CustomPaint(
              size: p.logical,
              painter: PresencePainter(t: clock.t, timeline: clock.timeline.copy()),
            ),
          ),
        ));
        await _snap(tester, key, p, 'boot-${t.toInt().toString().padLeft(5, '0')}', probe: false);
      }
    });
  }

  // ── onboarding: as a production build shows it ────────────────────────────────────────────
  for (final p in _profiles) {
    testWidgets('onboarding · ${p.name}', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      SharedPreferences.setMockInitialValues({});
      _view(tester, p);
      final key = GlobalKey();

      Future<ProviderContainer> pump(List<DiscoveredHub> hubs) async {
        final c = ProviderContainer(overrides: [
          platformDiscoveryProvider.overrideWithValue(_FakeDiscovery(hubs)),
          pairHomeProvider.overrideWithValue((code) async => const PairHomeResult(
              hubId: 'hub-1', projectId: 'proj-1', suggestedDisplayName: 'SupremeOS Hub')),
          pushTokenSourceProvider.overrideWithValue(null),
          mobileRuntimePlatformProvider.overrideWithValue(NoOpMobileRuntimePlatform()),
          networkChangeListenerProvider.overrideWith((ref) {}),
          pairedHomeAuthStoreProvider
              .overrideWithValue(InMemoryPairedHomeAuthorizationStore()),
          placeLookupProvider.overrideWithValue((q) async =>
              const Place(label: 'Palma, Spain', lat: 39.57, lon: 2.65, timeZone: 'Europe/Madrid')),
          homeLocationWriterProvider.overrideWithValue((h, p) async {}),
        ]);
        addTearDown(c.dispose);
        await tester.pumpWidget(UncontrolledProviderScope(
            container: c,
            child: RepaintBoundary(key: key, child: const SupremeMobileApp())));
        for (var i = 0; i < 4; i++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
          await tester.pump(const Duration(milliseconds: 100));
        }
        await tester.pump(const Duration(milliseconds: 700));
        await tester.pump(const Duration(milliseconds: 200));
        return c;
      }

      Future<void> tap(String text) async {
        final f = find.text(text);
        await tester.ensureVisible(f);
        await tester.pump();
        await tester.tap(f);
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 300));
      }

      await pump([_hub]);
      await _snap(tester, key, p, 'onboarding-page-1');
      await tap('Sign in');
      await _snap(tester, key, p, 'onboarding-signin');
      await tap('BACK');
      await tap('BEGIN');
      await _snap(tester, key, p, 'onboarding-identity');
      await tester.enterText(find.byType(TextField).first, 'Villa Son Vida');
      await tester.enterText(find.byType(TextField).last, 'Palma, Spain');
      await tester.pump();
      await tap('CONTINUE');
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await tap('SIGN IN');
      await tester.pump(const Duration(milliseconds: 500));
      await _snap(tester, key, p, 'onboarding-ready');

      await tester.pumpWidget(const SizedBox());
      SharedPreferences.setMockInitialValues({}); // no Home from the flow above
      await pump(const []);
      await _snap(tester, key, p, 'onboarding-not-found');
    });
  }

  // ── the app surfaces, on the simulated residence at the residence's local hour ─────────
  for (final p in _profiles) {
    testWidgets('app · ${p.name}', (tester) async {
      final key = GlobalKey();
      final hour = ((_cfg['residence'] as Map)['hour'] as num).toInt();
      final spaceName = (_cfg['residence'] as Map)['spaceName'] as String;
      final app = SimApp(hour: hour, boundaryKey: key);
      // The Golden Master's photographs, served on the Hub's picture route as a real Hub's would be.
      applySimulationPhotography(app.sim, _photographs());
      await app.pump(tester, logical: p.logical, dpr: p.dpr);

      // Time to settle, and for pictures to arrive and decode (real async work) and the tone
      // grade (1100 ms) to ease.
      Future<void> settle([int ms = 700]) async {
        await app.settle(tester, ms);
        for (var i = 0; i < 3; i++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
          await tester.pump(const Duration(milliseconds: 400));
        }
        await tester.pump(const Duration(milliseconds: 1200));
      }

      Future<void> tab(String label) async {
        await tester.tap(find.text(label).first);
        await settle();
      }

      final failed = <String>[];
      Future<void> surface(String name, Future<void> Function() go) async {
        try {
          await go();
          await _snap(tester, key, p, name);
        } catch (e) {
          final why = e.toString().split('\n').first;
          failed.add('$name: $why');
          stdout.writeln('  ✗ ${p.name}/$name — $why');
        }
      }

      await settle();
      await surface('home', () async {});
      await surface('spaces', () => tab('Spaces'));
      await surface('space', () async {
        await tester.ensureVisible(find.text(spaceName).first);
        await tester.pump();
        await tester.tap(find.text(spaceName).first);
        await settle();
      });
      await surface('experiences', () => tab('Experiences'));
      await surface('settings', () => tab('Settings'));
      await surface('control', () async {
        await tab('Home');
        await app.openControl(tester);
        await settle(300);
      });
      await surface('devices', () async {
        final devices = find.text('Devices');
        if (devices.evaluate().isEmpty) {
          await tester.scrollUntilVisible(devices, 250,
              scrollable: find.byType(Scrollable).last, maxScrolls: 30);
        }
        await tester.ensureVisible(devices.first);
        await tester.pump();
        await tester.tap(devices.first);
        await settle();
      });
      await surface('device-sheet', () async {
        final row = find.textContaining('lights');
        if (row.evaluate().isEmpty) {
          await tester.scrollUntilVisible(row, 250,
              scrollable: find.byType(Scrollable).last, maxScrolls: 30);
        }
        await tester.ensureVisible(row.first);
        await tester.pump();
        await tester.tap(row.first);
        await settle(900);
      });
      expect(failed, isEmpty, reason: 'surfaces that could not be reached: $failed');
    });
  }
}

/// The photographs from the repository's assets (the app loads the same files from its bundle).
SimulationPhotographs _photographs() => {
      for (final e in simulationPhotographFiles.entries)
        e.key: File('assets/golden_master/photography/${e.value}.jpg').readAsBytesSync(),
    };
