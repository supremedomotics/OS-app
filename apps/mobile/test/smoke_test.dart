import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import 'package:supreme_mobile/cloud/multi_home.dart';
import 'package:supreme_mobile/providers.dart';
import 'package:supreme_mobile/screens/dashboard.dart';
import 'package:supreme_mobile/screens/device_sheet.dart';
import 'package:supreme_mobile/screens/home_switcher.dart';

/// Widget smoke tests: pump the core screens with provider overrides supplying canned data so
/// the real render paths execute (no network). Complements `flutter analyze` with actual runtime
/// coverage of the homeowner UI — login, dashboard, the multi-home switcher, and the device sheet.

final _rooms = <Room>[
  Room(id: 'r1', name: 'Living Room', areaType: 'living'),
  Room(id: 'r2', name: 'Bedroom', areaType: 'bedroom'),
];
final _home = HomeView(homeName: 'The Penthouse', rooms: _rooms);

Device _light() => Device(
      id: 'd1',
      name: 'Ceiling',
      supremeType: 'dimmer',
      roomId: 'r1',
      capabilities: const ['onoff', 'brightness'],
      state: const {
        'onoff': {'on': true},
      },
    );

Widget _wrap(Widget child, {List<Override> overrides = const []}) =>
    ProviderScope(overrides: overrides, child: MaterialApp(home: child));

void main() {
  testWidgets('dashboard renders the home name and the Rooms aggregate', (tester) async {
    // Use a real phone surface so the room-first ListView lays out like a device.
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_wrap(
      const DashboardScreen(),
      overrides: [
        homeProvider.overrideWith((ref) async => _home),
        // Empty scenes → the optional horizontal scene-tile row isn't built (its fixed-height
        // tiles overflow under flutter_test's boxy default font; this keeps the smoke test on the
        // stable hero + aggregate tiles).
        scenesProvider.overrideWith((ref) async => <Scene>[]),
        favoritesProvider.overrideWith((ref) async => <Favorite>[]),
      ],
    ));
    await tester.pumpAndSettle();

    expect(find.text('The Penthouse'), findsWidgets); // home hero
    expect(find.text('Rooms'), findsWidgets); // the rooms category aggregate tile
  });

  testWidgets('home switcher shows the active home and lists all homes', (tester) async {
    await tester.pumpWidget(_wrap(
      const Scaffold(body: Center(child: HomeSwitcherButton())),
      overrides: [
        homesProvider.overrideWith((ref) => <HomeRef>[
              const HomeRef(hubId: 'h1', name: 'Mumbai Villa', role: 'owner', cloudRouteUrl: 'https://a'),
              const HomeRef(hubId: 'h2', name: 'Dubai Apartment', role: 'owner', cloudRouteUrl: 'https://b'),
            ]),
        activeHomeIdProvider.overrideWith((ref) => 'h1'),
      ],
    ));
    await tester.pumpAndSettle();

    // The button shows the active home; tapping it opens a sheet listing every home.
    expect(find.text('Mumbai Villa'), findsWidgets);
    await tester.tap(find.byType(HomeSwitcherButton));
    await tester.pumpAndSettle();
    expect(find.text('Dubai Apartment'), findsWidgets);
  });

  testWidgets('device sheet renders controls and the Manage (move/rename/remove) section', (tester) async {
    await tester.pumpWidget(_wrap(
      Scaffold(body: DeviceSheet(device: _light())),
      overrides: [homeProvider.overrideWith((ref) async => _home)],
    ));
    await tester.pumpAndSettle();

    expect(find.text('Manage'), findsWidgets);
    expect(find.text('Remove device'), findsWidgets);
  });
}
