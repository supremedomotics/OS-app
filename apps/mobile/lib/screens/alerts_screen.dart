import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Notification history (§13). Live alerts arrive over the WSS stream; this screen
/// shows the persisted history with severity coloring.
class AlertsScreen extends ConsumerWidget {
  const AlertsScreen({super.key});

  Color _color(String level) => switch (level) {
        'critical' => AureonStatus.critical,
        'warning' => AureonStatus.warning,
        _ => AureonStatus.info,
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final alerts = ref.watch(notificationsProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Alerts', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AureonSpacing.lg),
            Expanded(
              child: alerts.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) =>
                    Center(child: Text('Could not load alerts\n$e')),
                data: (list) => list.isEmpty
                    ? Text('All clear',
                        style: Theme.of(context).textTheme.labelMedium)
                    : ListView.separated(
                        itemCount: list.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(height: AureonSpacing.sm),
                        itemBuilder: (context, i) {
                          final n = list[i];
                          return Card(
                            child: ListTile(
                              leading: Icon(Icons.circle,
                                  size: 12, color: _color(n.level)),
                              title: Text(n.title),
                              subtitle: Text(n.body),
                              trailing: n.unread
                                  ? const Icon(Icons.fiber_new,
                                      color: AureonGold.c400)
                                  : null,
                            ),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
