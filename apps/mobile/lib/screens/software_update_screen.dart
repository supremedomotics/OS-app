import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Update Center (§ Update Center) — mobile parity. Shows the hub's current version and, when a
/// signed OTA channel is configured, whether a newer verified release exists (with notes). No channel
/// → it says so honestly rather than implying an update state.
final _updateProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).systemUpdate());

class SoftwareUpdateScreen extends ConsumerWidget {
  const SoftwareUpdateScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final update = ref.watch(_updateProvider);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Software update')),
      body: update.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not check for updates\n$e', textAlign: TextAlign.center)),
        data: (u) {
          final configured = u['channelConfigured'] == true;
          final available = u['updateAvailable'] == true;
          final latest = u['latest'] as Map<String, dynamic>?;
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_updateProvider),
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.lg),
              children: [
                _row(context, 'Current version', 'v${u['current']}'),
                _row(context, 'Update channel', configured ? 'Configured' : 'Not configured'),
                _row(context, 'Status', available ? 'Update available (v${latest?['version']})' : 'Up to date'),
                const SizedBox(height: AureonSpacing.lg),
                if (available && latest != null)
                  Container(
                    padding: const EdgeInsets.all(AureonSpacing.md),
                    decoration: BoxDecoration(
                      color: AureonGold.c400.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(AureonRadius.md),
                      border: Border.all(color: AureonGold.c400.withValues(alpha: 0.45)),
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Version ${latest['version']} is available', style: text.titleSmall),
                      if (latest['notes'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(latest['notes'] as String, style: text.labelMedium)),
                      Padding(padding: const EdgeInsets.only(top: 6), child: Text('The hub verifies and installs signed releases automatically (staged, rollback-safe).', style: text.labelSmall)),
                    ]),
                  ),
                if (!configured)
                  Text('No update channel is configured on this hub. Updates are managed by your installer.', style: text.labelMedium),
                if (u['error'] != null)
                  Padding(padding: const EdgeInsets.only(top: 8), child: Text('Update check failed: ${u['error']}', style: const TextStyle(color: AureonStatus.critical))),
                const SizedBox(height: AureonSpacing.lg),
                FilledButton(onPressed: () => ref.invalidate(_updateProvider), child: const Text('Check for updates')),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _row(BuildContext context, String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(k, style: Theme.of(context).textTheme.labelMedium),
          Text(v, style: Theme.of(context).textTheme.bodyMedium),
        ]),
      );
}
