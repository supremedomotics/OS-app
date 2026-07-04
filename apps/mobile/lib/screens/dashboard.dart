import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../room_image.dart';
import 'alerts_screen.dart';
import 'automations_screen.dart';
import 'energy_screen.dart';
import 'home_switcher.dart';
import 'intelligence_screen.dart';

/// Homeowner dashboard (§11.1/§11.3) — the Ovio-grade "Welcome home": a calm header, a
/// full-bleed home hero, a quick-scene row, and proportional category tiles that drill
/// into the home. Room-first, gesture-driven, no long entity lists.
/// Ovio quick-scene tiles — square cards with a play glyph; the active scene fills gold.
class SceneTiles extends ConsumerStatefulWidget {
  const SceneTiles({super.key, required this.scenes});
  final List<Scene> scenes;

  @override
  ConsumerState<SceneTiles> createState() => _SceneTilesState();
}

class _SceneTilesState extends ConsumerState<SceneTiles> {
  String? _active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 124,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: widget.scenes.length,
        separatorBuilder: (_, __) => const SizedBox(width: AureonSpacing.sm),
        itemBuilder: (context, i) {
          final s = widget.scenes[i];
          final on = _active == s.id;
          return GestureDetector(
            onTap: () { setState(() => _active = s.id); ref.read(clientProvider).activateScene(s.id); },
            child: Container(
              width: 116,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: on ? AureonGold.c500 : (Theme.of(context).cardTheme.color ?? scheme.surface),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: on ? Colors.transparent : scheme.outlineVariant.withValues(alpha: 0.4)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Container(
                  width: 40, height: 40, alignment: Alignment.center,
                  decoration: BoxDecoration(color: on ? Colors.black.withValues(alpha: 0.12) : Colors.transparent, borderRadius: BorderRadius.circular(12)),
                  child: Icon(Icons.play_arrow_rounded, color: on ? const Color(0xFF15161B) : scheme.onSurface.withValues(alpha: 0.7)),
                ),
                Text(s.name, style: TextStyle(fontWeight: FontWeight.w600, color: on ? const Color(0xFF15161B) : scheme.onSurface)),
              ]),
            ),
          );
        },
      ),
    );
  }
}

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
    // Home hero — a representative room's real photo (hub or Openverse), else that room's style.
    RoomKey? repKey;
    RoomStyle heroStyleValue = roomStyle(homeName, null);
    home.maybeWhen(
      data: (h) {
        if (h.rooms.isEmpty) return;
        final r = h.rooms.firstWhere((room) => room.heroImageUrl != null, orElse: () => h.rooms.first);
        repKey = (name: r.name, areaType: r.areaType, heroImageUrl: r.heroImageUrl);
        heroStyleValue = roomStyle(r.name, r.areaType);
      },
      orElse: () {},
    );
    final heroImage = repKey == null ? null : ref.watch(roomPhotoProvider(repKey!)).valueOrNull;

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
            AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.xxl),
        children: [
          // Greeting + the multi-home switcher (shows the active home + local/cloud status;
          // tap to switch homes instantly). The switcher self-hides when there's one home.
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_greeting(), style: text.titleLarge),
                    Text(homeName, style: text.labelMedium),
                  ],
                ),
              ),
              const HomeSwitcherButton(),
            ],
          ),
          const SizedBox(height: AureonSpacing.lg),

          // Home hero — photographic backdrop falls back to an accent gradient.
          RoomHero(
            title: homeName,
            subtitle: roomCount > 0 ? '$roomCount rooms' : null,
            imageUrl: heroImage,
            gradientColors: [heroStyleValue.from, heroStyleValue.to],
            motif: heroStyleValue.emoji,
            statusValue: 'All calm',
            statusLabel: 'Home',
            metricValue: scenes.maybeWhen(data: (s) => '${s.length}', orElse: () => null),
            metricLabel: 'Scenes',
          ),
          const SizedBox(height: AureonSpacing.lg),

          // Ovio quick-scene tiles.
          scenes.maybeWhen(
            data: (list) => list.isEmpty ? const SizedBox.shrink() : SceneTiles(scenes: list),
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
          const SizedBox(height: AureonSpacing.sm),
          CategoryTile(
            icon: Icons.insights_outlined,
            label: 'Smart',
            trailing: const Icon(Icons.chevron_right, size: 20),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const IntelligenceScreen()),
            ),
          ),
          const SizedBox(height: AureonSpacing.sm),
          CategoryTile(
            icon: Icons.notifications_outlined,
            label: 'Alerts',
            trailing: const Icon(Icons.chevron_right, size: 20),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AlertsScreen()),
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
