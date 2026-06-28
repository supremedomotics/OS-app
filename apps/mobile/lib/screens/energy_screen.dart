import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Energy & analytics (§16): per-measure totals + a tariff-aware cost card.
class EnergyScreen extends ConsumerWidget {
  const EnergyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final energy = ref.watch(energyProvider);
    final cost = ref.watch(energyCostProvider);
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
                    cost.maybeWhen(
                      data: (c) => c == null
                          ? const SizedBox.shrink()
                          : _CostCard(cost: c['cost'] as Map<String, dynamic>),
                      orElse: () => const SizedBox.shrink(),
                    ),
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

/// A gold-accented bill card: total cost + the time-of-use period breakdown.
class _CostCard extends StatelessWidget {
  const _CostCard({required this.cost});

  final Map<String, dynamic> cost;

  @override
  Widget build(BuildContext context) {
    final currency = cost['currency'] as String? ?? '';
    final total = (cost['totalCost'] as num?)?.toDouble() ?? 0;
    final periods =
        (cost['byPeriod'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    String money(num v) => '$currency ${v.toStringAsFixed(2)}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Estimated cost',
                style: Theme.of(context).textTheme.labelMedium),
            const SizedBox(height: AureonSpacing.xs),
            Text(money(total),
                style: Theme.of(context)
                    .textTheme
                    .displaySmall
                    ?.copyWith(color: AureonGold.c400)),
            const SizedBox(height: AureonSpacing.sm),
            for (final p in periods)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('${p['name']}  ·  ${(p['kwh'] as num).toStringAsFixed(1)} kWh',
                        style: Theme.of(context).textTheme.bodyMedium),
                    Text(money(p['cost'] as num),
                        style: Theme.of(context).textTheme.bodyMedium),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
