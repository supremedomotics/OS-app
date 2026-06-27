import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'automation_canvas.dart';

/// A draggable palette block.
class _Block {
  const _Block(this.section, this.type, this.label);
  final String section; // triggers | conditions | actions
  final String type;
  final String label;
}

const _palette = <_Block>[
  _Block('triggers', 'time', 'Time'),
  _Block('triggers', 'device_state', 'Device'),
  _Block('conditions', 'device_state', 'Device is'),
  _Block('actions', 'device_command', 'Adjust Device'),
  _Block('actions', 'scene_activate', 'Run Scene'),
  _Block('actions', 'notify', 'Notify'),
  _Block('actions', 'delay', 'Delay'),
];

/// Full drag-and-drop automation editor (§10): drag blocks from the palette onto the
/// When / If / Then drop zones, tap a node to configure it, then Save → the Supreme DSL.
class AutomationEditor extends ConsumerStatefulWidget {
  const AutomationEditor({super.key});

  @override
  ConsumerState<AutomationEditor> createState() => _AutomationEditorState();
}

class _AutomationEditorState extends ConsumerState<AutomationEditor> {
  final _name = TextEditingController(text: 'New automation');
  final _nodes = <String, List<Map<String, dynamic>>>{'triggers': [], 'conditions': [], 'actions': []};
  bool _busy = false;

  void _add(String section, String type) {
    final node = _defaultNode(type);
    setState(() => _nodes[section]!.add(node));
    _configure(section, _nodes[section]!.length - 1);
  }

  Map<String, dynamic> _defaultNode(String type) {
    switch (type) {
      case 'time':
        return {'type': 'time', 'at': '07:00', 'days': <int>[]};
      case 'device_state':
        return {'type': 'device_state', 'deviceId': null, 'capability': 'onoff', 'field': 'on', 'op': 'eq', 'value': true};
      case 'device_command':
        return {'type': 'device_command', 'deviceId': null, 'command': {'capability': 'onoff', 'action': 'on'}};
      case 'scene_activate':
        return {'type': 'scene_activate', 'sceneId': null};
      case 'notify':
        return {'type': 'notify', 'level': 'info', 'title': 'Alert', 'body': ''};
      case 'delay':
        return {'type': 'delay', 'ms': 5000};
      default:
        return {'type': type};
    }
  }

  Future<void> _configure(String section, int index) async {
    final node = _nodes[section]![index];
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _ConfigSheet(node: node, onChanged: (n) => setState(() => _nodes[section]![index] = n)),
    );
    setState(() {});
  }

  Future<void> _save() async {
    if (_nodes['triggers']!.isEmpty || _nodes['actions']!.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Add at least one trigger and one action')));
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(clientProvider).createAutomation({
        'name': _name.text.trim().isEmpty ? 'New automation' : _name.text.trim(),
        'triggers': _nodes['triggers'],
        'conditions': _nodes['conditions'],
        'actions': _nodes['actions'],
      });
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('New automation'),
        actions: [TextButton(onPressed: _busy ? null : _save, child: const Text('Save'))],
      ),
      body: Column(children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(AureonSpacing.lg),
            children: [
              TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
              const SizedBox(height: AureonSpacing.md),
              for (final s in const [['When', 'triggers'], ['If', 'conditions'], ['Then', 'actions']])
                _dropZone(s[0], s[1], scheme),
            ],
          ),
        ),
        // Palette
        Container(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
          decoration: BoxDecoration(color: scheme.surface, border: Border(top: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.4)))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('Drag a block onto a zone', style: Theme.of(context).textTheme.labelMedium),
            const SizedBox(height: 8),
            SizedBox(
              height: 44,
              child: ListView(scrollDirection: Axis.horizontal, children: [
                for (final b in _palette)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Draggable<_Block>(
                      data: b,
                      feedback: _chip(b, scheme, dragging: true),
                      childWhenDragging: Opacity(opacity: 0.4, child: _chip(b, scheme)),
                      child: GestureDetector(onTap: () => _add(b.section, b.type), child: _chip(b, scheme)),
                    ),
                  ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  }

  Widget _chip(_Block b, ColorScheme scheme, {bool dragging = false}) {
    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: dragging ? scheme.primary : scheme.surfaceContainerHighest.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(14), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(automationGlyph(b.type), size: 16, color: dragging ? scheme.onPrimary : scheme.onSurface),
          const SizedBox(width: 6),
          Text(b.label, style: TextStyle(fontWeight: FontWeight.w600, color: dragging ? scheme.onPrimary : scheme.onSurface)),
        ]),
      ),
    );
  }

  Widget _dropZone(String label, String key, ColorScheme scheme) {
    final nodes = _nodes[key]!;
    return DragTarget<_Block>(
      onWillAcceptWithDetails: (d) => d.data.section == key,
      onAcceptWithDetails: (d) => _add(key, d.data.type),
      builder: (context, candidate, _) {
        final hot = candidate.isNotEmpty;
        return Container(
          margin: const EdgeInsets.only(bottom: 14),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            color: hot ? scheme.primary.withValues(alpha: 0.08) : scheme.surface,
            border: Border.all(color: hot ? scheme.primary : scheme.outlineVariant.withValues(alpha: 0.4), width: hot ? 2 : 1),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label.toUpperCase(), style: TextStyle(fontSize: 12, letterSpacing: 0.5, color: scheme.onSurface.withValues(alpha: 0.6))),
            const SizedBox(height: 8),
            if (nodes.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('Drop a block here', style: Theme.of(context).textTheme.labelMedium)),
            for (var i = 0; i < nodes.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: GestureDetector(
                  onTap: () => _configure(key, i),
                  child: Row(children: [
                    Expanded(child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(14)),
                      child: Row(children: [
                        Icon(automationGlyph(nodes[i]['type'] as String), size: 18),
                        const SizedBox(width: 10),
                        Expanded(child: Text(_nodeLabel(nodes[i]), style: const TextStyle(fontWeight: FontWeight.w600))),
                      ]),
                    )),
                    IconButton(icon: const Icon(Icons.close, size: 18), onPressed: () => setState(() => nodes.removeAt(i))),
                  ]),
                ),
              ),
          ]),
        );
      },
    );
  }

  String _nodeLabel(Map<String, dynamic> n) {
    final type = n['type'] as String;
    if (type == 'time') return 'Time · ${n['at']}';
    if (type == 'delay') return 'Delay · ${((n['ms'] as int) / 1000).round()}s';
    if (type == 'device_command' || type == 'device_state') return n['deviceId'] == null ? automationActionLabel(type) : '${automationActionLabel(type)} (set)';
    return automationActionLabel(type);
  }
}

/// Per-node config sheet — picks the device/scene/time/etc for a node.
class _ConfigSheet extends ConsumerStatefulWidget {
  const _ConfigSheet({required this.node, required this.onChanged});
  final Map<String, dynamic> node;
  final void Function(Map<String, dynamic>) onChanged;

  @override
  ConsumerState<_ConfigSheet> createState() => _ConfigSheetState();
}

class _ConfigSheetState extends ConsumerState<_ConfigSheet> {
  final Map<String, dynamic> _n = {};

  @override
  void initState() {
    super.initState();
    _n.addAll(widget.node);
  }

  void _apply() {
    widget.onChanged(_n);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final type = _n['type'] as String;
    return Padding(
      padding: EdgeInsets.only(left: 20, right: 20, top: 18, bottom: MediaQuery.of(context).viewInsets.bottom + 24),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(automationActionLabel(type), style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 16),
        ..._fields(type),
        const SizedBox(height: 16),
        SizedBox(width: double.infinity, child: FilledButton(onPressed: _apply, child: const Text('Done'))),
      ]),
    );
  }

  List<Widget> _fields(String type) {
    switch (type) {
      case 'time':
        return [
          ListTile(
            title: Text('At ${_n['at']}'),
            trailing: const Icon(Icons.schedule),
            onTap: () async {
              final parts = (_n['at'] as String).split(':');
              final picked = await showTimePicker(context: context, initialTime: TimeOfDay(hour: int.tryParse(parts[0]) ?? 7, minute: int.tryParse(parts.length > 1 ? parts[1] : '0') ?? 0));
              if (picked != null) setState(() => _n['at'] = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
            },
          ),
        ];
      case 'delay':
        return [
          Text('Delay: ${((_n['ms'] as int) / 1000).round()}s'),
          Slider(value: ((_n['ms'] as int) / 1000).toDouble().clamp(1, 60), min: 1, max: 60, onChanged: (v) => setState(() => _n['ms'] = (v * 1000).round())),
        ];
      case 'notify':
        return [
          TextFormField(initialValue: _n['title'] as String?, decoration: const InputDecoration(labelText: 'Title'), onChanged: (v) => _n['title'] = v),
          TextFormField(initialValue: _n['body'] as String?, decoration: const InputDecoration(labelText: 'Message'), onChanged: (v) => _n['body'] = v),
        ];
      case 'scene_activate':
        final scenes = ref.watch(scenesProvider);
        return [
          scenes.maybeWhen(
            data: (list) => DropdownButtonFormField<String>(
              initialValue: _n['sceneId'] as String?,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Scene'),
              items: [for (final s in list) DropdownMenuItem(value: s.id, child: Text(s.name))],
              onChanged: (v) => setState(() => _n['sceneId'] = v),
            ),
            orElse: () => const LinearProgressIndicator(),
          ),
        ];
      default: // device_state / device_command
        final devices = ref.watch(allDevicesProvider);
        final on = type == 'device_command' ? (_n['command'] as Map)['action'] == 'on' : _n['value'] == true;
        return [
          devices.maybeWhen(
            data: (list) => DropdownButtonFormField<String>(
              initialValue: _n['deviceId'] as String?,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Device'),
              items: [for (final d in list) DropdownMenuItem(value: d.id, child: Text(d.name))],
              onChanged: (v) => setState(() => _n['deviceId'] = v),
            ),
            orElse: () => const LinearProgressIndicator(),
          ),
          SwitchListTile(
            title: Text(type == 'device_command' ? 'Turn on' : 'Is on'),
            value: on,
            onChanged: (v) => setState(() {
              if (type == 'device_command') {
                _n['command'] = {'capability': 'onoff', 'action': v ? 'on' : 'off'};
              } else {
                _n['value'] = v;
              }
            }),
          ),
        ];
    }
  }
}
