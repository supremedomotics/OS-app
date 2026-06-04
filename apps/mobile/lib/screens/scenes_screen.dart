import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Scenes list with one-tap activation (§10).
class ScenesScreen extends ConsumerWidget {
  const ScenesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scenes = ref.watch(scenesProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Scenes', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AureonSpacing.lg),
            Expanded(
              child: scenes.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) =>
                    Center(child: Text('Could not load scenes\n$e')),
                data: (list) => list.isEmpty
                    ? Text('No scenes yet',
                        style: Theme.of(context).textTheme.labelMedium)
                    : ListView.separated(
                        itemCount: list.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(height: AureonSpacing.sm),
                        itemBuilder: (context, i) => Card(
                          child: ListTile(
                            leading: const Icon(Icons.auto_awesome,
                                color: AureonGold.c400),
                            title: Text(list[i].name),
                            trailing: const Icon(Icons.play_arrow),
                            onTap: () => ref
                                .read(clientProvider)
                                .activateScene(list[i].id),
                          ),
                        ),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
