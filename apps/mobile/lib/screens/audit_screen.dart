import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Read-only audit log (admin) — mobile parity with the web viewer. Shows the hub's tamper-evident,
/// hash-chained activity trail with a "Verify chain" action. Gracefully surfaces the "needs Postgres"
/// notice on the in-memory dev backend and a permission error for non-admins.
class AuditScreen extends ConsumerStatefulWidget {
  const AuditScreen({super.key});

  @override
  ConsumerState<AuditScreen> createState() => _AuditScreenState();
}

class _AuditScreenState extends ConsumerState<AuditScreen> {
  List<Map<String, dynamic>> _entries = [];
  String? _error;
  String? _verify;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final entries = await ref.read(clientProvider).auditLog();
      if (!mounted) return;
      setState(() { _entries = entries; _error = null; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = 'Could not load the audit log (admin only, needs the database).'; _loading = false; });
    }
  }

  Future<void> _runVerify() async {
    try {
      final r = await ref.read(clientProvider).auditVerify();
      setState(() => _verify = r['valid'] == true ? '✓ Chain intact' : '✕ Broken at #${r['brokenAt'] ?? '?'}');
    } catch (_) {
      setState(() => _verify = 'Verify unavailable');
    }
  }

  String _fmt(String s) => s.replaceAll(RegExp(r'[._]'), ' ');

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Audit log'),
        actions: [
          TextButton(onPressed: _runVerify, child: const Text('Verify chain')),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(AureonSpacing.md),
                children: [
                  if (_verify != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
                      child: Text(_verify!, style: text.labelLarge?.copyWith(
                          color: _verify!.startsWith('✓') ? AureonStatus.good : AureonStatus.critical)),
                    ),
                  if (_error != null) Text(_error!, style: text.bodyMedium?.copyWith(color: AureonStatus.critical)),
                  if (_error == null && _entries.isEmpty) Text('No audit entries yet.', style: text.bodyMedium),
                  for (final e in _entries)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Text('#${e['seq']}', style: text.labelSmall),
                      title: Text(_fmt(e['action'] as String? ?? ''), style: text.bodyMedium),
                      subtitle: Text(
                        '${e['resourceType'] ?? ''}'
                        '${e['resourceId'] != null ? ' · ${(e['resourceId'] as String).substring(0, (e['resourceId'] as String).length.clamp(0, 10))}…' : ''}'
                        ' · ${DateTime.tryParse(e['createdAt'] as String? ?? '')?.toLocal() ?? ''}',
                        style: text.labelSmall,
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}
