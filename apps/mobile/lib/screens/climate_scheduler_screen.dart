import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// The full HVAC scheduler (§ HVAC Detail Page "Schedule") — mobile/tablet parity with
/// the web scheduler. One-time/daily/weekly events, each carrying a target temperature/
/// mode/fan speed; multiple events per device; enable/disable per event; copy-day; a
/// per-device holiday mode that suspends every event for that device. Every event here
/// is executed by SupremeOS's minute tick (§ "These schedules are executed by
/// SupremeOS, not CoolMaster") — this screen only talks to the same
/// /v1/climate/schedule endpoint the web scheduler uses, never the driver directly.
class ClimateSchedulerScreen extends ConsumerStatefulWidget {
  const ClimateSchedulerScreen({super.key, required this.device});
  final Device device;

  @override
  ConsumerState<ClimateSchedulerScreen> createState() => _ClimateSchedulerScreenState();
}

const _weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _modeLabels = {'heat': 'Heat', 'cool': 'Cool', 'auto': 'Auto', 'fan_only': 'Fan'};

String _fmtMinutes(int atMinutes) {
  final h = atMinutes ~/ 60;
  final m = atMinutes % 60;
  final period = h >= 12 ? 'PM' : 'AM';
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:${m.toString().padLeft(2, '0')} $period';
}

String _recurrenceSummary(Map<String, dynamic> e) {
  final recurrence = e['recurrence'] as String;
  if (recurrence == 'once') return (e['date'] as String?) ?? 'One-time';
  if (recurrence == 'daily') return 'Every day';
  final weekdays = ((e['weekdays'] as List?) ?? const []).cast<int>().toList()..sort();
  return weekdays.map((d) => _weekdayLabels[d]).join(', ');
}

class _ClimateSchedulerScreenState extends ConsumerState<ClimateSchedulerScreen> {
  List<Map<String, dynamic>> _events = [];
  List<String> _holidayDeviceIds = [];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final res = await ref.read(clientProvider).climateSchedule();
    setState(() {
      _events = ((res['events'] as List?) ?? const []).cast<Map<String, dynamic>>();
      _holidayDeviceIds = ((res['holidayDeviceIds'] as List?) ?? const []).cast<String>();
      _loaded = true;
    });
  }

  List<Map<String, dynamic>> get _deviceEvents {
    final list = _events.where((e) => e['deviceId'] == widget.device.id).toList();
    list.sort((a, b) => (a['atMinutes'] as int).compareTo(b['atMinutes'] as int));
    return list;
  }

  bool get _onHoliday => _holidayDeviceIds.contains(widget.device.id);

  Future<void> _persist(List<Map<String, dynamic>> events, List<String> holidayDeviceIds) async {
    final res = await ref.read(clientProvider).setClimateSchedule(events: events, holidayDeviceIds: holidayDeviceIds);
    setState(() {
      _events = ((res['events'] as List?) ?? const []).cast<Map<String, dynamic>>();
      _holidayDeviceIds = ((res['holidayDeviceIds'] as List?) ?? const []).cast<String>();
    });
  }

  Future<void> _toggleHoliday() async {
    final next = _onHoliday ? _holidayDeviceIds.where((id) => id != widget.device.id).toList() : [..._holidayDeviceIds, widget.device.id];
    await _persist(_events, next);
  }

  Future<void> _toggleEvent(Map<String, dynamic> e) async {
    await _persist(_events.map((x) => x['id'] == e['id'] ? {...x, 'enabled': !(x['enabled'] as bool)} : x).toList(), _holidayDeviceIds);
  }

  Future<void> _removeEvent(String id) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove event?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok == true) await _persist(_events.where((e) => e['id'] != id).toList(), _holidayDeviceIds);
  }

  Future<void> _editEvent([Map<String, dynamic>? existing]) async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _EventEditorSheet(device: widget.device, existing: existing),
    );
    if (result == null) return;
    final others = _events.where((e) => e['id'] != result['id']).toList();
    await _persist([...others, result], _holidayDeviceIds);
  }

  Future<void> _copyDay() async {
    final result = await showDialog<({int from, List<int> to})>(
      context: context,
      builder: (ctx) => const _CopyDayDialog(),
    );
    if (result == null || result.to.isEmpty) return;
    final next = _events.map((e) {
      if (e['deviceId'] != widget.device.id || e['recurrence'] != 'weekly') return e;
      final weekdays = ((e['weekdays'] as List?) ?? const []).cast<int>();
      if (!weekdays.contains(result.from)) return e;
      final merged = {...weekdays, ...result.to}.toList()..sort();
      return {...e, 'weekdays': merged};
    }).toList();
    await _persist(next, _holidayDeviceIds);
  }

  @override
  Widget build(BuildContext context) {
    final events = _deviceEvents;
    return Scaffold(
      appBar: AppBar(title: Text('Schedule · ${widget.device.name}')),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                Card(
                  child: SwitchListTile(
                    title: const Text('Holiday Mode'),
                    subtitle: const Text("Suspends every scheduled event for this unit until turned off — SupremeOS won't apply any schedule while it's on."),
                    value: _onHoliday,
                    activeThumbColor: AureonGold.c400,
                    onChanged: (_) => _toggleHoliday(),
                  ),
                ),
                const SizedBox(height: AureonSpacing.md),
                Row(children: [
                  const Expanded(child: Text('EVENTS', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600))),
                  TextButton(onPressed: events.any((e) => e['recurrence'] == 'weekly') ? _copyDay : null, child: const Text('Copy Day')),
                  const SizedBox(width: 8),
                  FilledButton.icon(onPressed: () => _editEvent(), icon: const Icon(Icons.add, size: 18), label: const Text('Add Event')),
                ]),
                const SizedBox(height: 8),
                if (events.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Text('No scheduled events yet — add one to let SupremeOS run this unit automatically.', style: TextStyle(color: AureonText.secondary)),
                  ),
                for (final e in events)
                  Card(
                    child: ListTile(
                      leading: Switch(value: e['enabled'] as bool, activeThumbColor: AureonGold.c400, onChanged: (_) => _toggleEvent(e)),
                      title: Text((e['label'] as String?)?.isNotEmpty == true ? e['label'] as String : '${_fmtMinutes(e['atMinutes'] as int)} · ${e['targetC']}°C'),
                      subtitle: Text('${_fmtMinutes(e['atMinutes'] as int)} · ${_recurrenceSummary(e)} · ${e['targetC']}°C · ${_modeLabels[e['mode']] ?? e['mode']}${(e['fanSpeed'] as String?)?.isNotEmpty == true ? ' · ${e['fanSpeed']}' : ''}'),
                      onTap: () => _editEvent(e),
                      trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () => _removeEvent(e['id'] as String)),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _EventEditorSheet extends StatefulWidget {
  const _EventEditorSheet({required this.device, this.existing});
  final Device device;
  final Map<String, dynamic>? existing;

  @override
  State<_EventEditorSheet> createState() => _EventEditorSheetState();
}

class _EventEditorSheetState extends State<_EventEditorSheet> {
  late String _recurrence;
  late String _date;
  late List<int> _weekdays;
  late TimeOfDay _time;
  late double _targetC;
  late String _mode;
  String? _fanSpeed;
  late bool _enabled;
  final _labelCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _recurrence = (e?['recurrence'] as String?) ?? 'daily';
    _date = (e?['date'] as String?) ?? DateTime.now().toIso8601String().substring(0, 10);
    _weekdays = ((e?['weekdays'] as List?)?.cast<int>()) ?? [1, 2, 3, 4, 5];
    final atMinutes = (e?['atMinutes'] as int?) ?? 7 * 60;
    _time = TimeOfDay(hour: atMinutes ~/ 60, minute: atMinutes % 60);
    _targetC = ((e?['targetC'] as num?) ?? 22).toDouble();
    _mode = (e?['mode'] as String?) ?? (widget.device.climateModes.contains('cool') ? 'cool' : (widget.device.climateModes.firstOrNull ?? 'cool'));
    _fanSpeed = e?['fanSpeed'] as String?;
    _enabled = (e?['enabled'] as bool?) ?? true;
    _labelCtrl.text = (e?['label'] as String?) ?? '';
  }

  void _save() {
    Navigator.of(context).pop({
      if (widget.existing?['id'] != null) 'id': widget.existing!['id'],
      'deviceId': widget.device.id,
      'enabled': _enabled,
      'recurrence': _recurrence,
      if (_recurrence == 'once') 'date': _date,
      if (_recurrence == 'weekly') 'weekdays': _weekdays,
      'atMinutes': _time.hour * 60 + _time.minute,
      'targetC': _targetC,
      'mode': _mode,
      if (_fanSpeed != null) 'fanSpeed': _fanSpeed,
      if (_labelCtrl.text.trim().isNotEmpty) 'label': _labelCtrl.text.trim(),
    });
  }

  @override
  Widget build(BuildContext context) {
    final modes = widget.device.climateModes;
    final fanSpeeds = widget.device.climateFanSpeeds;
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
      decoration: BoxDecoration(color: Theme.of(context).colorScheme.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(28))),
      padding: EdgeInsets.fromLTRB(20, 12, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Center(child: Container(width: 44, height: 5, margin: const EdgeInsets.only(bottom: 16), decoration: BoxDecoration(color: Theme.of(context).colorScheme.outlineVariant, borderRadius: BorderRadius.circular(3)))),
          Text(widget.existing == null ? 'New Event' : 'Edit Event', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 16),
          TextField(controller: _labelCtrl, decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'e.g. Morning comfort')),
          const SizedBox(height: 16),
          const Text('REPEATS', style: TextStyle(fontSize: 10.5, letterSpacing: 1.2, color: AureonText.secondary, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'once', label: Text('One-Time')),
              ButtonSegment(value: 'daily', label: Text('Daily')),
              ButtonSegment(value: 'weekly', label: Text('Weekly')),
            ],
            selected: {_recurrence},
            onSelectionChanged: (s) => setState(() => _recurrence = s.first),
          ),
          const SizedBox(height: 16),
          if (_recurrence == 'once')
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Date'),
              subtitle: Text(_date),
              trailing: const Icon(Icons.calendar_today_outlined),
              onTap: () async {
                final picked = await showDatePicker(context: context, initialDate: DateTime.parse(_date), firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 730)));
                if (picked != null) setState(() => _date = picked.toIso8601String().substring(0, 10));
              },
            ),
          if (_recurrence == 'weekly') ...[
            const Text('DAYS', style: TextStyle(fontSize: 10.5, letterSpacing: 1.2, color: AureonText.secondary, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, children: [
              for (var d = 0; d < 7; d++)
                FilterChip(
                  label: Text(_weekdayLabels[d]),
                  selected: _weekdays.contains(d),
                  selectedColor: AureonGold.c400,
                  onSelected: (sel) => setState(() => sel ? _weekdays.add(d) : _weekdays.remove(d)),
                ),
            ]),
            const SizedBox(height: 16),
          ],
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Time'),
            subtitle: Text(_time.format(context)),
            trailing: const Icon(Icons.access_time),
            onTap: () async {
              final picked = await showTimePicker(context: context, initialTime: _time);
              if (picked != null) setState(() => _time = picked);
            },
          ),
          const SizedBox(height: 8),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Temperature'),
            subtitle: Row(children: [
              IconButton(onPressed: () => setState(() => _targetC = (_targetC - 0.5).clamp(5, 35)), icon: const Icon(Icons.remove_circle_outline)),
              Text('${_targetC.toStringAsFixed(1)}°C', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              IconButton(onPressed: () => setState(() => _targetC = (_targetC + 0.5).clamp(5, 35)), icon: const Icon(Icons.add_circle_outline)),
            ]),
          ),
          const SizedBox(height: 8),
          const Text('MODE', style: TextStyle(fontSize: 10.5, letterSpacing: 1.2, color: AureonText.secondary, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Wrap(spacing: 6, children: [
            for (final m in modes) ChoiceChip(label: Text(_modeLabels[m] ?? m), selected: _mode == m, selectedColor: AureonGold.c400, onSelected: (_) => setState(() => _mode = m)),
          ]),
          if (fanSpeeds.isNotEmpty) ...[
            const SizedBox(height: 16),
            const Text('FAN SPEED', style: TextStyle(fontSize: 10.5, letterSpacing: 1.2, color: AureonText.secondary, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, children: [
              ChoiceChip(label: const Text('Unchanged'), selected: _fanSpeed == null, onSelected: (_) => setState(() => _fanSpeed = null)),
              for (final s in fanSpeeds) ChoiceChip(label: Text(s), selected: _fanSpeed == s, selectedColor: AureonGold.c400, onSelected: (_) => setState(() => _fanSpeed = s)),
            ]),
          ],
          const SizedBox(height: 8),
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Enabled'), value: _enabled, activeThumbColor: AureonGold.c400, onChanged: (v) => setState(() => _enabled = v)),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel'))),
            const SizedBox(width: 10),
            Expanded(flex: 2, child: FilledButton(onPressed: _recurrence == 'weekly' && _weekdays.isEmpty ? null : _save, child: const Text('Save Event'))),
          ]),
        ]),
      ),
    );
  }
}

class _CopyDayDialog extends StatefulWidget {
  const _CopyDayDialog();
  @override
  State<_CopyDayDialog> createState() => _CopyDayDialogState();
}

class _CopyDayDialogState extends State<_CopyDayDialog> {
  int _from = 1;
  final Set<int> _to = {};

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Copy Day'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Copy events from', style: TextStyle(fontSize: 11, color: AureonText.secondary)),
        const SizedBox(height: 6),
        Wrap(spacing: 6, children: [
          for (var d = 0; d < 7; d++) ChoiceChip(label: Text(_weekdayLabels[d]), selected: _from == d, selectedColor: AureonGold.c400, onSelected: (_) => setState(() => _from = d)),
        ]),
        const SizedBox(height: 14),
        const Text('To', style: TextStyle(fontSize: 11, color: AureonText.secondary)),
        const SizedBox(height: 6),
        Wrap(spacing: 6, children: [
          for (var d = 0; d < 7; d++)
            FilterChip(
              label: Text(_weekdayLabels[d]),
              selected: _to.contains(d),
              selectedColor: AureonGold.c400,
              onSelected: d == _from ? null : (sel) => setState(() => sel ? _to.add(d) : _to.remove(d)),
            ),
        ]),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _to.isEmpty ? null : () => Navigator.of(context).pop((from: _from, to: _to.toList())), child: const Text('Copy')),
      ],
    );
  }
}
