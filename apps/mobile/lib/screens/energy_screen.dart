import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../errors.dart';
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
          error: (e, _) => Center(child: Text(friendlyError(e, 'Energy data is unavailable right now.'), textAlign: TextAlign.center)),
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
                    const _RunningCostsCard(),
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

/// The curated countries the hub can resolve a default rate for (mirrors COUNTRY_RATES).
const _supportedCountries = <String, String>{
  'IN': 'India', 'US': 'United States', 'GB': 'United Kingdom', 'DE': 'Germany',
  'FR': 'France', 'ES': 'Spain', 'IT': 'Italy', 'NL': 'Netherlands', 'IE': 'Ireland',
  'AE': 'UAE', 'SA': 'Saudi Arabia', 'AU': 'Australia', 'NZ': 'New Zealand',
  'CA': 'Canada', 'JP': 'Japan', 'SG': 'Singapore', 'ZA': 'South Africa',
  'BR': 'Brazil', 'MX': 'Mexico', 'CN': 'China', 'KR': 'South Korea',
  'CH': 'Switzerland', 'SE': 'Sweden', 'PL': 'Poland', 'PT': 'Portugal',
  'BE': 'Belgium', 'AT': 'Austria',
};

/// Running-costs panel: provider setup, per-device/room breakdown, and history at each zoom.
class _RunningCostsCard extends ConsumerStatefulWidget {
  const _RunningCostsCard();

  @override
  ConsumerState<_RunningCostsCard> createState() => _RunningCostsCardState();
}

class _RunningCostsCardState extends ConsumerState<_RunningCostsCard> {
  String _groupBy = 'device';
  String _bucket = 'month';
  bool _compare = false;

  String _money(String currency, num v) => '$currency ${v.toStringAsFixed(2)}';

  /// "▲12%" / "▼8%" chip for a month-over-month delta; null delta (no baseline) → nothing.
  Widget _delta(TextTheme text, num? deltaPct) {
    if (deltaPct == null) return const SizedBox.shrink();
    final up = deltaPct > 0;
    final flat = deltaPct == 0;
    return Padding(
      padding: const EdgeInsets.only(right: AureonSpacing.sm),
      child: Text(
        flat ? '–' : '${up ? '▲' : '▼'}${deltaPct.abs()}%',
        style: text.labelSmall?.copyWith(color: up ? AureonGold.c400 : Colors.greenAccent),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = ref.watch(energyProviderProvider);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: provider.when(
          loading: () => const Center(child: Padding(padding: EdgeInsets.all(AureonSpacing.md), child: CircularProgressIndicator())),
          error: (e, _) => Text('Running costs unavailable\n$e', style: text.labelMedium),
          data: (p) => p == null ? _setupPrompt(context, text) : _costs(context, text, p),
        ),
      ),
    );
  }

  Widget _setupPrompt(BuildContext context, TextTheme text) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Running costs', style: text.titleMedium),
          const SizedBox(height: AureonSpacing.xs),
          Text('Set your electricity provider to price your consumption.', style: text.labelMedium),
          const SizedBox(height: AureonSpacing.sm),
          FilledButton.tonal(onPressed: () => _setup(context), child: const Text('Set up provider')),
        ],
      );

  Widget _costs(BuildContext context, TextTheme text, Map<String, dynamic> p) {
    final currency = p['currency'] as String? ?? '';
    final breakdown = _compare ? ref.watch(energyCompareProvider(_groupBy)) : ref.watch(energyBreakdownProvider(_groupBy));
    final history = ref.watch(energyHistoryProvider(_bucket));
    final names = ref.watch(allDevicesProvider);
    final home = ref.watch(homeProvider);
    String label(String key) {
      if (_groupBy == 'device') {
        return names.maybeWhen(data: (list) => list.firstWhere((d) => d.id == key, orElse: () => list.first).name, orElse: () => key);
      }
      if (key == 'unassigned') return 'Unassigned';
      return home.maybeWhen(data: (h) => h.rooms.firstWhere((r) => r.id == key, orElse: () => h.rooms.first).name, orElse: () => key);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('Running costs', style: text.titleMedium)),
            TextButton(onPressed: () => _setup(context), child: Text('${_supportedCountries[p['country']] ?? p['country']} · ${_money(currency, p['ratePerKwh'] as num)}/kWh')),
          ],
        ),
        const SizedBox(height: AureonSpacing.sm),
        Row(
          children: [
            Expanded(
              child: SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'device', label: Text('Device')),
                  ButtonSegment(value: 'room', label: Text('Room')),
                ],
                selected: {_groupBy},
                onSelectionChanged: (s) => setState(() => _groupBy = s.first),
              ),
            ),
            const SizedBox(width: AureonSpacing.sm),
            FilterChip(
              label: const Text('vs last month'),
              selected: _compare,
              onSelected: (v) => setState(() => _compare = v),
            ),
          ],
        ),
        const SizedBox(height: AureonSpacing.sm),
        breakdown.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => Text('—', style: text.labelMedium),
          data: (b) {
            final groups = (b['groups'] as List<dynamic>).cast<Map<String, dynamic>>();
            if (groups.isEmpty) return Text('No consumption recorded yet', style: text.labelMedium);
            return Column(
              children: [
                for (final g in groups.take(6))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        Expanded(child: Text(label(g['key'] as String), overflow: TextOverflow.ellipsis)),
                        if (_compare) _delta(text, g['deltaPct'] as num?),
                        if (!_compare) ...[
                          Text('${(g['kwh'] as num).toStringAsFixed(1)} kWh', style: text.labelMedium),
                          const SizedBox(width: AureonSpacing.md),
                        ],
                        Text(_money(currency, g['cost'] as num), style: text.bodyMedium?.copyWith(color: AureonGold.c400)),
                      ],
                    ),
                  ),
              ],
            );
          },
        ),
        if (_groupBy == 'device')
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => _editWatts(context),
              icon: const Icon(Icons.bolt_outlined, size: 16),
              label: const Text('Rated wattage'),
            ),
          ),
        const SizedBox(height: AureonSpacing.md),
        _budget(context, text, currency),
        const SizedBox(height: AureonSpacing.lg),
        Row(
          children: [
            Expanded(child: Text('History', style: text.titleSmall)),
            DropdownButton<String>(
              value: _bucket,
              items: const [
                DropdownMenuItem(value: 'day', child: Text('Daily')),
                DropdownMenuItem(value: 'week', child: Text('Weekly')),
                DropdownMenuItem(value: 'month', child: Text('Monthly')),
                DropdownMenuItem(value: 'year', child: Text('Yearly')),
              ],
              onChanged: (v) => setState(() => _bucket = v ?? _bucket),
            ),
          ],
        ),
        history.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => Text('—', style: text.labelMedium),
          data: (h) {
            final rows = (h['history'] as List<dynamic>).cast<Map<String, dynamic>>();
            if (rows.isEmpty) return Text('No history yet', style: text.labelMedium);
            final maxCost = rows.map((r) => (r['cost'] as num).toDouble()).fold<double>(0.01, (m, v) => v > m ? v : m);
            return Column(
              children: [
                for (final r in rows.reversed.take(8).toList().reversed)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        SizedBox(width: 84, child: Text(r['period'] as String, style: text.labelMedium)),
                        Expanded(
                          child: LinearProgressIndicator(
                            value: ((r['cost'] as num).toDouble() / maxCost).clamp(0, 1),
                            minHeight: 8,
                            backgroundColor: AureonBase.surfaceRaised,
                          ),
                        ),
                        const SizedBox(width: AureonSpacing.sm),
                        Text(_money(currency, r['cost'] as num), style: text.labelMedium),
                      ],
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _budget(BuildContext context, TextTheme text, String currency) {
    final budget = ref.watch(energyBudgetProvider);
    return budget.when(
      loading: () => const SizedBox.shrink(),
      error: (e, _) => const SizedBox.shrink(),
      data: (b) {
        final status = b['status'] as Map<String, dynamic>?;
        final cur = (b['currency'] as String?) ?? currency;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text('Monthly budget', style: text.titleSmall)),
                TextButton(
                  onPressed: () => _editBudget(context),
                  child: Text(status == null ? 'Set' : _money(cur, status['budget'] as num)),
                ),
              ],
            ),
            if (status != null) ...[
              Builder(builder: (_) {
                final over = status['overBudget'] == true;
                final util = (status['utilization'] as num?)?.toDouble() ?? 0;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    LinearProgressIndicator(
                      value: util.clamp(0, 1),
                      minHeight: 8,
                      backgroundColor: AureonBase.surfaceRaised,
                      color: over ? AureonGold.c400 : null,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${over ? 'Over budget — ' : ''}projected ${_money(cur, status['projectedMonthEnd'] as num)} by month end',
                      style: text.labelMedium?.copyWith(color: over ? AureonGold.c400 : null),
                    ),
                  ],
                );
              }),
            ] else
              Text('Set a budget to track your monthly energy spend', style: text.labelMedium),
          ],
        );
      },
    );
  }

  Future<void> _editBudget(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final current = ref.read(energyBudgetProvider).valueOrNull?['budget'] as Map<String, dynamic>?;
    final ctl = TextEditingController(text: current?['monthlyBudget']?.toString() ?? '');
    final action = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Monthly energy budget'),
        content: TextField(
          controller: ctl,
          keyboardType: TextInputType.number,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Budget per month (your currency)'),
        ),
        actions: [
          if (current != null)
            TextButton(onPressed: () => Navigator.pop(dialogContext, 'clear'), child: const Text('Clear')),
          TextButton(onPressed: () => Navigator.pop(dialogContext, 'cancel'), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, 'save'), child: const Text('Save')),
        ],
      ),
    );
    if (action == 'save' || action == 'clear') {
      try {
        await ref.read(clientProvider).setEnergyBudget(action == 'clear' ? null : double.tryParse(ctl.text.trim()));
        ref.invalidate(energyBudgetProvider);
      } catch (_) {
        messenger.showSnackBar(const SnackBar(content: Text('Could not save budget')));
      }
    }
    ctl.dispose();
  }

  Future<void> _setup(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    var country = ref.read(energyProviderProvider).valueOrNull?['country'] as String? ?? 'IN';
    final cityCtl = TextEditingController(text: ref.read(energyProviderProvider).valueOrNull?['city'] as String? ?? '');
    final providerCtl = TextEditingController(text: ref.read(energyProviderProvider).valueOrNull?['provider'] as String? ?? '');
    final rateCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setState) => AlertDialog(
          title: const Text('Electricity provider'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButton<String>(
                  isExpanded: true,
                  value: country,
                  items: [for (final e in _supportedCountries.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
                  onChanged: (v) => setState(() => country = v ?? country),
                ),
                TextField(controller: cityCtl, decoration: const InputDecoration(labelText: 'City (optional)')),
                TextField(controller: providerCtl, decoration: const InputDecoration(labelText: 'Provider (optional)')),
                TextField(controller: rateCtl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Rate per kWh (from your bill, optional)')),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Save')),
          ],
        ),
      ),
    );
    if (saved == true) {
      try {
        await ref.read(clientProvider).setEnergyProvider(
              country: country,
              city: cityCtl.text.isEmpty ? null : cityCtl.text,
              provider: providerCtl.text.isEmpty ? null : providerCtl.text,
              ratePerKwh: double.tryParse(rateCtl.text),
            );
        ref.invalidate(energyProviderProvider);
        ref.invalidate(energyBreakdownProvider);
        ref.invalidate(energyHistoryProvider);
      } catch (_) {
        messenger.showSnackBar(const SnackBar(content: Text('Could not save provider')));
      }
    }
    cityCtl.dispose();
    providerCtl.dispose();
    rateCtl.dispose();
  }

  /// Let the owner give non-metered devices a rated wattage so the hub can estimate
  /// their energy (and therefore their cost) from on-time. One field per device.
  Future<void> _editWatts(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final devices = ref.read(allDevicesProvider).valueOrNull ?? const <Device>[];
    if (devices.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('No devices to configure yet')));
      return;
    }
    final current = ref.read(energyDeviceWattsProvider).valueOrNull ?? const <String, double>{};
    final controllers = {
      for (final d in devices)
        d.id: TextEditingController(text: (current[d.id] ?? 0) > 0 ? _trimWatts(current[d.id]!) : ''),
    };
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Rated wattage'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: AureonSpacing.sm),
                child: Text('For devices with no power meter, enter their rated watts so their running cost can be estimated. Leave blank to skip.'),
              ),
              for (final d in devices)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    children: [
                      Expanded(child: Text(d.name, overflow: TextOverflow.ellipsis)),
                      SizedBox(
                        width: 96,
                        child: TextField(
                          controller: controllers[d.id],
                          keyboardType: TextInputType.number,
                          textAlign: TextAlign.end,
                          decoration: const InputDecoration(suffixText: 'W', isDense: true),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Save')),
        ],
      ),
    );
    if (saved == true) {
      final watts = <String, double>{};
      for (final e in controllers.entries) {
        final v = double.tryParse(e.value.text.trim());
        if (v != null && v > 0) watts[e.key] = v;
      }
      try {
        await ref.read(clientProvider).setEnergyDeviceWatts(watts);
        ref.invalidate(energyDeviceWattsProvider);
        ref.invalidate(energyBreakdownProvider);
        messenger.showSnackBar(const SnackBar(content: Text('Rated wattage saved')));
      } catch (_) {
        messenger.showSnackBar(const SnackBar(content: Text('Could not save wattage')));
      }
    }
    for (final c in controllers.values) {
      c.dispose();
    }
  }

  static String _trimWatts(double w) => w == w.roundToDouble() ? w.toInt().toString() : w.toString();
}
