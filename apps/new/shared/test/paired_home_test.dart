import 'package:test/test.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

void main() {
  group('PairedHomeManager persistence (§27 Persistence)', () {
    test('saves and reloads one Home', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a',
          projectId: 'proj-a',
          displayName: 'Sea View Residence');

      final reloaded = PairedHomeManager(store);
      await reloaded.load();

      expect(reloaded.homes, hasLength(1));
      expect(reloaded.homes.single.displayName, 'Sea View Residence');
    });

    test('saves and reloads multiple Homes', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'Home');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'Weekend Home');
      await manager.addHome(
          hubId: 'hub-c', projectId: 'proj-c', displayName: 'Office');

      final reloaded = PairedHomeManager(store);
      await reloaded.load();

      expect(reloaded.homes.map((h) => h.hubId),
          containsAll(['hub-a', 'hub-b', 'hub-c']));
    });

    test('renaming a Home persists the new name', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'Old Name');

      await manager.renameHome('hub-a', 'Sea View Residence');

      final reloaded = PairedHomeManager(store);
      await reloaded.load();
      expect(reloaded.homes.single.displayName, 'Sea View Residence');
    });

    test('active Home selection persists across a reload', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      await manager.setActiveHome('hub-b');

      final reloaded = PairedHomeManager(store);
      await reloaded.load();
      expect(reloaded.activeHomeId, 'hub-b');
    });
  });

  group('Canonical identity vs display name (§8/§27 Identity)', () {
    test('renaming a Home never changes its hubId or projectId', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      final home = await manager.addHome(
          hubId: 'hub-abc123',
          projectId: 'proj-xyz',
          displayName: 'Mumbai Home');

      await manager.renameHome('hub-abc123', 'Sea View Residence');

      final renamed = manager.homes.firstWhere((h) => h.hubId == home.hubId);
      expect(renamed.hubId, 'hub-abc123');
      expect(renamed.projectId, 'proj-xyz');
      expect(renamed.displayName, 'Sea View Residence');
    });

    test(
        'display name is never used to look up or select a Home — hubId is the only key',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'Duplicate Name');
      // A second Home may legitimately share a display name — this must not collide or merge.
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'Duplicate Name');

      expect(manager.homes, hasLength(2));
      expect(manager.homes.map((h) => h.hubId).toSet(), {'hub-a', 'hub-b'});
    });

    test('rejects a whitespace-only or empty display name', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');

      expect(() => manager.renameHome('hub-a', '   '), throwsArgumentError);
      expect(() => manager.renameHome('hub-a', ''), throwsArgumentError);
    });

    test('trims surrounding whitespace from a valid name', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.renameHome('hub-a', '  Sea View Residence  ');
      expect(manager.homes.single.displayName, 'Sea View Residence');
    });

    test('rejects a display name over the maximum length', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      expect(() => manager.renameHome('hub-a', 'x' * 100), throwsArgumentError);
    });
  });

  group('Multiple Homes — add/select/switch (§27 Multiple Homes)', () {
    test('adding Home A then Home B keeps both; switching back to A works',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');

      await manager.setActiveHome('hub-b');
      expect(manager.activeHomeId, 'hub-b');

      await manager.setActiveHome('hub-a');
      expect(manager.activeHomeId, 'hub-a');
      expect(manager.homes, hasLength(2));
    });

    test('cannot pair the same Hub twice', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      expect(
          () => manager.addHome(
              hubId: 'hub-a', projectId: 'proj-a', displayName: 'A again'),
          throwsStateError);
    });

    test(
        'the first paired Home becomes active automatically; the second does not',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      expect(manager.activeHomeId, 'hub-a');

      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      expect(manager.activeHomeId, 'hub-a'); // unchanged
    });
  });

  group('Security isolation between Homes (§27 Security)', () {
    test('removing Home A does not affect Home B', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');

      await manager.removeHome('hub-a');

      expect(manager.homes, hasLength(1));
      expect(manager.homes.single.hubId, 'hub-b');
    });

    test(
        'removing the ACTIVE Home clears activeHomeId without touching other Homes',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      await manager.setActiveHome('hub-a');

      await manager.removeHome('hub-a');

      expect(manager.activeHomeId, isNull);
      expect(manager.homes.single.hubId, 'hub-b');
    });

    test('removing a NON-active Home leaves the active Home selected',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      await manager.setActiveHome('hub-a');

      await manager.removeHome('hub-b');

      expect(manager.activeHomeId, 'hub-a');
    });

    test('renaming Home A never mutates Home B', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');

      await manager.renameHome('hub-a', 'Renamed A');

      expect(
          manager.homes.firstWhere((h) => h.hubId == 'hub-b').displayName, 'B');
    });
  });

  group('Startup behavior (§27 Startup / §22 / §23)', () {
    test('with no paired Homes, activeHome and activeHomeId are both null',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      expect(manager.homes, isEmpty);
      expect(manager.activeHomeId, isNull);
      expect(manager.activeHome, isNull);
    });

    test(
        'a previously-active Home that no longer exists in the persisted list resolves to null, '
        'never a fabricated substitute', () async {
      final store = InMemoryPairedHomeStore();
      await store.saveAll([]);
      await store.saveActiveHomeId('hub-long-gone');

      final manager = PairedHomeManager(store);
      await manager.load();

      expect(manager.activeHomeId, 'hub-long-gone'); // still what was persisted
      expect(manager.activeHome,
          isNull); // but resolves to nothing — never guessed
    });

    test(
        'restoring active Home keeps it selected even though this manager cannot itself prove '
        'reachability (that is ConnectionManager\'s job, not this one\'s)',
        () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');
      await manager.setActiveHome('hub-b');

      final reloaded = PairedHomeManager(store);
      await reloaded.load();

      expect(reloaded.activeHomeId, 'hub-b');
      // Another Home remains selectable regardless of the active one's reachability.
      expect(reloaded.homes.map((h) => h.hubId), contains('hub-a'));
    });
  });

  group('Remote Access per Home (§Phase12.10 §3/§5)', () {
    test('a newly paired Home defaults to Remote Access OFF', () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      final home = await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      expect(home.remoteAccessEnabled, isFalse);
      expect(manager.homes.single.remoteAccessEnabled, isFalse);
    });

    test('setRemoteAccessEnabled toggles only the targeted Home', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.addHome(
          hubId: 'hub-b', projectId: 'proj-b', displayName: 'B');

      await manager.setRemoteAccessEnabled('hub-a', true);

      final a = manager.homes.firstWhere((h) => h.hubId == 'hub-a');
      final b = manager.homes.firstWhere((h) => h.hubId == 'hub-b');
      expect(a.remoteAccessEnabled, isTrue);
      expect(b.remoteAccessEnabled, isFalse); // never leaked to the other Home
    });

    test('the setting persists across reload', () async {
      final store = InMemoryPairedHomeStore();
      final manager = PairedHomeManager(store);
      await manager.load();
      await manager.addHome(
          hubId: 'hub-a', projectId: 'proj-a', displayName: 'A');
      await manager.setRemoteAccessEnabled('hub-a', true);

      final reloaded = PairedHomeManager(store);
      await reloaded.load();

      expect(reloaded.homes.single.remoteAccessEnabled, isTrue);
    });

    test('throws for an unknown Home rather than silently no-op-ing',
        () async {
      final manager = PairedHomeManager(InMemoryPairedHomeStore());
      await manager.load();
      expect(() => manager.setRemoteAccessEnabled('nope', true),
          throwsStateError);
    });

    test(
        'a Home persisted before this field existed decodes as OFF, never silently ON',
        () async {
      final json = {
        'hubId': 'hub-old',
        'projectId': 'proj-old',
        'displayName': 'Legacy Home',
        'pairedAt': DateTime.now().toIso8601String(),
        'lastUsedAt': null,
        // no 'remoteAccessEnabled' key at all — simulates data written before §Phase12.10.
      };
      final home = PairedHome.fromJson(json);
      expect(home.remoteAccessEnabled, isFalse);
    });
  });
}
