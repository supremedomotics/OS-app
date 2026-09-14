import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';
import 'package:supreme_mobile_next/features/spaces/room_screen.dart';
import 'package:supreme_mobile_next/main.dart';

/// A `HomeStateRepository` whose `lighting()` throws the real
/// `AmbiguousDeviceResolutionException` `HubHomeStateRepository` throws for a room with two+
/// devices sharing a capability (§Phase12.9) — proving the UI (§Phase12.10 §14) converts it to
/// a safe, homeowner-facing state rather than a raw exception or an endless spinner.
class _AmbiguousLightingRepo implements HomeStateRepository {
  @override
  Stream<HubConnectionState> get connectionState => const Stream.empty();
  @override
  Future<List<Space>> spaces() async => const [];
  @override
  Future<List<Experience>> experiences() async => const [];
  @override
  Future<DomainState<LightingValue>?> lighting(String spaceId) async {
    throw const AmbiguousDeviceResolutionException(
        roomId: 'living-room',
        capabilityKind: 'onoff',
        deviceIds: ['dev-1', 'dev-2']);
  }

  @override
  Future<DomainState<ShadesValue>?> shades(String spaceId) async => null;
  @override
  Future<DomainState<ClimateValue>?> climate(String spaceId) async => null;
  @override
  Future<DomainState<AudioValue>?> audio(String spaceId) async => null;
  @override
  Future<void> setLighting(String spaceId, {bool? on, LightingMood? mood}) async {}
  @override
  Future<void> setShadesPosition(String spaceId, {required int percentOpen}) async {}
  @override
  Future<void> setClimate(String spaceId, {double? targetC, ClimateMode? mode}) async {}
  @override
  Future<void> setAudio(String spaceId, {bool? playing, int? volumePercent}) async {}
  @override
  Future<void> invokeExperience(String experienceId) async {}
  @override
  Future<void> dispose() async {}
}

void main() {
  testWidgets(
      'a room with an ambiguous lighting mapping shows a safe, homeowner-facing message — '
      'never the raw exception, never a device id (§Phase12.10 §14)', (tester) async {
    final space = Space(
        id: 'living-room', name: 'Living Room', domains: {HomeDomain.lighting});

    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          homeStateRepositoryProvider
              .overrideWithValue(_AmbiguousLightingRepo()),
        ],
        child: MaterialApp(
          home: AdaptiveScope(child: RoomScreen(space: space, onBack: () {})),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining("isn't fully configured yet"), findsOneWidget);
    expect(find.textContaining('dev-1'), findsNothing);
    expect(find.textContaining('AmbiguousDeviceResolutionException'),
        findsNothing);
    expect(find.textContaining('onoff'), findsNothing);
  });
}
