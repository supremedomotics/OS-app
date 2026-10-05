import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/main.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import 'support/sim_app.dart';

/// The Spaces screen tells four things apart, and never calls "not connected yet" an outage:
/// Loading ≠ empty ≠ unreachable ≠ the residence itself.

Override _residenceReading(Future<Map<String, dynamic>> Function(String path) get) =>
    residenceStateProvider.overrideWith((ref) {
      final state = ResidenceState(get: get, frames: const Stream.empty());
      unawaited(state.start());
      ref.onDispose(state.dispose);
      return state;
    });

Future<void> _openSpaces(WidgetTester tester, SimApp app) async {
  await app.pump(tester);
  await tester.tap(find.text('Spaces').last);
  await app.settle(tester);
}

const _loading = 'Loading your spaces…';
const _unreachable = 'Your residence isn’t reachable right now.';
const _empty = 'No Spaces yet';

void main() {
  testWidgets('the connection is not up yet: Loading, not "unreachable"', (tester) async {
    final app = SimApp(extra: [
      _residenceReading((p) async => throw HubNotConnectedException('connecting')),
    ]);
    await _openSpaces(tester, app);
    expect(find.text(_loading), findsOneWidget);
    expect(find.text(_unreachable), findsNothing);
    expect(find.text(_empty), findsNothing);
  });

  testWidgets('a genuine Hub failure is Unreachable, not Loading', (tester) async {
    final app = SimApp(extra: [
      _residenceReading((p) async => throw Exception('HTTP 500')),
    ]);
    await _openSpaces(tester, app);
    expect(find.text(_unreachable), findsOneWidget);
    expect(find.text(_loading), findsNothing);
  });

  testWidgets('a residence that loaded with no rooms says so — it is not Loading or unreachable',
      (tester) async {
    final app = SimApp(extra: [
      _residenceReading((p) async => switch (p) {
            'v1/home' => {
                'home': {'name': 'Test Home'},
                'rooms': <dynamic>[],
              },
            'v1/devices' => {'devices': <dynamic>[]},
            _ => {'scenes': <dynamic>[]},
          }),
    ]);
    await _openSpaces(tester, app);
    expect(find.text(_empty), findsOneWidget);
    expect(find.text(_loading), findsNothing);
    expect(find.text(_unreachable), findsNothing);
  });

  testWidgets('a loaded residence shows its Spaces, with no status message', (tester) async {
    final app = SimApp();
    await _openSpaces(tester, app);
    expect(find.text('Ground floor'), findsOneWidget);
    expect(find.text(_loading), findsNothing);
    expect(find.text(_unreachable), findsNothing);
    expect(find.text(_empty), findsNothing);
  });
}
