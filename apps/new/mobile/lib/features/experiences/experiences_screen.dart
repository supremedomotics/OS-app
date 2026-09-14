import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// "Desired states of the residence" (§5, §16) — the homeowner sees names
/// like Relax, never a device command list. Uses the shared
/// [ExperienceControl] tile (§Phase7-13), not a Mobile-only reimplementation.
class ExperiencesScreen extends ConsumerWidget {
  const ExperiencesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(homeStateRepositoryProvider);
    return FutureBuilder<List<Experience>>(
      future: repo.experiences(),
      builder: (context, snap) {
        final experiences = snap.data ?? const [];
        return GridView.count(
          padding: const EdgeInsets.all(24),
          crossAxisCount: 2,
          mainAxisSpacing: 16,
          crossAxisSpacing: 16,
          childAspectRatio: 1.4,
          children: [
            for (final experience in experiences)
              ExperienceControl(
                name: experience.name,
                onActivate: () => repo.invokeExperience(experience.id),
              ),
          ],
        );
      },
    );
  }
}
