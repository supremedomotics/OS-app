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
      appBar: AppBar(
        title: const Text('Energy'),
        actions: [
          IconButton(
            tooltip: 'Climate schedule',
            icon: const Icon(Icons.thermostat_outlined),
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              builder: (_) => const _ClimateProgramSheet(),
            ),
          ),
        ],
      ),
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

/// Editor for the programmable-thermostat climate program (weekday + weekend setpoint blocks).
class _ClimateProgramSheet extends ConsumerStatefulWidget {
  const _ClimateProgramSheet();

  @override
  ConsumerState<_ClimateProgramSheet> createState() =>
      _ClimateProgramSheetState();
}

class _ClimateProgramSheetState extends ConsumerState<_ClimateProgramSheet> {
  List<Map<String, dynamic>> _weekday = [];
  List<Map<String, dynamic>> _weekend = [];
  bool _loaded = false;
  bool _saving = false;

  static const _defaultProgram = {
    'weekday': [
      {'atMinutes': 360, 'targetC': 21},
      {'atMinutes': 510, 'targetC': 18},
      {'atMinutes': 1020, 'targetC': 21},
      {'atMinutes': 1320, 'targetC': 18},
    ],
    'weekend': [
      {'atMinutes': 450, 'targetC': 21},
      {'atMinutes': 1380, 'targetC': 18},
    ],
  };

  void _hydrate(Map<String, dynamic>? program) {
    if (_loaded) return;
    final p = program ?? _defaultProgram;
    _weekday = [for (final b in (p['weekday'] as List)) Map<String, dynamic>.from(b as Map)];
    _weekend = [for (final b in (p['weekend'] as List)) Map<String, dynamic>.from(b as Map)];
    _loaded = true;
  }

  String _fmt(int m) =>
      '${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';

  Widget _blockList(String title, List<Map<String, dynamic>> blocks) {
    blocks.sort((a, b) => (a['atMinutes'] as int).compareTo(b['atMinutes'] as int));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        for (final b in blocks)
          ListTile(
            dense: true,
            leading: const Icon(Icons.schedule, size: 18),
            title: Text(_fmt(b['atMinutes'] as int)),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.remove),
                  onPressed: () => setState(() => b['targetC'] = ((b['targetC'] as num) - 1).clamp(5, 35)),
                ),
                Text('${b['targetC']}°C'),
                IconButton(
                  icon: const Icon(Icons.add),
                  onPressed: () => setState(() => b['targetC'] = ((b['targetC'] as num) + 1).clamp(5, 35)),
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline),
                  onPressed: () => setState(() => blocks.remove(b)),
                ),
              ],
            ),
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.add),
            label: const Text('Add block'),
            onPressed: () async {
              final picked = await showTimePicker(
                  context: context, initialTime: const TimeOfDay(hour: 18, minute: 0));
              if (picked != null) {
                setState(() => blocks.add({'atMinutes': picked.hour * 60 + picked.minute, 'targetC': 20}));
              }
            },
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final program = ref.watch(climateProgramProvider);
    return SafeArea(
      child: program.when(
        loading: () => const Padding(
            padding: EdgeInsets.all(AureonSpacing.xl),
            child: Center(child: CircularProgressIndicator())),
        error: (e, _) => Padding(
            padding: const EdgeInsets.all(AureonSpacing.lg),
            child: Text('Could not load climate schedule\n$e')),
        data: (p) {
          _hydrate(p);
          return SingleChildScrollView(
            padding: const EdgeInsets.all(AureonSpacing.lg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Climate schedule',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: AureonSpacing.md),
                _blockList('Weekday', _weekday),
                const SizedBox(height: AureonSpacing.md),
                _blockList('Weekend', _weekend),
                const SizedBox(height: AureonSpacing.lg),
                Row(
                  children: [
                    FilledButton(
                      onPressed: _saving || _weekday.isEmpty || _weekend.isEmpty
                          ? null
                          : () async {
                              setState(() => _saving = true);
                              final messenger = ScaffoldMessenger.of(context);
                              final nav = Navigator.of(context);
                              try {
                                await ref.read(clientProvider).setClimateProgram(
                                    {'weekday': _weekday, 'weekend': _weekend});
                                ref.invalidate(climateProgramProvider);
                                nav.pop();
                              } catch (_) {
                                setState(() => _saving = false);
                                messenger.showSnackBar(const SnackBar(
                                    content: Text('Could not save climate schedule')));
                              }
                            },
                      child: const Text('Save'),
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
