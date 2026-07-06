import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../errors.dart';
import '../providers.dart';

/// Notification Center (§ Notification Center). Live alerts arrive over the WSS stream; this screen
/// shows the persisted history with severity colouring, unread state, tap-to-read and mark-all-read —
/// all from the real /v1/notifications backend.
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
    final unreadIds = alerts.valueOrNull?.where((n) => n.unread).map((n) => n.id).toList() ?? const [];
    Future<void> markRead(List<String> ids) async {
      if (ids.isEmpty) return;
      await ref.read(clientProvider).markNotificationsRead(ids);
      ref.invalidate(notificationsProvider);
    }

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(unreadIds.isEmpty ? 'Notifications' : 'Notifications · ${unreadIds.length} new', style: Theme.of(context).textTheme.titleLarge),
              if (unreadIds.isNotEmpty) TextButton(onPressed: () => markRead(unreadIds), child: const Text('Mark all read')),
            ]),
            const SizedBox(height: AureonSpacing.lg),
            Expanded(
              child: alerts.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) =>
                    Center(child: Text(friendlyError(e, 'Could not load your notifications.'), textAlign: TextAlign.center)),
                data: (list) => list.isEmpty
                    ? Text('All clear',
                        style: Theme.of(context).textTheme.labelMedium)
                    : RefreshIndicator(
                        onRefresh: () async => ref.invalidate(notificationsProvider),
                        child: ListView.separated(
                          itemCount: list.length,
                          separatorBuilder: (_, __) =>
                              const SizedBox(height: AureonSpacing.sm),
                          itemBuilder: (context, i) {
                            final n = list[i];
                            return Card(
                              child: Opacity(
                                opacity: n.unread ? 1 : 0.6,
                                child: ListTile(
                                  leading: Icon(Icons.circle,
                                      size: 12, color: _color(n.level)),
                                  title: Text(n.title),
                                  subtitle: Text(n.body),
                                  trailing: n.unread
                                      ? const Icon(Icons.fiber_new,
                                          color: AureonGold.c400)
                                      : null,
                                  onTap: n.unread ? () => markRead([n.id]) : null,
                                ),
                              ),
                            );
                          },
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
