import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Energy & analytics (§16): per-measure totals for the home.
class EnergyScreen extends ConsumerWidget {
  const EnergyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final energy = ref.watch(energyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Energy')),
      body: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: energy.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(child: Text('Energy data unavailable\n$e')),
          data: (rows) => rows.isEmpty
              ? Text('No telemetry yet',
                  style: Theme.of(context).textTheme.labelMedium)
              : ListView(
                  children: [
                    for (final r in rows)
                      Card(
                        child: ListTile(
                          title: Text(r['measure'] as String),
                          trailing: Text(
                            '${(r['total'] as num).toStringAsFixed(1)} ${r['unit']}',
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                          subtitle: Text('${r['count']} samples'),
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}
