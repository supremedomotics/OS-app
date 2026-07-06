import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Backup & restore (§ Backup) — mobile parity. Real backup health, one-tap backup (kept in the
/// hub's signed history), an automatic schedule, a re-restorable history, and a rollback-safe restore
/// that previews (dry-run) before it commits.
final _backupStatusProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).backupStatus());
final _backupListProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).backupList());

class BackupScreen extends ConsumerWidget {
  const BackupScreen({super.key});

  String _fmt(String? iso) {
    final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    if (d == null) return 'Never';
    return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(_backupStatusProvider);
    final list = ref.watch(_backupListProvider).valueOrNull ?? const [];
    final text = Theme.of(context).textTheme;

    Future<void> refresh() async {
      ref.invalidate(_backupStatusProvider);
      ref.invalidate(_backupListProvider);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Backup & restore')),
      body: status.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load backups\n$e', textAlign: TextAlign.center)),
        data: (st) {
          final sched = (st['schedule'] as Map<String, dynamic>?) ?? const {};
          final lastBackup = st['lastBackupAt'] as String?;
          return RefreshIndicator(
            onRefresh: refresh,
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                // Health indicator.
                Container(
                  padding: const EdgeInsets.all(AureonSpacing.md),
                  decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.lg), border: Border.all(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.4))),
                  child: Row(children: [
                    Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: lastBackup != null ? AureonStatus.good : AureonStatus.warning)),
                    const SizedBox(width: 14),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(lastBackup != null ? 'Backups healthy' : 'No backups yet', style: text.titleMedium),
                      Text('Last backup ${_fmt(lastBackup)} · ${st['backupCount']} kept', style: text.labelSmall),
                    ])),
                  ]),
                ),
                const SizedBox(height: AureonSpacing.md),
                FilledButton.icon(
                  icon: const Icon(Icons.backup_outlined, size: 18),
                  label: const Text('Back up now'),
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.of(context);
                    try { await ref.read(clientProvider).createBackup(); await refresh(); messenger.showSnackBar(const SnackBar(content: Text('Backup created'))); }
                    catch (e) { messenger.showSnackBar(SnackBar(content: Text('Backup failed: $e'))); }
                  },
                ),

                // Schedule.
                const SizedBox(height: AureonSpacing.lg),
                Text('Automatic backups', style: text.titleSmall),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Back up automatically'),
                  subtitle: Text(sched['enabled'] == true ? 'Every ${sched['everyHours']}h · keep ${sched['retain']}' : 'Off'),
                  value: sched['enabled'] == true,
                  onChanged: (v) async {
                    await ref.read(clientProvider).setBackupSchedule(enabled: v);
                    await refresh();
                  },
                ),
                if (sched['enabled'] == true)
                  Row(children: [
                    Expanded(child: _NumField(label: 'Every (hours)', value: (sched['everyHours'] as num?)?.toInt() ?? 24, onSubmit: (n) async { await ref.read(clientProvider).setBackupSchedule(everyHours: n); await refresh(); })),
                    const SizedBox(width: 12),
                    Expanded(child: _NumField(label: 'Keep', value: (sched['retain'] as num?)?.toInt() ?? 14, onSubmit: (n) async { await ref.read(clientProvider).setBackupSchedule(retain: n); await refresh(); })),
                  ]),
                if (st['nextDueAt'] != null)
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text('Next backup ${_fmt(st['nextDueAt'] as String?)}', style: text.labelSmall)),

                // History with restore.
                const SizedBox(height: AureonSpacing.lg),
                Text('Backup history', style: text.titleSmall),
                if (list.isEmpty) Padding(padding: const EdgeInsets.all(8), child: Text('No backups yet.', style: text.labelMedium)),
                for (final b in list)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.inventory_2_outlined),
                      title: Text(_fmt(b['createdAt'] as String?)),
                      subtitle: Text('${b['rowCount']} rows · ${b['tableCount']} tables · ${b['source']}', style: text.labelSmall),
                      trailing: TextButton(
                        onPressed: () => _confirmRestore(context, ref, b['id'] as String, refresh),
                        child: const Text('Restore'),
                      ),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _confirmRestore(BuildContext context, WidgetRef ref, String id, Future<void> Function() refresh) async {
    final messenger = ScaffoldMessenger.of(context);
    final client = ref.read(clientProvider);
    // Dry-run preview first.
    Map<String, dynamic> preview;
    String document;
    try {
      final rec = await client.getBackup(id);
      document = rec['document'] as String;
      preview = await client.inspectRestore(document);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Could not read backup: $e')));
      return;
    }
    if (!context.mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Restore this backup?'),
        content: Text(
          '${preview['signatureValid'] == false ? '⚠ Invalid signature\n' : '✓ Verified backup\n'}'
          'From ${preview['createdAt']}\n'
          '${preview['rowCount']} rows across ${preview['tableCount']} tables will replace current data. A rollback snapshot is taken first.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: AureonStatus.critical), onPressed: () => Navigator.pop(c, true), child: const Text('Restore')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final r = await client.restoreBackup(document);
      await refresh();
      messenger.showSnackBar(SnackBar(content: Text('Restored ${r['rows']} rows across ${r['tables']} tables')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Restore failed (rolled back): $e')));
    }
  }
}

class _NumField extends StatefulWidget {
  const _NumField({required this.label, required this.value, required this.onSubmit});
  final String label;
  final int value;
  final Future<void> Function(int) onSubmit;

  @override
  State<_NumField> createState() => _NumFieldState();
}

class _NumFieldState extends State<_NumField> {
  late final TextEditingController _c = TextEditingController(text: '${widget.value}');

  @override
  void dispose() { _c.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _c,
      keyboardType: TextInputType.number,
      decoration: InputDecoration(labelText: widget.label),
      onSubmitted: (v) { final n = int.tryParse(v); if (n != null && n > 0) widget.onSubmit(n); },
    );
  }
}
