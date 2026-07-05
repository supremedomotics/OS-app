import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Energy Intelligence Dashboard (ADR 0013): the Supreme Intelligence Engine's proactive surface —
/// today's & monthly savings, house occupancy, the Auto Pilot mode, and pending suggestions the user
/// can act on (turn off / keep on / ignore / enable Auto Pilot).
class IntelligenceScreen extends ConsumerWidget {
  const IntelligenceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dashboard = ref.watch(intelligenceDashboardProvider);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Intelligence')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(intelligenceDashboardProvider);
          ref.invalidate(intelligenceSuggestionsProvider);
          ref.invalidate(intelligenceSettingsProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(AureonSpacing.lg),
          children: [
            const _AutoPilotCard(),
            const SizedBox(height: AureonSpacing.md),
            dashboard.when(
              loading: () => const Center(child: Padding(padding: EdgeInsets.all(AureonSpacing.lg), child: CircularProgressIndicator())),
              error: (e, _) => Text('Intelligence unavailable\n$e', style: text.labelMedium),
              data: (d) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _SavingsCard(dashboard: d),
                  const SizedBox(height: AureonSpacing.md),
                  _OccupancyCard(occupancy: d['occupancy'] as Map<String, dynamic>?),
                ],
              ),
            ),
            const SizedBox(height: AureonSpacing.md),
            const _SuggestionsCard(),
          ],
        ),
      ),
    );
  }
}

const _modes = <String, String>{
  'notify_only': 'Notify',
  'approval': 'Approval',
  'auto_pilot': 'Auto',
  'adaptive': 'Adaptive',
};

class _AutoPilotCard extends ConsumerWidget {
  const _AutoPilotCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(intelligenceSettingsProvider);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Auto Pilot', style: text.titleMedium),
            const SizedBox(height: AureonSpacing.xs),
            Text('How Supreme acts on idle devices while you\'re away.', style: text.labelMedium),
            const SizedBox(height: AureonSpacing.sm),
            settings.when(
              loading: () => const LinearProgressIndicator(),
              error: (e, _) => Text('—', style: text.labelMedium),
              data: (s) {
                final mode = s['mode'] as String? ?? 'notify_only';
                return SegmentedButton<String>(
                  segments: [for (final e in _modes.entries) ButtonSegment(value: e.key, label: Text(e.value))],
                  selected: {_modes.containsKey(mode) ? mode : 'notify_only'},
                  showSelectedIcon: false,
                  onSelectionChanged: (sel) async {
                    final messenger = ScaffoldMessenger.of(context);
                    try {
                      await ref.read(clientProvider).setIntelligenceSettings(sel.first);
                      ref.invalidate(intelligenceSettingsProvider);
                    } catch (_) {
                      messenger.showSnackBar(const SnackBar(content: Text('Could not change mode')));
                    }
                  },
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _SavingsCard extends StatelessWidget {
  const _SavingsCard({required this.dashboard});
  final Map<String, dynamic> dashboard;

  String _money(String? currency, num v) => '${currency ?? ''} ${v.toStringAsFixed(2)}'.trim();

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final currency = dashboard['currency'] as String?;
    final today = (dashboard['today'] as Map<String, dynamic>?) ?? {};
    final month = (dashboard['month'] as Map<String, dynamic>?) ?? {};
    Widget metric(String label, String value) => Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(value, style: text.titleLarge?.copyWith(color: AureonGold.c400)),
              Text(label, style: text.labelSmall),
            ],
          ),
        );
    double kwh(Map<String, dynamic> m) => (m['kwhSaved'] as num?)?.toDouble() ?? 0;
    double cost(Map<String, dynamic> m) => (m['costSaved'] as num?)?.toDouble() ?? 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Savings', style: text.titleMedium),
            const SizedBox(height: AureonSpacing.sm),
            Row(children: [
              metric('Today', _money(currency, cost(today))),
              metric('This month', _money(currency, cost(month))),
              metric('kWh saved (mo)', kwh(month).toStringAsFixed(2)),
            ]),
            const SizedBox(height: AureonSpacing.sm),
            Text('≈ ${(kwh(month) * 0.475).toStringAsFixed(2)} kg CO₂ avoided this month · ${month['autoActions'] ?? 0} automatic actions',
                style: text.labelSmall),
          ],
        ),
      ),
    );
  }
}

class _OccupancyCard extends StatelessWidget {
  const _OccupancyCard({required this.occupancy});
  final Map<String, dynamic>? occupancy;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final o = occupancy;
    final occupied = o?['occupied'] == true;
    final present = (o?['present'] as List<dynamic>?)?.length ?? 0;
    final zones = (o?['zones'] as List<dynamic>?)?.cast<Map<String, dynamic>>() ?? [];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(occupied ? Icons.home : Icons.home_outlined, color: occupied ? AureonGold.c400 : null, size: 20),
              const SizedBox(width: AureonSpacing.sm),
              Text(occupied ? 'Home occupied · $present present' : 'Nobody home', style: text.titleSmall),
            ]),
            if (zones.isNotEmpty) ...[
              const SizedBox(height: AureonSpacing.sm),
              for (final z in zones)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 1),
                  child: Row(children: [
                    Expanded(child: Text(z['name'] as String? ?? z['zoneId'] as String? ?? '—', style: text.labelMedium)),
                    Text(
                      (z['occupants'] as List<dynamic>?)?.isNotEmpty == true ? '${(z['occupants'] as List<dynamic>).length} present' : 'vacant',
                      style: text.labelSmall,
                    ),
                  ]),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SuggestionsCard extends ConsumerWidget {
  const _SuggestionsCard();

  Future<void> _respond(BuildContext context, WidgetRef ref, String key, String action) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(clientProvider).respondSuggestion(key, action);
      ref.invalidate(intelligenceSuggestionsProvider);
      ref.invalidate(intelligenceDashboardProvider);
      ref.invalidate(intelligenceSettingsProvider);
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('Could not apply action')));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suggestions = ref.watch(intelligenceSuggestionsProvider);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Suggestions', style: text.titleMedium),
            const SizedBox(height: AureonSpacing.sm),
            suggestions.when(
              loading: () => const LinearProgressIndicator(),
              error: (e, _) => Text('—', style: text.labelMedium),
              data: (list) {
                if (list.isEmpty) return Text('Nothing needs your attention.', style: text.labelMedium);
                return Column(
                  children: [
                    for (final s in list) _suggestionTile(context, ref, s, text),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _suggestionTile(BuildContext context, WidgetRef ref, Map<String, dynamic> s, TextTheme text) {
    final key = s['key'] as String;
    final cost = s['estimatedCostToday'];
    final currency = s['currency'] as String?;
    final watts = s['estimatedWatts'];
    final conf = (s['confidence'] as Map<String, dynamic>?)?['decision'];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AureonSpacing.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s['title'] as String? ?? 'Suggestion', style: text.titleSmall),
          Text(s['body'] as String? ?? '', style: text.labelMedium),
          const SizedBox(height: 2),
          Text([
            if (watts != null) '${watts}W',
            if (cost != null && currency != null) 'cost so far $currency $cost',
            if (conf is num) '${(conf * 100).round()}% confident',
          ].join(' · '), style: text.labelSmall?.copyWith(color: AureonGold.c400)),
          const SizedBox(height: AureonSpacing.xs),
          Row(children: [
            FilledButton(onPressed: () => _respond(context, ref, key, 'turn_off'), child: const Text('Turn Off')),
            const SizedBox(width: AureonSpacing.sm),
            OutlinedButton(onPressed: () => _respond(context, ref, key, 'keep_on'), child: const Text('Keep On')),
            const Spacer(),
            PopupMenuButton<String>(
              onSelected: (a) => _respond(context, ref, key, a),
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'ignore_today', child: Text('Ignore today')),
                PopupMenuItem(value: 'always_ignore', child: Text('Always ignore')),
                PopupMenuItem(value: 'enable_auto_pilot', child: Text('Enable Auto Pilot')),
              ],
            ),
          ]),
          const Divider(),
        ],
      ),
    );
  }
}
