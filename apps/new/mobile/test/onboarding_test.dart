import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
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
    identity: const HubIdentity(hubId: 'hub-1', displayName: 'Villa Test Hub'),
    address: '192.168.0.10');

PairHomeResult _paired() => const PairHomeResult(
    hubId: 'hub-1',
    projectId: 'proj-1',
    suggestedDisplayName: 'Villa Test Hub');

/// Lets the paired-Home store, discovery and a few frames land without waiting on wall-clock timers.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// A normal (non-simulation) build: no `simulatedResidenceProvider` override, so the compile-time
/// flag — absent in `flutter test` — decides, exactly as in a production APK.
Future<ProviderContainer> _pumpProduction(WidgetTester tester,
    {List<DiscoveredHub>? hubs, List<Override> extra = const []}) async {
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
    ...extra,
  ]);
  addTearDown(container.dispose);
  addTearDown(() async => tester.pumpWidget(const SizedBox()));
  await tester.pumpWidget(UncontrolledProviderScope(
      container: container, child: const SupremeMobileApp()));
  await _settle(tester);
  return container;
}

Future<void> _tap(WidgetTester tester, String text) async {
  await tester.tap(find.text(text));
  await _settle(tester);
}

final _accountWords =
    RegExp(r'passkey|password|e-?mail|account|username', caseSensitive: false);

void main() {
  group('1. a normal production configuration cannot enter the simulator', () {
    testWidgets('no Demo is offered and no banner is drawn', (tester) async {
      await _pumpProduction(tester);
      expect(find.text('Your SupremeOS Hub is here, on this network.'),
          findsOneWidget);
      expect(find.text('Demo mode'), findsNothing);
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

  group('2. a simulation build exposes Demo', () {
    testWidgets('on the arrival flow, below Sign in, with an honest caption',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      expect(find.text('Your SupremeOS Hub is here, on this network.'),
          findsOneWidget);
      expect(find.text('Demo mode'), findsOneWidget);
      expect(find.textContaining('Nothing here is real'), findsOneWidget);
      // Reachable without scrolling on a 390x844 phone.
      expect(tester.getBottomLeft(find.text('Demo mode')).dy, lessThan(844));

      // Still offered on the Sign in screen itself, below its Sign in button.
      await tester.tap(find.text('Already known here?'));
      await app.settle(tester);
      expect(find.text('Sign in to your residence.'), findsOneWidget);
      final signInY = tester.getTopLeft(find.text('Sign in').last).dy;
      final demoY = tester.getTopLeft(find.text('Demo mode')).dy;
      expect(demoY, greaterThan(signInY));
    });

    testWidgets('and when no Hub is found', (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery(const [])),
      ]);
      await app.pump(tester);
      expect(find.text('We haven’t found it yet.'), findsOneWidget);
      expect(find.text('Demo mode'), findsOneWidget);
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
      await tester.tap(find.text('Demo mode'));
      await app.settle(tester, 400);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Everything is settled.'),
          findsOneWidget); // the simulator's residence
      expect(find.text('Settings'), findsOneWidget); // the shell's navigation
      expect(find.text('Sign in to your residence.'), findsNothing);
    });
  });

  group('4. Demo is visibly marked throughout the application', () {
    testWidgets('on arrival, Home, another tab, and a pushed layer',
        (tester) async {
      final app = SimApp(pastArrival: false, extra: [
        platformDiscoveryProvider.overrideWithValue(_FakeDiscovery([_hub()])),
      ]);
      await app.pump(tester);
      expect(find.text(simulationBannerText), findsOneWidget); // arrival
      await tester.tap(find.text('Demo mode'));
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
      expect(
          find.bySemanticsLabel(RegExp('simulated residence, not your home')),
          findsOneWidget);
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
      await _tap(tester, 'Already known here?');
      await tester.enterText(find.byType(TextField), 'ABC-123');
      await tester.pump();
      await _tap(tester, 'Sign in');
      expect(codes, ['ABC-123']);
      expect(find.text('Your residence is ready.'), findsOneWidget);
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
      await _tap(tester, 'Already known here?');
      await tester.enterText(find.byType(TextField), 'WRONG');
      await tester.pump();
      await _tap(tester, 'Sign in');
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
      await _tap(tester, 'Already known here?');
      await tester.enterText(find.byType(TextField), 'X1');
      await tester.pump();
      await _tap(tester, 'Sign in');
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
      await _tap(tester, 'Begin');
      expect(find.text('Give this residence an identity.'), findsOneWidget);
      expect(find.text('Villa Test Hub'),
          findsOneWidget); // suggested from the Hub, editable
      await tester.enterText(find.byType(TextField), 'Villa Son Vida');
      await tester.pump();
      await _tap(tester, 'Continue');
      await tester.enterText(find.byType(TextField), 'CODE-9');
      await tester.pump();
      await _tap(tester, 'Sign in');

      final homes = container.read(pairedHomeControllerProvider).homes;
      expect(homes, hasLength(1));
      expect(homes.single.displayName, 'Villa Son Vida'); // the name typed here
      expect(
          homes.single.hubId, 'hub-1'); // from the Hub's response, never typed
      expect(homes.single.projectId, 'proj-1');
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
      await _tap(tester, 'Begin');
      expectNone(); // identity
      await _tap(tester, 'Continue');
      expectNone(); // sign in
      await tester.enterText(find.byType(TextField), 'C1');
      await tester.pump();
      await _tap(tester, 'Sign in');
      expectNone(); // ready
    });

    testWidgets('the no-Hub screen draws no manual IP/port path',
        (tester) async {
      await _pumpProduction(tester, hubs: const []);
      expect(find.text('We haven’t found it yet.'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(
          find.textContaining(
              RegExp('manual|IP address|Port', caseSensitive: false)),
          findsNothing);
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
