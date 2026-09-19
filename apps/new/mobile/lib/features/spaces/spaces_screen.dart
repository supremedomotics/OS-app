import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

class SpacesScreen extends ConsumerWidget {
  final void Function(Space) onOpenSpace;
  const SpacesScreen({super.key, required this.onOpenSpace});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(homeStateRepositoryProvider);
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    return FutureBuilder<List<Space>>(
      future: repo.spaces(),
      builder: (context, snap) {
        final loading = snap.connectionState != ConnectionState.done;
        final spaces = snap.data ?? const [];
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('Spaces', style: text.title),
            const SizedBox(height: 24),
            // §QA-01 — an honest state instead of a blank screen: while the first real read is
            // in flight, say so; once it resolves to genuinely zero rooms (no Home connected,
            // or a Home with no rooms configured), say that too — never fabricated room data,
            // same restrained, centered, muted-text treatment `NowScreen`'s empty state uses.
            if (loading)
              Padding(
                padding: const EdgeInsets.only(top: 48),
                child: Center(
                  child: Text('Loading your spaces…',
                      style: text.body
                          .copyWith(color: SupremeColorScheme.textSecondary)),
                ),
              )
            else if (spaces.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 48),
                child: Center(
                  child: Text('No Spaces yet',
                      style: text.body
                          .copyWith(color: SupremeColorScheme.textSecondary)),
                ),
              )
            else
              for (final space in spaces)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child:
                      _SpaceRow(space: space, onTap: () => onOpenSpace(space)),
                ),
          ],
        );
      },
    );
  }
}

class _SpaceRow extends StatelessWidget {
  final Space space;
  final VoidCallback onTap;
  const _SpaceRow({required this.space, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    return Semantics(
      button: true,
      label: 'Open ${space.name}',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: profile.minTouchTarget),
          child: SupremeCard(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(space.name, style: text.headline),
                  const Icon(Icons.chevron_right,
                      color: SupremeColorScheme.textSecondary),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
