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
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return FutureBuilder<List<Experience>>(
      future: repo.experiences(),
      builder: (context, snap) {
        final loading = snap.connectionState != ConnectionState.done;
        final experiences = snap.data ?? const [];
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('Experiences', style: text.title),
            const SizedBox(height: 24),
            // §QA-02 — restore the missing header/hierarchy and an honest empty state
            // (no fabricated Experiences), matching Spaces/Now's established pattern.
            if (loading)
              Padding(
                padding: const EdgeInsets.only(top: 48),
                child: Center(
                  child: Text('Loading your experiences…',
                      style: text.body
                          .copyWith(color: SupremeColorScheme.textSecondary)),
                ),
              )
            else if (experiences.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 48),
                child: Center(
                  child: Text('No Experiences yet',
                      style: text.body
                          .copyWith(color: SupremeColorScheme.textSecondary)),
                ),
              )
            else
              GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
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
              ),
          ],
        );
      },
    );
  }
}
