import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../widgets/empty_state.dart';
import 'discover_devices_screen.dart';

/// A homeowner-friendly name for what a device IS — never its type slug or capability kinds.
String _friendlyType(Device d) {
  final t = d.supremeType.toLowerCase();
  final caps = d.capabilities;
  if (t.contains('dimmer') || caps.contains('brightness')) return caps.contains('color') ? 'Colour light' : 'Dimmable light';
  if (t.contains('thermostat') || caps.contains('temperature')) return 'Climate';
  if (t.contains('cover') || caps.contains('position')) return 'Blinds';
  if (t.contains('lock') || caps.contains('lock')) return 'Lock';
  if (t.contains('fan') || caps.contains('fan')) return 'Fan';
  if (t.contains('vacuum') || caps.contains('vacuum')) return 'Vacuum';
  if (t.contains('media') || caps.contains('media')) return 'Media';
  if (t.contains('sensor') || caps.contains('sensor')) return 'Sensor';
  if (t.contains('camera')) return 'Camera';
  if (t.contains('light')) return 'Light';
  if (caps.contains('onoff')) return caps.length == 1 ? 'Light' : 'Switch';
  return 'Device';
}

/// Device Manager (§ Device Manager) — mobile parity. Every device grouped by room with its live
/// state, type and capabilities, and the actions the backend supports today (rename, move room,
/// remove). Reuses the SDK's devices()/updateDevice()/deleteDevice() — no duplicate device system.
final _devicesProvider = FutureProvider<List<Device>>((ref) => ref.watch(clientProvider).devices());
/// Device Approval (§ Device Approval): the pending queue.
final _pendingProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).pendingDevices());

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
                _PendingApproval(rooms: rooms, onChanged: () => ref.invalidate(_devicesProvider)),
                if (list.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 40),
                    child: EmptyState(
                      icon: Icons.devices_other_outlined,
                      title: 'No devices yet',
                      hint: 'Supreme finds your lights, blinds, climate and more automatically — start a scan to bring your home online.',
                      actionLabel: 'Discover Devices',
                      onAction: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const DiscoverDevicesScreen())),
                    ),
                  ),
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

  /// A compact label/value list of a device's real facts; rows with no value are dropped.
  Widget _facts(BuildContext context, List<(String, String?)> rows) {
    final theme = Theme.of(context);
    final present = rows.where((r) => r.$2 != null && r.$2!.isNotEmpty).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final (label, value) in present)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 104, child: Text(label, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
            Expanded(child: Text(value!, style: theme.textTheme.labelMedium)),
          ]),
        ),
    ]);
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await ref.read(clientProvider).updateDevice(widget.device.id, name: _name.text.trim(), roomId: _roomId);
      ref.invalidate(_devicesProvider);
      _toast('Saved');
    } catch (e) { _toast('Failed: $e'); } finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _clone() async {
    setState(() => _busy = true);
    try {
      await ref.read(clientProvider).cloneDevice(widget.device.id);
      ref.invalidate(_devicesProvider);
      _toast('Cloned');
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
    // Resolve the backing driver → name + protocol from the registry (never hardcoded).
    final registry = ref.watch(driverRegistryProvider).valueOrNull ?? const [];
    Map<String, dynamic>? drv;
    for (final r in registry) {
      if (r['installedId'] == d.driverId || r['key'] == d.driverId) { drv = r; break; }
    }
    final protocols = ((drv?['protocols'] as List?) ?? const []).cast<String>();
    final scenes = ref.watch(scenesProvider).valueOrNull ?? const [];
    final sceneCount = scenes.where((s) => s.deviceIds.contains(d.id)).length;
    // Technical plumbing (driver / protocol / network) is for Installer & Developer mode only — a
    // homeowner never needs to see it (§ Homeowner Experience).
    final devMode = ref.watch(devModeProvider).valueOrNull ?? false;
    return Card(
      child: ExpansionTile(
        leading: Container(width: 10, height: 10, decoration: BoxDecoration(
          shape: BoxShape.circle, color: online ? AureonStatus.good : Theme.of(context).colorScheme.outlineVariant)),
        title: Text(d.name),
        subtitle: Text(devMode ? '${_friendlyType(d)} · ${d.supremeType} · ${d.capabilities.join(', ')}' : _friendlyType(d), style: Theme.of(context).textTheme.labelSmall),
        childrenPadding: const EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, AureonSpacing.md),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Real device facts — omit any field with no source (firmware/signal/battery/IP/MAC).
          _facts(context, [
            ('Type', devMode ? d.supremeType : _friendlyType(d)),
            ('Manufacturer', d.manufacturer),
            ('Model', d.model),
            ('Driver', devMode ? (drv?['name'] as String?) : null),
            ('Protocol', devMode && protocols.isNotEmpty ? protocols.first.toUpperCase() : null),
            ('IP address', devMode ? d.network?.ip : null),
            ('MAC', devMode ? d.network?.mac : null),
            ('Room', widget.roomName(d.roomId)),
            ('Status', online ? '${d.status} · live' : d.status),
            ('Capabilities', devMode && d.capabilities.isNotEmpty ? d.capabilities.join(', ') : null),
            ('In scenes', '$sceneCount'),
          ]),
          const SizedBox(height: 8),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _roomId,
            decoration: const InputDecoration(labelText: 'Room'),
            items: [for (final r in widget.rooms) DropdownMenuItem(value: r.id, child: Text(r.name))],
            onChanged: (v) => setState(() => _roomId = v),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
            OutlinedButton(onPressed: _busy ? null : _clone, child: const Text('Clone')),
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

/// Device Approval queue (§ Device Approval) — scan, then approve into a room or reject.
class _PendingApproval extends ConsumerWidget {
  const _PendingApproval({required this.rooms, required this.onChanged});
  final List<Room> rooms;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(_pendingProvider);
    final text = Theme.of(context).textTheme;
    final list = pending.valueOrNull ?? const [];

    Future<void> scan() async {
      final messenger = ScaffoldMessenger.of(context);
      try {
        await ref.read(clientProvider).scanForApproval();
        ref.invalidate(_pendingProvider);
      } catch (e) {
        messenger.showSnackBar(SnackBar(content: Text('Scan failed: $e')));
      }
    }

    if (list.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(onPressed: scan, icon: const Icon(Icons.wifi_find_outlined, size: 18), label: const Text('Scan for new devices')),
        ),
      );
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text('Pending approval · ${list.length}', style: text.titleSmall),
        TextButton(onPressed: scan, child: const Text('Rescan')),
      ]),
      Text('Approve devices you recognise; reject the rest.', style: text.labelSmall),
      for (final p in list) _PendingCard(device: p, rooms: rooms, onChanged: () { ref.invalidate(_pendingProvider); onChanged(); }),
      const Divider(height: 24),
    ]);
  }
}

class _PendingCard extends ConsumerStatefulWidget {
  const _PendingCard({required this.device, required this.rooms, required this.onChanged});
  final Map<String, dynamic> device;
  final List<Room> rooms;
  final VoidCallback onChanged;

  @override
  ConsumerState<_PendingCard> createState() => _PendingCardState();
}

class _PendingCardState extends ConsumerState<_PendingCard> {
  String? _roomId;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final d = widget.device;
    _roomId ??= widget.rooms.isNotEmpty ? widget.rooms.first.id : null;
    final caps = ((d['capabilities'] as List?) ?? const []).cast<String>();
    final text = Theme.of(context).textTheme;
    final messenger = ScaffoldMessenger.of(context);

    Future<void> act(Future<void> Function() fn) async {
      setState(() => _busy = true);
      try { await fn(); widget.onChanged(); }
      catch (e) { messenger.showSnackBar(SnackBar(content: Text('Failed: $e'))); if (mounted) setState(() => _busy = false); }
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.verified_user_outlined, size: 18),
            const SizedBox(width: 8),
            Expanded(child: Text(d['suggestedName'] as String? ?? 'Device', style: text.titleSmall)),
            const Chip(label: Text('Pending', style: TextStyle(fontSize: 10)), visualDensity: VisualDensity.compact),
          ]),
          // Homeowner-facing "new device" card: describe what it does, not how it connects.
          Text(caps.isEmpty ? 'New device' : caps.join(', '), style: text.labelSmall),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _roomId,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Approve into room'),
            items: [for (final r in widget.rooms) DropdownMenuItem(value: r.id, child: Text(r.name))],
            onChanged: (v) => setState(() => _roomId = v),
          ),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton(
              onPressed: _busy || _roomId == null ? null : () => act(() => ref.read(clientProvider).approvePendingDevice(d['id'] as String, roomId: _roomId!)),
              child: Text(_busy ? '…' : 'Approve'),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              style: OutlinedButton.styleFrom(foregroundColor: AureonStatus.critical),
              onPressed: _busy ? null : () => act(() => ref.read(clientProvider).rejectPendingDevice(d['id'] as String)),
              child: const Text('Reject'),
            ),
          ]),
        ]),
      ),
    );
  }
}
