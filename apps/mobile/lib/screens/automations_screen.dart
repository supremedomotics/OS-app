import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// The visual Automation Builder (§10): list automations with enable/run/delete,
/// and a compact builder that composes the Supreme DSL (a trigger + a device
/// action) without any YAML or backend concepts.
class AutomationsScreen extends ConsumerWidget {
  const AutomationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final automations = ref.watch(automationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Automations')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openBuilder(context, ref),
        icon: const Icon(Icons.add),
        label: const Text('New'),
      ),
      body: automations.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load automations\n$e')),
        data: (list) => list.isEmpty
            ? Center(
                child: Text('No automations yet — tap New',
                    style: Theme.of(context).textTheme.labelMedium),
              )
            : ListView.separated(
                padding: const EdgeInsets.all(AureonSpacing.lg),
                itemCount: list.length,
                separatorBuilder: (_, __) =>
                    const SizedBox(height: AureonSpacing.sm),
                itemBuilder: (context, i) {
                  final a = list[i];
                  return Card(
                    child: ListTile(
                      title: Text(a.name),
                      subtitle: Text(
                          '${a.triggerCount} trigger(s) · ${a.actionCount} action(s)'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: const Icon(Icons.play_arrow),
                            onPressed: () async {
                              await ref
                                  .read(clientProvider)
                                  .runAutomation(a.id);
                            },
                          ),
                          Switch(
                            value: a.enabled,
                            onChanged: (v) async {
                              await ref
                                  .read(clientProvider)
                                  .setAutomationEnabled(a.id, v);
                              ref.invalidate(automationsProvider);
                            },
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () async {
                              await ref
                                  .read(clientProvider)
                                  .deleteAutomation(a.id);
                              ref.invalidate(automationsProvider);
                            },
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }

  Future<void> _openBuilder(BuildContext context, WidgetRef ref) async {
    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _BuilderSheet(),
    );
    if (created == true) ref.invalidate(automationsProvider);
  }
}

/// Compact builder: name + a trigger (a device turning on/off, or a time) + a
/// device action. Emits the Supreme automation DSL.
class _BuilderSheet extends ConsumerStatefulWidget {
  const _BuilderSheet();

  @override
  ConsumerState<_BuilderSheet> createState() => _BuilderSheetState();
}

class _BuilderSheetState extends ConsumerState<_BuilderSheet> {
  final _name = TextEditingController();
  String _triggerType = 'device_state';
  String? _triggerDeviceId;
  bool _triggerOn = true;
  final _time = TextEditingController(text: '23:00');
  String? _actionDeviceId;
  bool _actionOn = false;
  bool _busy = false;

  Map<String, dynamic> _trigger() {
    if (_triggerType == 'time') {
      return {'type': 'time', 'at': _time.text.trim(), 'days': <int>[]};
    }
    return {
      'type': 'device_state',
      'deviceId': _triggerDeviceId,
      'capability': 'onoff',
      'field': 'on',
      'op': 'eq',
      'value': _triggerOn,
    };
  }

  Future<void> _save() async {
    if (_actionDeviceId == null) return;
    if (_triggerType == 'device_state' && _triggerDeviceId == null) return;
    setState(() => _busy = true);
    try {
      await ref.read(clientProvider).createAutomation({
        'name':
            _name.text.trim().isEmpty ? 'New Automation' : _name.text.trim(),
        'triggers': [_trigger()],
        'actions': [
          {
            'type': 'device_command',
            'deviceId': _actionDeviceId,
            'command': {
              'capability': 'onoff',
              'action': _actionOn ? 'on' : 'off'
            },
          },
        ],
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (_) {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(allDevicesProvider);
    return Padding(
      padding: EdgeInsets.only(
        left: AureonSpacing.lg,
        right: AureonSpacing.lg,
        top: AureonSpacing.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + AureonSpacing.lg,
      ),
      child: devices.when(
        loading: () => const SizedBox(
            height: 120, child: Center(child: CircularProgressIndicator())),
        error: (e, _) => Text('Could not load devices: $e'),
        data: (list) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('New automation',
                style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AureonSpacing.md),
            TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: AureonSpacing.md),
            Text('When', style: Theme.of(context).textTheme.labelMedium),
            Row(
              children: [
                ChoiceChip(
                  label: const Text('A device changes'),
                  selected: _triggerType == 'device_state',
                  onSelected: (_) =>
                      setState(() => _triggerType = 'device_state'),
                ),
                const SizedBox(width: AureonSpacing.sm),
                ChoiceChip(
                  label: const Text('At a time'),
                  selected: _triggerType == 'time',
                  onSelected: (_) => setState(() => _triggerType = 'time'),
                ),
              ],
            ),
            if (_triggerType == 'device_state') ...[
              _deviceDropdown(
                  list,
                  _triggerDeviceId,
                  (v) => setState(() => _triggerDeviceId = v),
                  'Trigger device'),
              SwitchListTile(
                title: const Text('turns on'),
                value: _triggerOn,
                onChanged: (v) => setState(() => _triggerOn = v),
              ),
            ] else
              TextField(
                  controller: _time,
                  decoration: const InputDecoration(labelText: 'Time (HH:MM)')),
            const SizedBox(height: AureonSpacing.md),
            Text('Do', style: Theme.of(context).textTheme.labelMedium),
            _deviceDropdown(list, _actionDeviceId,
                (v) => setState(() => _actionDeviceId = v), 'Action device'),
            SwitchListTile(
              title: Text('turn ${_actionOn ? "on" : "off"}'),
              value: _actionOn,
              onChanged: (v) => setState(() => _actionOn = v),
            ),
            const SizedBox(height: AureonSpacing.md),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Create automation'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _deviceDropdown(List<Device> devices, String? value,
      ValueChanged<String?> onChanged, String label) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final d in devices)
          DropdownMenuItem(value: d.id, child: Text(d.name)),
      ],
      onChanged: onChanged,
    );
  }
}
