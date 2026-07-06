import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// Read-only automation node canvas (§10): a When → If → Then flow of trigger / condition
/// / action cards on a dotted grid, plus enable/run. Editing happens in AutomationEditor.
class AutomationCanvas extends ConsumerStatefulWidget {
  const AutomationCanvas({super.key, required this.automation});
  final AutomationSummary automation;

  @override
  ConsumerState<AutomationCanvas> createState() => _AutomationCanvasState();
}

class _AutomationCanvasState extends ConsumerState<AutomationCanvas> {
  late bool _enabled = widget.automation.enabled;

  @override
  Widget build(BuildContext context) {
    final a = widget.automation;
    return Scaffold(
      appBar: AppBar(
        title: Text(a.name),
        actions: [
          TextButton(
            onPressed: () {
              setState(() => _enabled = !_enabled);
              ref.read(clientProvider).setAutomationEnabled(a.id, _enabled);
            },
            child: Text(_enabled ? 'Enabled' : 'Off'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          AutomationFlow(triggers: a.triggers, conditions: a.conditions, actions: a.actions),
          const SizedBox(height: AureonSpacing.lg),
          FilledButton.icon(
            onPressed: () async {
              await ref.read(clientProvider).runAutomation(a.id);
              ref.invalidate(_runsProvider(a.id));
            },
            icon: const Icon(Icons.play_arrow),
            label: const Text('Run now'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
          ),
          const SizedBox(height: AureonSpacing.lg),
          _ActivityLog(automationId: a.id),
        ],
      ),
    );
  }
}

/// Recent execution traces for one automation (§ Automation Debugger).
final _runsProvider = FutureProvider.family<List<Map<String, dynamic>>, String>(
  (ref, id) => ref.watch(clientProvider).automationRuns(id),
);

class _ActivityLog extends ConsumerWidget {
  const _ActivityLog({required this.automationId});
  final String automationId;

  String _fmt(String? iso) {
    final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    return d == null ? '' : '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}:${d.second.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runs = ref.watch(_runsProvider(automationId));
    final text = Theme.of(context).textTheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text('Recent activity', style: text.titleSmall),
        IconButton(icon: const Icon(Icons.refresh, size: 18), onPressed: () => ref.invalidate(_runsProvider(automationId))),
      ]),
      runs.when(
        loading: () => const Padding(padding: EdgeInsets.all(8), child: Center(child: CircularProgressIndicator())),
        error: (e, _) => Text('Could not load activity\n$e', style: text.labelSmall),
        data: (list) => list.isEmpty
            ? Text('No runs yet. Trigger it or press “Run now”.', style: text.labelMedium)
            : Column(children: [
                for (final r in list) _runTile(context, r),
              ]),
      ),
    ]);
  }

  Widget _runTile(BuildContext context, Map<String, dynamic> r) {
    final text = Theme.of(context).textTheme;
    final ok = r['ok'] == true;
    final conditionsPassed = r['conditionsPassed'] == true;
    final color = ok ? AureonStatus.good : conditionsPassed ? AureonStatus.critical : Theme.of(context).colorScheme.onSurfaceVariant;
    final actions = ((r['actions'] as List?) ?? const []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.sm),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 5, right: 8), child: Container(width: 9, height: 9, decoration: BoxDecoration(shape: BoxShape.circle, color: color))),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${ok ? 'Ran' : conditionsPassed ? 'Failed' : 'Skipped'} · ${r['trigger']} · ${_fmt(r['startedAt'] as String?)} · ${r['durationMs']}ms', style: text.labelMedium?.copyWith(fontWeight: FontWeight.w600)),
            if (conditionsPassed != true && r['failedCondition'] != null)
              Text('Condition not met: ${r['failedCondition']}', style: text.labelSmall),
            for (final a in actions)
              Text('${a['ok'] == true ? '✓' : '✕'} ${a['summary']} · ${a['durationMs']}ms${a['error'] != null ? ' — ${a['error']}' : ''}',
                  style: text.labelSmall?.copyWith(color: a['ok'] == true ? null : AureonStatus.critical, fontFamily: 'monospace')),
          ])),
        ]),
      ),
    );
  }
}

/// The dotted-grid flow used by both the read-only canvas and the editor.
class AutomationFlow extends StatelessWidget {
  const AutomationFlow({
    super.key,
    required this.triggers,
    required this.conditions,
    required this.actions,
    this.onAdd,
    this.onTapNode,
  });

  final List<Map<String, dynamic>> triggers;
  final List<Map<String, dynamic>> conditions;
  final List<Map<String, dynamic>> actions;
  final void Function(String section)? onAdd;
  final void Function(String section, int index)? onTapNode;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        color: scheme.surface,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _section(context, 'When', 'triggers', [for (final t in triggers) _node(context, 'trigger', t['type'] as String, triggerTitle(t))]),
        _section(context, 'If', 'conditions', [for (final c in conditions) _node(context, 'condition', c['type'] as String, condTitle(c['type'] as String))]),
        _section(context, 'Then', 'actions', [for (final a in actions) _node(context, 'action', a['type'] as String, automationActionLabel(a['type'] as String))]),
      ]),
    );
  }

  Widget _section(BuildContext context, String label, String key, List<Widget> nodes) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 56, child: Padding(padding: const EdgeInsets.only(top: 8), child: Text(label.toUpperCase(), style: TextStyle(fontSize: 12, letterSpacing: 0.5, color: scheme.onSurface.withValues(alpha: 0.6))))),
        Expanded(child: Container(
          padding: const EdgeInsets.only(left: 16),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6), width: 2))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var i = 0; i < nodes.length; i++)
              Padding(padding: const EdgeInsets.only(bottom: 10), child: GestureDetector(onTap: onTapNode == null ? null : () => onTapNode!(key, i), child: nodes[i])),
            if (onAdd != null)
              OutlinedButton(onPressed: () => onAdd!(key), child: Text('+ Add ${label == 'When' ? 'Trigger' : label == 'If' ? 'Condition' : 'Action'}')),
          ]),
        )),
      ]),
    );
  }

  Widget _node(BuildContext context, String kind, String type, String title) {
    Color bg;
    if (kind == 'trigger') {
      bg = type == 'time' ? const Color(0xFF4A4A4A) : type == 'device_state' ? const Color(0xFF6F5EA8) : const Color(0xFFD98A3A);
    } else if (kind == 'condition') {
      bg = const Color(0xFF3A6EA5);
    } else {
      bg = const Color(0xFF1B1D24);
    }
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(16)),
      child: Row(children: [
        Container(width: 40, height: 40, alignment: Alignment.center, decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(12)), child: Icon(automationGlyph(type), color: Colors.white, size: 20)),
        const SizedBox(width: 12),
        Expanded(child: Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600))),
      ]),
    );
  }
}

// ── Shared labels/glyphs ──
IconData automationGlyph(String? type) => {
      'device_state': Icons.sensors,
      'time': Icons.schedule,
      'interval': Icons.repeat,
      'time_window': Icons.calendar_today,
      'device_command': Icons.tune,
      'scene_activate': Icons.auto_awesome,
      'notify': Icons.notifications,
      'delay': Icons.timer_outlined,
    }[type] ?? Icons.bolt;

String automationActionLabel(String? type) => {
      'device_command': 'Adjust Device',
      'scene_activate': 'Run Scene',
      'notify': 'Notify',
      'delay': 'Delay',
    }[type] ?? 'Action';

String condTitle(String type) => type == 'time_window' ? 'Time window' : 'Device state';

String triggerTitle(Map<String, dynamic> t) {
  switch (t['type']) {
    case 'time':
      return 'Time · ${t['at'] ?? ''}';
    case 'interval':
      return 'Every ${t['everyMinutes']}m';
    default:
      return 'Sensor · ${t['capability'] ?? ''} ${t['field'] ?? ''}'.trim();
  }
}
