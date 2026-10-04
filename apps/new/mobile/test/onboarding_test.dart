import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
// ignore: implementation_imports
import 'package:supreme_os_core/src/connection/mdns_hub_discovery.dart';
import 'package:supreme_mobile_next/data/home_location.dart';
import 'package:supreme_mobile_next/features/onboarding/simulation_banner.dart';
import 'package:supreme_mobile_next/features/settings/home_settings_screen.dart'
    show PairHomeResult;
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'support/sim_app.dart';

/// First-run arrival (Golden Master onboarding) and the Demo entry. These tests prove the Demo
/// cannot exist outside a simulation build, that it is unmistakably marked, that Sign in is the
/// existing pairing flow, and that no account/passkey/backend model was invented.
///
/// The flow plays Presence first; these tests run it under the OS's reduced-motion setting (the
/// engine's own settled path), so Welcome opens ~600 ms after the Hub answers. The choreography
/// itself is covered by `presence_engine_test.dart`.
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

/// Holds hub detection open until the test lets it answer.
class _GatedDiscovery implements HubDiscovery {
  final Future<List<DiscoveredHub>> answer;
  _GatedDiscovery(this.answer);
  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      (await answer).firstOrNull?.controlUri;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) =>
      answer;
}

DiscoveredHub _hub() => DiscoveredHub(
    identity: const HubIdentity(hubId: 'hub-1', displayName: 'SupremeOS Hub'),
    address: '192.168.0.10');

PairHomeResult _paired() => const PairHomeResult(
    hubId: 'hub-1', projectId: 'proj-1', suggestedDisplayName: 'SupremeOS Hub');

/// The place search, answered without a network; records what the residence was told.
const _palma = Place(label: 'Palma, Spain', lat: 39.57, lon: 2.65, timeZone: 'Europe/Madrid');
final _savedLocations = <String>[];

Override get _lookup => placeLookupProvider.overrideWithValue((q) async => q.toLowerCase().contains('nowhere') ? null : _palma);
Override get _writer => homeLocationWriterProvider
    .overrideWithValue((hubId, place) async => _savedLocations.add('$hubId ${place.label}'));

/// Fills the residence step (name and location) as a person would, then Continue.
Future<void> _fillIdentity(WidgetTester tester, {String name = 'Villa Son Vida', String place = 'Palma, Spain'}) async {
  await tester.enterText(find.byType(TextField).first, name);
  await tester.enterText(find.byType(TextField).last, place);
  await tester.pump();
}

// Page 1, as the Golden Master words it.
const _meta = 'YOUR SUPREMEOS HUB IS HERE, ON THIS NETWORK.';
const _h1 = 'Your residence\nis here.';

/// Lets the paired-Home store, discovery and a few frames land without waiting on wall-clock timers.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// The OS asks for reduced motion: Presence shows its settled mark and Welcome opens ~600 ms after
/// the Hub has answered.
void _reduceMotion(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

/// A normal (non-simulation) build: no `simulatedResidenceProvider` override, so the compile-time
/// flag — absent in `flutter test` — decides, exactly as in a production APK.
Future<ProviderContainer> _pumpProduction(WidgetTester tester,
    {List<DiscoveredHub>? hubs, List<Override> extra = const []}) async {
  _reduceMotion(tester);
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(overrides: [
    platformDiscoveryProvider
        .overrideWithValue(_FakeDiscovery(hubs ?? [_hub()])),
    pushTokenSourceProvider.overrideWithValue(null),
    mobileRuntimePlatformProvider
        .overrideWithValue(NoOpMobileRuntimePlatform()),
    networkChangeListenerProvider.overrideWith((ref) {}),
    _lookup,
    _writer,
    ...extra,
  ]);
  addTearDown(container.dispose);
  addTearDown(() async => tester.pumpWidget(const SizedBox()));
  await tester.pumpWidget(UncontrolledProviderScope(
      container: container, child: const SupremeMobileApp()));
  await _settle(tester);
  await tester.pump(const Duration(milliseconds: 700));
  await _settle(tester);
  return container;
}

Future<void> _tap(WidgetTester tester, String text, {bool last = false}) async {
  final f = last ? find.text(text).last : find.text(text);
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

final _accountWords =
    RegExp(r'passkey|password|e-?mail|account|username', caseSensitive: false);

void main() {
  group('1. a normal production configuration cannot enter the simulator', () {
    testWidgets('no Demo is offered and no banner is drawn', (tester) async {
      await _pumpProduction(tester);
      expect(find.text(_h1), findsOneWidget);
      expect(find.text(_meta), findsOneWidget);
      expect(find.text('DEMO MODE'), findsNothing);
      expect(find.text(simulationBannerText), findsNothing);
    });

    test(
        'the simulator does not exist without the compile-time flag, whatever the app state says',
        () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(simulatedResidenceProvider), isNull);
      container.read(demoEnteredProvider.notifier).state = true; // not a switch
      expect(container.read(simulatedResidenceProvider), isNull);
    });
  });

  group('the Hub is never shown by its raw mDNS instance', () {
    // A Hub that predates the `name` TXT key advertises the hubId as its instance label — exactly
    // the string the first phone test displayed. Built through the same function discovery uses.
    const uuid = '01a0c8d9-bbcc-732c-b074-b0633f21e73e';
    DiscoveredHub legacy(String id, String address) => hubFromAdvertisement(
        instanceName: '$id._supremeos._tcp.local',
        address: address,
        port: 7272,
        txt: parseHubTxt(['hubId=$id']));

    void expectNoRaw(WidgetTester tester) {
      expect(find.textContaining(uuid), findsNothing);
      expect(find.textContaining('_supremeos'), findsNothing);
      expect(find.textContaining('.local'), findsNothing);
      for (final t in tester.widgetList<Text>(find.byType(Text))) {
        expect(t.data ?? '', isNot(contains(uuid)));
      }
    }

    testWidgets('page 1 reads as the Golden Master does, with no UUID or service string',
        (tester) async {
      await _pumpProduction(tester, hubs: [legacy(uuid, '192.168.0.20')]);
      expect(find.text(_meta), findsOneWidget);
      expectNoRaw(tester);
    });

    testWidgets('the residence-name step does not leak it either', (tester) async {
      await _pumpProduction(tester, hubs: [legacy(uuid, '192.168.0.20')]);
      await _tap(tester, 'BEGIN');
      expect(find.text('Give this residence an identity.'), findsOneWidget);
      expectNoRaw(tester);
    });

    testWidgets('two Hubs on the LAN do not change what is shown', (tester) async {
      final hubs = disambiguateHubNames([
        legacy(uuid, '192.168.0.20'),
        legacy('77ff0011-aaaa-4bcd-8000-000000000000', '192.168.0.21'),
      ]);
      expect(hubs.map((h) => h.identity.displayName).toSet(), hasLength(2));
      await _pumpProduction(tester, hubs: hubs);
      expect(find.text(_meta), findsOneWidget);
      expectNoRaw(tester);
    });
  });

  group('2. a simulation build exposes Demo', () {
    testWidgets('on onboarding page 1, below its actions, as a plain button',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      expect(find.text(_h1), findsOneWidget);
      expect(find.text('DEMO MODE'), findsOneWidget);
      // Just a button — no panel, no caption.
      expect(find.textContaining('Nothing here is real'), findsNothing);
      // Below the page's own actions, and reachable by scrolling (page 1 scrolls on a phone).
      final alt = tester.getTopLeft(find.text('Already known here? ')).dy;
      expect(tester.getTopLeft(find.text('DEMO MODE')).dy, greaterThan(alt));
      await tester.ensureVisible(find.text('DEMO MODE'));
      await tester.pump();
      expect(tester.getBottomLeft(find.text('DEMO MODE')).dy, lessThan(844));
    });

    testWidgets('and on its "not found yet" variant, so Demo stays reachable on a LAN with no Hub',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery(const [])),
      ]);
      await app.pump(tester);
      expect(find.text('We haven’t found it yet.'), findsOneWidget);
      expect(find.text('DEMO MODE'), findsOneWidget);
    });

    testWidgets(
        'and on no other onboarding page: detection, identity, sign-in, ready',
        (tester) async {
      final gate = Completer<List<DiscoveredHub>>();
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_GatedDiscovery(gate.future)),
        pairHomeProvider.overrideWithValue((code) async => _paired()),
        _lookup,
        _writer,
      ]);
      await app.pump(tester);

      // Hub detection: Presence is on, the search is still out. No page, no Demo.
      expect(find.text('DEMO MODE'), findsNothing);
      expect(find.text(_h1), findsNothing);
      expect(find.textContaining('Nothing here is real'), findsNothing);

      gate.complete([_hub()]);
      await app.settle(tester);
      await tester.pump(const Duration(milliseconds: 700));
      await app.settle(tester);
      expect(find.text('DEMO MODE'), findsOneWidget); // page 1

      // Residence identity.
      await tester.ensureVisible(find.text('BEGIN'));
      await tester.pump();
      await tester.tap(find.text('BEGIN'));
      await app.settle(tester);
      expect(find.text('Give this residence an identity.'), findsOneWidget);
      expect(find.text('DEMO MODE'), findsNothing);

      // Sign in (reached from identity, and from page 1's "Sign in" link).
      await _fillIdentity(tester);
      await tester.ensureVisible(find.text('CONTINUE'));
      await tester.pump();
      await tester.tap(find.text('CONTINUE'));
      await app.settle(tester);
      expect(find.text('Sign in to your residence.'), findsOneWidget);
      expect(find.text('DEMO MODE'), findsNothing);
      expect(find.textContaining('Nothing here is real'), findsNothing);

      // Ready.
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await tester.ensureVisible(find.text('SIGN IN'));
      await tester.pump();
      await tester.tap(find.text('SIGN IN'));
      await app.settle(tester, 300);
      expect(find.text('Villa Son Vida is yours.'), findsOneWidget);
      expect(find.text('DEMO MODE'), findsNothing);
      // Demo is not active, so neither is its indicator.
      expect(find.text(simulationBannerText), findsNothing);
    });

    testWidgets('and not on the Sign in page reached straight from page 1',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      await tester.ensureVisible(find.text('Sign in'));
      await tester.pump();
      await tester.tap(find.text('Sign in'));
      await app.settle(tester);
      expect(find.text('Sign in to your residence.'), findsOneWidget);
      expect(find.text('DEMO MODE'), findsNothing);
    });
  });

  group('3. Demo enters the transport-boundary simulator', () {
    testWidgets(
        'the shell opens on the simulated residence, and no Home is paired',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
        pairHomeProvider.overrideWithValue(
            (code) async => fail('Demo must never go through pairing')),
      ]);
      await app.pump(tester);
      await tester.ensureVisible(find.text('DEMO MODE'));
      await tester.pump();
      await tester.tap(find.text('DEMO MODE'));
      await app.settle(tester, 400);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Everything is settled.'),
          findsOneWidget); // the simulator's residence
      expect(find.text('Settings'), findsOneWidget); // the shell's navigation
      expect(find.text('Sign in to your residence.'), findsNothing);
    });
  });

  group('4. Demo is visibly marked throughout the application — and only while it is active', () {
    testWidgets('on arrival, Home, another tab, and a pushed layer',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      expect(find.text(simulationBannerText), findsNothing); // arrival: Demo is not active yet
      await tester.ensureVisible(find.text('DEMO MODE'));
      await tester.pump();
      await tester.tap(find.text('DEMO MODE'));
      await app.settle(tester, 400);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text(simulationBannerText), findsOneWidget); // Home

      await tester.tap(find.text('Settings'));
      await app.settle(tester, 300);
      expect(find.text(simulationBannerText), findsOneWidget); // another tab

      await app.openControl(tester);
      expect(
          find.text(simulationBannerText), findsOneWidget); // the Control layer
    });

    testWidgets('and it is announced to assistive technology', (tester) async {
      final handle = tester.ensureSemantics();
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      final label = RegExp('simulated residence, not your home');
      expect(find.bySemanticsLabel(label), findsNothing); // not before Demo
      await tester.ensureVisible(find.text('DEMO MODE'));
      await tester.pump();
      await tester.tap(find.text('DEMO MODE'));
      await app.settle(tester, 400);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.bySemanticsLabel(label), findsOneWidget);
      handle.dispose();
    });
  });

  group('5. Sign in routes to the existing pairing flow', () {
    testWidgets('the pairing code is handed to pairHomeProvider',
        (tester) async {
      final codes = <String>[];
      await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async {
          codes.add(code);
          return _paired();
        }),
      ]);
      await _tap(tester, 'Sign in'); // page 1's "Already known here? Sign in"
      await tester.enterText(find.byType(TextField), 'ABC-123');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expect(codes, ['ABC-123']);
      expect(find.text('Your residence knows you.'), findsOneWidget);
    });

    test('by default that seam is realPairHome, not a second sign-in',
        () async {
      final container = ProviderContainer(overrides: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery(const [])),
        mobileIdentityProvider.overrideWithValue(
            Ed25519MobileIdentity(InMemorySecretBytesStore())),
        pairedHomeAuthStoreProvider
            .overrideWithValue(InMemoryPairedHomeAuthorizationStore()),
      ]);
      addTearDown(container.dispose);
      // realPairHome's own first step: discovery found no Hub on this network.
      await expectLater(
          container.read(pairHomeProvider)('123456'),
          throwsA(isA<StateError>().having((e) => e.message, 'message',
              contains('No SupremeOS Hub was found'))));
    });

    testWidgets(
        'a failed pairing says so, keeps the code screen, and creates no Home',
        (tester) async {
      final container = await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async =>
            throw StateError('No SupremeOS Hub was found on this network.')),
      ]);
      await _tap(tester, 'Sign in');
      await tester.enterText(find.byType(TextField), 'WRONG');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expect(find.text('No SupremeOS Hub was found on this network.'),
          findsOneWidget);
      expect(find.text('Sign in to your residence.'), findsOneWidget);
      expect(container.read(pairedHomeControllerProvider).homes, isEmpty);
    });

    testWidgets('an unexpected error never reaches the screen as raw text',
        (tester) async {
      await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async =>
            throw const FormatException('secret internal detail 0xDEADBEEF')),
      ]);
      await _tap(tester, 'Sign in');
      await tester.enterText(find.byType(TextField), 'X1');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expect(find.textContaining('0xDEADBEEF'), findsNothing);
      expect(find.textContaining('Check the pairing code'), findsOneWidget);
    });
  });

  group('6. the residence identity is written to the existing residence model',
      () {
    testWidgets(
        'PairedHome.displayName, with the Hub-issued hubId and projectId',
        (tester) async {
      final container = await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async => _paired()),
      ]);
      await _tap(tester, 'BEGIN');
      expect(find.text('Give this residence an identity.'), findsOneWidget);
      // The Golden Master's field starts empty, with a placeholder.
      for (final f in tester.widgetList<TextField>(find.byType(TextField))) {
        expect(f.controller!.text, isEmpty); // name and location both start empty
      }
      expect(find.text('City, country'), findsOneWidget);
      expect(find.text('e.g. Villa Son Vida'), findsOneWidget);
      await _fillIdentity(tester);
      await _tap(tester, 'CONTINUE');
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await _tap(tester, 'SIGN IN');

      final homes = container.read(pairedHomeControllerProvider).homes;
      expect(homes, hasLength(1));
      expect(homes.single.displayName, 'Villa Son Vida'); // the name typed here
      expect(
          homes.single.hubId, 'hub-1'); // from the Hub's response, never typed
      expect(homes.single.projectId, 'proj-1');
      expect(find.text('Villa Son Vida is yours.'), findsOneWidget);
    });

    testWidgets('an empty name is refused with the Golden Master\'s words',
        (tester) async {
      await _pumpProduction(tester);
      await _tap(tester, 'BEGIN');
      await _tap(tester, 'CONTINUE');
      expect(find.text('Please give your residence a name.'), findsOneWidget);
      expect(find.text('Please enter the location.'), findsOneWidget);
      expect(find.text('Give this residence an identity.'), findsOneWidget);
    });

    testWidgets('a place that is not found is said so, and nothing moves on', (tester) async {
      await _pumpProduction(tester);
      await _tap(tester, 'BEGIN');
      await _fillIdentity(tester, place: 'Nowhere');
      await _tap(tester, 'CONTINUE');
      expect(find.textContaining('couldn’t find that place'), findsOneWidget);
      expect(find.text('Give this residence an identity.'), findsOneWidget);
    });

    testWidgets('the location is saved on the Hub the residence is paired with', (tester) async {
      _savedLocations.clear();
      await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async => _paired()),
      ]);
      await _tap(tester, 'BEGIN');
      await _fillIdentity(tester);
      await _tap(tester, 'CONTINUE');
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expect(_savedLocations, ['hub-1 Palma, Spain']);
      expect(find.textContaining('couldn’t be saved'), findsNothing);
    });

    testWidgets('if the Hub cannot take it, the person is told — not left to find out', (tester) async {
      await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async => _paired()),
        homeLocationWriterProvider.overrideWithValue((h, p) async => throw StateError('hub unreachable')),
      ]);
      await _tap(tester, 'BEGIN');
      await _fillIdentity(tester);
      await _tap(tester, 'CONTINUE');
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expect(find.textContaining('couldn’t be saved to the Hub'), findsOneWidget);
      expect(find.text('Villa Son Vida is yours.'), findsOneWidget); // still gets in
    });

    testWidgets('the already-known path asks for no location', (tester) async {
      await _pumpProduction(tester);
      await _tap(tester, 'Sign in');
      expect(find.text('LOCATION'), findsNothing);
    });
  });

  group('7. no fake account, passkey or backend model is introduced', () {
    testWidgets('no step draws an account, password, e-mail or passkey control',
        (tester) async {
      await _pumpProduction(tester, extra: [
        pairHomeProvider.overrideWithValue((code) async => _paired()),
      ]);
      void expectNone() {
        for (final t in tester.widgetList<Text>(find.byType(Text))) {
          expect(t.data ?? '', isNot(matches(_accountWords)),
              reason: 'drew "${t.data}"');
        }
      }

      expectNone(); // hub found
      await _tap(tester, 'BEGIN');
      expectNone(); // identity
      await _fillIdentity(tester, name: 'Villa');
      await _tap(tester, 'CONTINUE');
      expectNone(); // sign in
      await tester.enterText(find.byType(TextField), 'C1');
      await tester.pump();
      await _tap(tester, 'SIGN IN');
      expectNone(); // ready
    });

    testWidgets('the no-Hub screen keeps its manual IP/port form folded away until asked for',
        (tester) async {
      await _pumpProduction(tester, hubs: const []);
      expect(find.text('We haven’t found it yet.'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.text('OR CONNECT MANUALLY'), findsOneWidget);
    });

    test('the onboarding source adds no HTTP, auth or account model of its own',
        () {
      final forbidden = RegExp(
          r"package:http|HttpClient|WebAuthn|Passkey|OAuth|FirebaseAuth|class \w*(Account|Credential|Session)\b");
      final files = Directory('lib/features/onboarding')
          .listSync()
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'))
          .toList();
      expect(files, isNotEmpty);
      for (final f in files) {
        final code = f
            .readAsLinesSync()
            .where((l) => !l.trimLeft().startsWith('//'))
            .join('\n');
        expect(forbidden.hasMatch(code), isFalse,
            reason: '${f.path} introduces a new auth/backend model');
      }
    });
  });
}
