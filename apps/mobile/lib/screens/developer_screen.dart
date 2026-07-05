import 'dart:convert';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'audit_screen.dart';

/// Developer (§ Developer Mode) — mobile engineering surface, visible only in Developer Mode. Only
/// tools with a real backend are shown (no placeholder pages): live hub diagnostics, the audit log,
/// and the extension registry (the Extension Center). More instruments (protocol monitors, DB
/// browser, etc.) are added as their backends land.
class DeveloperScreen extends ConsumerWidget {
  const DeveloperScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final diag = ref.watch(_diagProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Developer')),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.md),
        children: [
          Text('Engineering tools — visible only in Developer Mode.', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: AureonSpacing.md),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.receipt_long_outlined),
            title: const Text('Audit log'),
            subtitle: const Text('Tamper-evident activity trail'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AuditScreen())),
          ),
          const Divider(),
          Text('Diagnostics', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: AureonSpacing.sm),
          diag.when(
            loading: () => const Center(child: Padding(padding: EdgeInsets.all(20), child: CircularProgressIndicator())),
            error: (e, _) => Text('Diagnostics unavailable: $e', style: Theme.of(context).textTheme.labelSmall),
            data: (d) => Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.md)),
              child: SelectableText(
                const JsonEncoder.withIndent('  ').convert(d),
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
          ),
          const SizedBox(height: AureonSpacing.sm),
          OutlinedButton.icon(
            onPressed: () => ref.invalidate(_diagProvider),
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('Refresh diagnostics'),
          ),
        ],
      ),
    );
  }
}

final _diagProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).diagnostics());
