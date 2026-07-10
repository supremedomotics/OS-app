import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../errors.dart';
import '../providers.dart';
import '../usage.dart';
import 'room_categories_screen.dart';

/// Room-first horizontal pager (§11.1): swipe between rooms. Each page opens straight into the
/// room's category screen (Room → Lighting/Media/Curtains/… → device list → detail) — the same
/// flow at every width, phone or tablet.
class HomePager extends ConsumerWidget {
  const HomePager({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    return Scaffold(
      body: home.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(friendlyError(e, 'Could not load your home.'), textAlign: TextAlign.center)),
        data: (view) {
          // Frequently-used rooms move higher (§ Personalization): a stable order per session that,
          // once the home has history, puts the rooms you open most first. Read (not watch) so the
          // pager doesn't reshuffle under you mid-swipe.
          final usage = ref.read(usageProvider.notifier);
          final indexed = [for (var i = 0; i < view.rooms.length; i++) (i, view.rooms[i])];
          indexed.sort((a, b) {
            final byCount = usage.count('room', b.$2.id).compareTo(usage.count('room', a.$2.id));
            return byCount != 0 ? byCount : a.$1.compareTo(b.$1); // stable: keep original order on ties
          });
          final rooms = [for (final r in indexed) r.$2];
          return SafeArea(
            child: PageView(
              onPageChanged: (i) => usage.record('room', rooms[i].id),
              children: [
                for (final room in rooms)
                  RoomCategoriesScreen(roomId: room.id, roomName: room.name, areaType: room.areaType, heroImageUrl: room.heroImageUrl),
              ],
            ),
          );
        },
      ),
    );
  }
}
