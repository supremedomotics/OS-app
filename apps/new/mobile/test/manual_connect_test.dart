import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_mobile_next/data/manual_hub_store.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_mobile_next/runtime/noop_runtime_platform.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

class _None implements HubDiscovery {
  int searches = 0;
  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async => null;
  @override
  Future<List<DiscoveredHub>> discoverAllLan({Duration timeout = const Duration(seconds: 3)}) async {
    searches++;
    return const [];
  }
}

void main() {
  test('the original\'s validation words, for IP and port', () {
    expect(validateHubIp(''), 'Please enter your residence’s IP address.');
    expect(validateHubIp('192.168.1'), 'Use four numbers from 0 to 255, e.g. 192.168.1.20.');
    expect(validateHubIp('192.168.1.256'), startsWith('Use four numbers'));
    expect(validateHubIp('192.168.01.5'), startsWith('Use four numbers'));
    expect(validateHubIp('192.168.1.0'), 'That’s a network address, not a device. Check the last number.');
    expect(validateHubIp('192.168.1.255'), startsWith('That’s a network address'));
    expect(validateHubIp(' 192.168.0.105 '), isNull);
    expect(validateHubPort('7272'), isNull);
    expect(validateHubPort('0'), 'Use a port number from 1 to 65535.');
    expect(validateHubPort('70000'), 'Use a port number from 1 to 65535.');
    expect(validateHubPort('abc'), 'Use a port number from 1 to 65535.');
  });

  test('a manual Hub is listed only while it answers, once, and keeps its identity', () async {
    SharedPreferences.setMockInitialValues({});
    final store = ManualHubStore();
    await store.add('192.168.0.105', 7272);
    var up = true;
    final d = ManualAwareDiscovery(inner: _None(), store: store, probe: (h, p) async => up);
    expect((await d.discoverAllLan()).single.address, '192.168.0.105');
    await store.bindHubId('192.168.0.105', 7272, 'hub-real');
    expect((await d.discoverAllLan()).single.identity.hubId, 'hub-real');
    up = false;
    expect(await d.discoverAllLan(), isEmpty);
  });

  Future<(ProviderContainer, _None)> pump(WidgetTester tester, Future<bool> Function(String, int) probe) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(390, 1400) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final none = _None();
    final c = ProviderContainer(overrides: [
      platformDiscoveryProvider.overrideWithValue(none),
      hubProbeProvider.overrideWithValue(probe),
      pushTokenSourceProvider.overrideWithValue(null),
      mobileRuntimePlatformProvider.overrideWithValue(NoOpMobileRuntimePlatform()),
      networkChangeListenerProvider.overrideWith((ref) {}),
    ]);
    addTearDown(c.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(container: c, child: const SupremeMobileApp()));
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pump(const Duration(milliseconds: 300));
    }
    await tester.pump(const Duration(milliseconds: 700));
    addTearDown(() async => tester.pumpWidget(const SizedBox()));
    return (c, none);
  }

  testWidgets('not found offers "or connect manually", and refuses a bad address in the original\'s words',
      (tester) async {
    await pump(tester, (h, p) async => true);
    expect(find.text('We haven’t found it yet.'), findsOneWidget);
    expect(find.text('IP address'.toUpperCase()), findsNothing); // folded away until asked for
    await tester.tap(find.text('OR CONNECT MANUALLY'));
    await tester.pump();
    expect(find.text('IP ADDRESS'), findsOneWidget);
    expect(find.text('PORT'), findsOneWidget);
    await tester.tap(find.text('CONNECT'));
    await tester.pump();
    expect(find.text('Please enter your residence’s IP address.'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, '192.168.0.300');
    await tester.tap(find.text('CONNECT'));
    await tester.pump();
    expect(find.text('Use four numbers from 0 to 255, e.g. 192.168.1.20.'), findsOneWidget);
  });

  testWidgets('a Hub that does not answer says so, and is not remembered', (tester) async {
    final (c, _) = await pump(tester, (h, p) async => false);
    await tester.tap(find.text('OR CONNECT MANUALLY'));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, '192.168.0.105');
    await tester.tap(find.text('CONNECT'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('didn’t respond at 192.168.0.105:7272'), findsOneWidget);
    expect(await c.read(manualHubStoreProvider).load(), isEmpty);
  });

  testWidgets('a Hub that answers is remembered and the search runs again', (tester) async {
    String? probed;
    final (c, none) = await pump(tester, (h, p) async {
      probed = '$h:$p';
      return true;
    });
    final before = none.searches;
    await tester.tap(find.text('OR CONNECT MANUALLY'));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, '192.168.0.105');
    await tester.tap(find.text('CONNECT'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump(const Duration(milliseconds: 300));
    expect(probed, '192.168.0.105:7272');
    expect((await c.read(manualHubStoreProvider).load()).single.host, '192.168.0.105');
    expect(none.searches, greaterThan(before));
  });
}
