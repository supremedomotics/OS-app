import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// Device Manager (§ Device Manager) — mobile parity. Every device grouped by room with its live
/// state, type and capabilities, and the actions the backend supports today (rename, move room,
/// remove). Reuses the SDK's devices()/updateDevice()/deleteDevice() — no duplicate device system.
final _devicesProvider = FutureProvider<List<Device>>((ref) => ref.watch(clientProvider).devices());

class DeviceManagerScreen extends ConsumerWidget {
  const DeviceManagerScreen({super.key});

  static bool _online(Device d) => d.state.isNotEmpty;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(_devicesProvider);
    final home = ref.watch(homeProvider).valueOrNull;
    final rooms = home?.rooms ?? const [];
    String roomName(String? id) {
      for (final r in rooms) { if (r.id == id) return r.name; }
      return 'Unassigned';
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Devices')),
      body: devices.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load devices\n$e', textAlign: TextAlign.center)),
        data: (list) {
          final groups = <String, List<Device>>{};
          for (final d in list) { (groups[roomName(d.roomId)] ??= []).add(d); }
          final keys = groups.keys.toList()..sort();
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_devicesProvider),
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                Text('${list.length} devices · ${list.where(_online).length} online', style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: AureonSpacing.sm),
                if (list.isEmpty)
                  Padding(padding: const EdgeInsets.all(20), child: Text('No devices yet — use Discover Devices to add some.', style: Theme.of(context).textTheme.labelMedium)),
                for (final k in keys) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
                    child: Text('$k · ${groups[k]!.length}', style: Theme.of(context).textTheme.titleSmall),
                  ),
                  for (final d in groups[k]!) _DeviceTile(device: d, rooms: rooms, roomName: roomName),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

class _DeviceTile extends ConsumerStatefulWidget {
  const _DeviceTile({required this.device, required this.rooms, required this.roomName});
  final Device device;
  final List<Room> rooms;
  final String Function(String?) roomName;

  @override
  ConsumerState<_DeviceTile> createState() => _DeviceTileState();
}

class _DeviceTileState extends ConsumerState<_DeviceTile> {
  late final TextEditingController _name = TextEditingController(text: widget.device.name);
  late String? _roomId = widget.device.roomId;
  bool _busy = false;

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  void _toast(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await ref.read(clientProvider).updateDevice(widget.device.id, name: _name.text.trim(), roomId: _roomId);
      ref.invalidate(_devicesProvider);
      _toast('Saved');
    } catch (e) { _toast('Failed: $e'); } finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _remove() async {
    final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      title: Text('Remove ${widget.device.name}?'),
      content: const Text('This also drops its bindings.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Remove')),
      ],
    ));
    if (ok != true) return;
    setState(() => _busy = true);
    try { await ref.read(clientProvider).deleteDevice(widget.device.id); ref.invalidate(_devicesProvider); }
    catch (e) { _toast('Failed: $e'); if (mounted) setState(() => _busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.device;
    final online = d.state.isNotEmpty;
    return Card(
      child: ExpansionTile(
        leading: Container(width: 10, height: 10, decoration: BoxDecoration(
          shape: BoxShape.circle, color: online ? AureonStatus.good : Theme.of(context).colorScheme.outlineVariant)),
        title: Text(d.name),
        subtitle: Text('${d.supremeType} · ${d.capabilities.join(', ')}', style: Theme.of(context).textTheme.labelSmall),
        childrenPadding: const EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, AureonSpacing.md),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _roomId,
            decoration: const InputDecoration(labelText: 'Room'),
            items: [for (final r in widget.rooms) DropdownMenuItem(value: r.id, child: Text(r.name))],
            onChanged: (v) => setState(() => _roomId = v),
          ),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
            const SizedBox(width: 8),
            OutlinedButton(
              style: OutlinedButton.styleFrom(foregroundColor: AureonStatus.critical),
              onPressed: _busy ? null : _remove,
              child: const Text('Remove'),
            ),
          ]),
        ],
      ),
    );
  }
}
