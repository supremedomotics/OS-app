import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/features/onboarding/simulation_banner.dart';
import 'package:supreme_mobile_next/features/settings/home_settings_screen.dart'
    show PairHomeResult;
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'support/sim_app.dart';

/// Exit Demo Mode: the one way out of the simulated residence. It ends the simulation and returns
/// to onboarding page 1 — without starting pairing, connecting to a Hub, or touching any real
/// paired Home — and it exists only in a simulation build.
class _FakeDiscovery implements HubDiscovery {
  final List<DiscoveredHub> hubs;
  _FakeDiscovery(this.hubs);
  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs.isEmpty ? null : hubs.first.controlUri;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs;
}

DiscoveredHub _hub() => DiscoveredHub(
    identity: const HubIdentity(hubId: 'hub-1', displayName: 'SupremeOS Hub'),
    address: '192.168.0.10');

const _page1 = 'Your residence\nis here.';

/// A Demo session whose simulator is recreated (and the old one disposed) on exit, as the real
/// provider does — `SimApp`'s default `overrideWithValue` would hide the teardown.
class _Session {
  final created = <SimulatedResidence>[];
  final disposed = <SimulatedResidence>[];
  final pairCalls = <String>[];
  late final SimApp app;

  _Session() {
    app = SimApp(reducedMotion: true, extra: [
      simulatedResidenceProvider.overrideWith((ref) {
        final sim = SimulatedResidence(
            schedule: app.clock.schedule, now: app.clock.now);
        created.add(sim);
        ref.onDispose(() {
          disposed.add(sim);
          sim.dispose();
        });
        return sim;
      }),
      platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      pairHomeProvider.overrideWithValue((code) async {
        pairCalls.add(code);
        return const PairHomeResult(hubId: 'x', projectId: 'y');
      }),
    ]);
  }

  ProviderContainer container(WidgetTester t) =>
      ProviderScope.containerOf(t.element(find.byType(SupremeMobileApp)));

  Future<void> openSettings(WidgetTester t) async {
    await t.tap(find.text('Settings').last);
    await app.settle(t);
  }

  /// Presses Exit Demo Mode; the arrival flow then plays Presence (settled, under reduced motion)
  /// and opens page 1.
  Future<void> exit(WidgetTester t) async {
    await t.tap(find.text('Exit Demo Mode'));
    await app.settle(t, 400);
    await t.pump(const Duration(milliseconds: 300));
    await app.arrive(t);
  }

  Future<void> demo(WidgetTester t) async {
    await t.ensureVisible(find.text('DEMO MODE'));
    await t.pump();
    await t.tap(find.text('DEMO MODE'));
    await app.settle(t, 400);
    await t.pump(const Duration(milliseconds: 300));
  }
}

void main() {
  testWidgets('Settings leads with Exit Demo Mode, above the rest of the page',
      (tester) async {
    final s = _Session();
    await s.app.pump(tester, logical: const Size(390, 1800));
    await s.openSettings(tester);
    expect(find.text('Exit Demo Mode'), findsOneWidget);
    expect(find.textContaining('Nothing here is real'), findsOneWidget);
    final exitY = tester.getTopLeft(find.text('Exit Demo Mode')).dy;
    expect(exitY, lessThan(tester.getTopLeft(find.text('Residence')).dy));
    expect(exitY, lessThan(tester.getTopLeft(find.text('Hubs')).dy));
    // Drawn as the Golden Master's consequential pill: 44 high, fully rounded, #e9c3b6 text.
    final pill = find.ancestor(
        of: find.text('Exit Demo Mode'), matching: find.byType(Container));
    final box = tester.getSize(pill.first);
    expect(box.height, 44);
    final text = tester.widget<Text>(find.text('Exit Demo Mode'));
    expect(text.style?.color, const Color(0xFFE9C3B6));
    expect(text.style?.fontSize, 14);
  });

  testWidgets('a build without the simulator has no Exit Demo Mode',
      (tester) async {
    final app = SimApp(extra: [
      simulatedResidenceProvider.overrideWithValue(null),
      platformDiscoveryProvider.overrideWithValue(_FakeDiscovery(const [])),
    ]);
    await app.pump(tester, logical: const Size(390, 1800));
    await tester.tap(find.text('Settings').last);
    await app.settle(tester);
    expect(find.byKey(const ValueKey('settings-page')), findsOneWidget);
    expect(find.text('Exit Demo Mode'), findsNothing);
    expect(find.byKey(const ValueKey('settings-demo-note')), findsNothing);
  });

  test('a simulation build is simulated only while Demo is active', () {
    final sim = SimulatedResidence();
    final c = ProviderContainer(overrides: [simulatedResidenceProvider.overrideWithValue(sim)]);
    addTearDown(c.dispose);
    expect(c.read(activeSimulationProvider), isNull); // before Demo: the real app, no indicator
    c.read(demoEnteredProvider.notifier).state = true;
    expect(c.read(activeSimulationProvider), same(sim));
    c.read(demoEnteredProvider.notifier).state = false; // Exit Demo Mode
    expect(c.read(activeSimulationProvider), isNull);
  });

  test('without a simulator the exit action does nothing at all', () {
    final c = ProviderContainer();
    addTearDown(c.dispose);
    c.read(demoEnteredProvider.notifier).state = true;
    c.read(exitDemoModeProvider)();
    expect(c.read(demoEnteredProvider), isTrue);
    expect(c.read(arrivalRequestedProvider), isFalse);
  });

  testWidgets('pressing it returns to onboarding page 1, with Demo offered again',
      (tester) async {
    final s = _Session();
    await s.app.pump(tester, logical: const Size(390, 1800));
    await s.openSettings(tester);
    await s.exit(tester);

    expect(find.text(_page1), findsOneWidget);
    expect(find.text('DEMO MODE'), findsOneWidget);
    expect(find.text('Exit Demo Mode'), findsNothing);
    expect(find.text('Everything is settled.'), findsNothing);
    // Demo is over: the indicator is gone with it (and the app is on real data again).
    expect(find.text(simulationBannerText), findsNothing);
  });

  testWidgets('it ends the simulated session, and the next Demo starts from a fresh residence',
      (tester) async {
    final s = _Session();
    await s.app.pump(tester, logical: const Size(390, 1800));
    final first = s.created.last;
    first.setReachability('dining-shade', 'offline'); // something the session did
    // Reachability is learned on the next snapshot read (the stream has no frame for it).
    s.container(tester).read(residenceStateProvider).refresh();
    await s.app.settle(tester, 1000);
    await s.openSettings(tester);
    expect(find.text('Connected · 1 not responding'), findsOneWidget);

    await s.exit(tester);
    expect(s.disposed, contains(first)); // ended
    expect(s.container(tester).read(demoEnteredProvider), isFalse);

    await s.demo(tester);
    expect(find.text('Everything is settled.'), findsOneWidget);
    expect(s.created.last, isNot(same(first))); // a new simulator
    await s.openSettings(tester);
    expect(find.text('Connected'), findsOneWidget); // not the old session's fault
    expect(s.container(tester).read(arrivalRequestedProvider), isFalse);
  });

  testWidgets(
      'it starts no pairing, and leaves a real paired Home exactly as it was',
      (tester) async {
    final s = _Session();
    await s.app.pump(tester, logical: const Size(390, 1800));
    final c = s.container(tester);
    await c.read(pairedHomeControllerProvider).addHome(
        hubId: 'real-hub', projectId: 'real-project', displayName: 'Real Home');
    await tester.pump();

    await s.openSettings(tester);
    await s.exit(tester);

    // Page 1 even though a Home is paired: the person asked to leave the simulation.
    expect(find.text(_page1), findsOneWidget);
    expect(s.pairCalls, isEmpty);
    final homes = c.read(pairedHomeControllerProvider).homes;
    expect(homes.map((h) => (h.hubId, h.projectId, h.displayName)),
        [('real-hub', 'real-project', 'Real Home')]);
    // Not partly simulated, partly real: no Demo is active.
    expect(c.read(demoEnteredProvider), isFalse);
  });

  testWidgets('a cold start is unaffected: the request lives in memory only',
      (tester) async {
    final s = _Session();
    await s.app.pump(tester, logical: const Size(390, 1800));
    await s.openSettings(tester);
    await s.exit(tester);
    expect(s.container(tester).read(arrivalRequestedProvider), isTrue);
    // A fresh process has fresh providers.
    final fresh = ProviderContainer();
    addTearDown(fresh.dispose);
    expect(fresh.read(arrivalRequestedProvider), isFalse);
  });
}
