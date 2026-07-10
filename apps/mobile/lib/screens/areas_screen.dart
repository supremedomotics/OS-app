import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../errors.dart';
import '../providers.dart';
import 'discover_devices_screen.dart';

/// Areas (§ Navigation — device-centric) — mobile parity with the web page. The home's spatial map:
/// rooms grouped by their location hierarchy (Building › Floor › Area) with live device counts.
/// Tapping a room edits its location inline via updateRoom — the surface that makes room relocation
/// discoverable. A homeowner thinks in places, never protocols.
class AreasScreen extends ConsumerWidget {
  const AreasScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    final devices = ref.watch(allDevicesProvider).valueOrNull ?? const <Device>[];
    final counts = <String, int>{};
    for (final d in devices) {
      if (d.roomId != null) counts[d.roomId!] = (counts[d.roomId!] ?? 0) + 1;
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Areas')),
      body: home.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(friendlyError(e, 'Could not load your areas.'), textAlign: TextAlign.center)),
        data: (h) {
          final rooms = h.rooms;
          if (rooms.isEmpty) {
            return Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text('No rooms yet.', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                FilledButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const DiscoverDevicesScreen())),
                  child: const Text('Discover Devices'),
                ),
              ]),
            );
          }
          // Group by Building → Floor. No-building rooms fall under "Home".
          final buildings = <String, List<Room>>{};
          for (final r in rooms) {
            (buildings[(r.building?.isNotEmpty ?? false) ? r.building! : 'Home'] ??= []).add(r);
          }
          final names = buildings.keys.toList()
            ..sort((a, b) => a == 'Home' ? -1 : b == 'Home' ? 1 : a.compareTo(b));

          return RefreshIndicator(
            onRefresh: () async { ref.invalidate(homeProvider); ref.invalidate(allDevicesProvider); },
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AureonSpacing.md, AureonSpacing.md, AureonSpacing.md, AureonSpacing.xxl),
              children: [
                Text('Your home organised by building, floor and area — where every device lives.',
                    style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: AureonSpacing.md),
                for (final bName in names) ...[
                  _buildingHeader(context, bName, buildings[bName]!, counts),
                  for (final f in (buildings[bName]!.map((r) => r.floor).toSet().toList()..sort())) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 8, bottom: 4),
                      child: Text('FLOOR $f', style: Theme.of(context).textTheme.labelSmall?.copyWith(letterSpacing: 1.2)),
                    ),
                    for (final r in buildings[bName]!.where((r) => r.floor == f))
                      _RoomTile(room: r, count: counts[r.id] ?? 0),
                  ],
                  const SizedBox(height: AureonSpacing.md),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildingHeader(BuildContext context, String name, List<Room> rooms, Map<String, int> counts) {
    final devCount = rooms.fold<int>(0, (n, r) => n + (counts[r.id] ?? 0));
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(name, style: Theme.of(context).textTheme.titleMedium),
        Text('${rooms.length} room${rooms.length == 1 ? '' : 's'} · $devCount device${devCount == 1 ? '' : 's'}',
            style: Theme.of(context).textTheme.labelSmall),
      ]),
    );
  }
}

class _RoomTile extends ConsumerWidget {
  const _RoomTile({required this.room, required this.count});
  final Room room;
  final int count;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Card(
      child: ListTile(
        title: Text(room.name),
        subtitle: Row(children: [
          if (room.area != null && room.area!.isNotEmpty) ...[
            Chip(label: Text(room.area!, style: const TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact),
            const SizedBox(width: 6),
          ],
          Text(room.areaType, style: Theme.of(context).textTheme.labelSmall),
        ]),
        trailing: Text('$count device${count == 1 ? '' : 's'}', style: Theme.of(context).textTheme.labelSmall),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          showDragHandle: true,
          builder: (_) => _RoomLocationSheet(room: room, deviceCount: count),
        ),
      ),
    );
  }
}

/// Inline location editor — name / building / floor / area / type, saved via updateRoom.
/// Also the delete-room entry point (mobile parity with the web Rooms screen).
class _RoomLocationSheet extends ConsumerStatefulWidget {
  const _RoomLocationSheet({required this.room, required this.deviceCount});
  final Room room;
  final int deviceCount;

  @override
  ConsumerState<_RoomLocationSheet> createState() => _RoomLocationSheetState();
}

class _RoomLocationSheetState extends ConsumerState<_RoomLocationSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.room.name);
  late final TextEditingController _building = TextEditingController(text: widget.room.building ?? '');
  late final TextEditingController _floor = TextEditingController(text: '${widget.room.floor}');
  late final TextEditingController _area = TextEditingController(text: widget.room.area ?? '');
  late String _areaType = widget.room.areaType;
  bool _busy = false;
  String? _err;

  static const _types = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'outdoor', 'utility', 'hallway', 'other'];

  @override
  void dispose() { _name.dispose(); _building.dispose(); _floor.dispose(); _area.dispose(); super.dispose(); }

  Future<void> _save() async {
    setState(() { _busy = true; _err = null; });
    try {
      await ref.read(clientProvider).updateRoom(
            widget.room.id,
            name: _name.text.trim().isEmpty ? widget.room.name : _name.text.trim(),
            building: _building.text.trim().isEmpty ? null : _building.text.trim(),
            floor: int.tryParse(_floor.text.trim()) ?? 0,
            area: _area.text.trim().isEmpty ? null : _area.text.trim(),
            areaType: _areaType,
          );
      ref.invalidate(homeProvider);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() { _err = friendlyError(e, 'Could not save. Please try again.'); _busy = false; });
    }
  }

  Future<void> _delete() async {
    final warn = widget.deviceCount > 0
        ? ' Its ${widget.deviceCount} device${widget.deviceCount == 1 ? '' : 's'} will become unassigned.'
        : '';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Delete "${widget.room.name}"?'),
        content: Text('This cannot be undone.$warn'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() { _busy = true; _err = null; });
    try {
      await ref.read(clientProvider).deleteRoom(widget.room.id);
      ref.invalidate(homeProvider);
      ref.invalidate(allDevicesProvider);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() { _err = friendlyError(e, 'Could not delete the room. Please try again.'); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, MediaQuery.viewInsetsOf(context).bottom + AureonSpacing.lg),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Edit location', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 12),
        TextField(controller: _name, decoration: const InputDecoration(labelText: 'Room')),
        const SizedBox(height: 8),
        TextField(controller: _building, decoration: const InputDecoration(labelText: 'Building (optional)')),
        const SizedBox(height: 8),
        TextField(controller: _floor, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Floor')),
        const SizedBox(height: 8),
        TextField(controller: _area, decoration: const InputDecoration(labelText: 'Area (optional)')),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: _areaType,
          decoration: const InputDecoration(labelText: 'Type'),
          items: [for (final t in _types) DropdownMenuItem(value: t, child: Text(t))],
          onChanged: (v) => setState(() => _areaType = v ?? _areaType),
        ),
        const SizedBox(height: 12),
        FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Saving…' : 'Save location')),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _busy ? null : _delete,
          style: TextButton.styleFrom(foregroundColor: AureonStatus.critical),
          child: const Text('Delete room'),
        ),
        if (_err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_err!, style: const TextStyle(color: AureonStatus.critical))),
      ]),
    );
  }
}
