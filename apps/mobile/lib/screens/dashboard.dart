import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'energy_screen.dart';

/// Homeowner dashboard (§11.3): a quick-scene row at the top, then favorites and
/// an entry into rooms. Calm, room-first, gesture-driven.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    final scenes = ref.watch(scenesProvider);
    final favorites = ref.watch(favoritesProvider);

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          Text(
            home.maybeWhen(
              data: (h) => h.homeName,
              orElse: () => 'Supreme',
            ),
            style: Theme.of(context).textTheme.displayLarge,
          ),
          Text('Welcome home', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: AureonSpacing.lg),

          // Quick-scene row.
          SizedBox(
            height: 44,
            child: scenes.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (_, __) => const SizedBox.shrink(),
              data: (list) => ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: list.length,
                separatorBuilder: (_, __) =>
                    const SizedBox(width: AureonSpacing.sm),
                itemBuilder: (context, i) => SceneButton(
                  label: list[i].name,
                  onTap: () async {
                    await ref.read(clientProvider).activateScene(list[i].id);
                  },
                ),
              ),
            ),
          ),
          const SizedBox(height: AureonSpacing.xl),

          Text('Favorites', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.md),
          favorites.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Text('Could not load favorites: $e'),
            data: (list) => list.isEmpty
                ? Text('No favorites yet',
                    style: Theme.of(context).textTheme.labelMedium)
                : Wrap(
                    spacing: AureonSpacing.sm,
                    runSpacing: AureonSpacing.sm,
                    children: [
                      for (final f in list)
                        Chip(
                            label:
                                Text('${f.type}: ${f.refId.substring(0, 8)}…')),
                    ],
                  ),
          ),
          const SizedBox(height: AureonSpacing.xl),
          Card(
            child: ListTile(
              leading: const Icon(Icons.bolt_outlined, color: AureonGold.c400),
              title: const Text('Energy'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const EnergyScreen()),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
