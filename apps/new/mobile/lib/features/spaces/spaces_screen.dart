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
        final spaces = snap.data ?? const [];
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('Spaces', style: text.title),
            const SizedBox(height: 24),
            for (final space in spaces)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _SpaceRow(space: space, onTap: () => onOpenSpace(space)),
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
