import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'automations_screen.dart';
import 'energy_screen.dart';

/// Homeowner dashboard (§11.1/§11.3) — the Ovio-grade "Welcome home": a calm header, a
/// full-bleed home hero, a quick-scene row, and proportional category tiles that drill
/// into the home. Room-first, gesture-driven, no long entity lists.
String _greeting() {
  final h = DateTime.now().hour;
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    final scenes = ref.watch(scenesProvider);
    final favorites = ref.watch(favoritesProvider);
    final text = Theme.of(context).textTheme;
    final homeName = home.maybeWhen(data: (h) => h.homeName, orElse: () => 'Supreme');
    final roomCount = home.maybeWhen(data: (h) => h.rooms.length, orElse: () => 0);

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
            AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.xxl),
        children: [
          Text(_greeting(), style: text.titleLarge),
          Text(homeName, style: text.labelMedium),
          const SizedBox(height: AureonSpacing.lg),

          // Home hero — photographic backdrop falls back to an accent gradient.
          RoomHero(
            title: homeName,
            subtitle: roomCount > 0 ? '$roomCount rooms' : null,
            statusValue: 'All calm',
            statusLabel: 'Home',
            metricValue: scenes.maybeWhen(data: (s) => '${s.length}', orElse: () => null),
            metricLabel: 'Scenes',
          ),
          const SizedBox(height: AureonSpacing.lg),

          // Quick-scene row.
          scenes.maybeWhen(
            data: (list) => list.isEmpty
                ? const SizedBox.shrink()
                : SizedBox(
                    height: 44,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: list.length,
                      separatorBuilder: (_, __) => const SizedBox(width: AureonSpacing.sm),
                      itemBuilder: (context, i) => SceneButton(
                        label: list[i].name,
                        onTap: () async => ref.read(clientProvider).activateScene(list[i].id),
                      ),
                    ),
                  ),
            orElse: () => const SizedBox.shrink(),
          ),
          const SizedBox(height: AureonSpacing.lg),

          // Category tiles — calm aggregates that drill in (no long entity lists).
          CategoryTile(
            icon: Icons.meeting_room_outlined,
            label: 'Rooms',
            value: roomCount > 0 ? '$roomCount' : null,
            trailing: const Icon(Icons.chevron_right, size: 20),
          ),
          const SizedBox(height: AureonSpacing.sm),
          CategoryTile(
            icon: Icons.bolt_outlined,
            label: 'Energy',
            trailing: const Icon(Icons.chevron_right, size: 20),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const EnergyScreen()),
            ),
          ),
          const SizedBox(height: AureonSpacing.sm),
          CategoryTile(
            icon: Icons.account_tree_outlined,
            label: 'Automations',
            trailing: const Icon(Icons.chevron_right, size: 20),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AutomationsScreen()),
            ),
          ),

          // Favorites, when present.
          favorites.maybeWhen(
            data: (list) => list.isEmpty
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(top: AureonSpacing.xl),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Favorites', style: text.headlineSmall),
                        const SizedBox(height: AureonSpacing.md),
                        Wrap(
                          spacing: AureonSpacing.sm,
                          runSpacing: AureonSpacing.sm,
                          children: [
                            for (final f in list)
                              Chip(label: Text('${f.type}: ${f.refId.substring(0, 8)}…')),
                          ],
                        ),
                      ],
                    ),
                  ),
            orElse: () => const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}
