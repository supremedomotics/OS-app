import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../device_tile_spec.dart';
import '../providers.dart';
import '../room_categories.dart';
import '../usage.dart';
import 'device_detail.dart';
import 'device_sheet.dart';

/// The device list for a single non-lighting category (Media, Curtains, Climate, …). Every tile:
/// tap toggles on/off (slidable ones) or opens its sheet (everything else), drag sets the level
/// live, and a chevron opens the full detail. Lighting has its own richer page
/// ([RoomLightingScreen](room_lighting_screen.dart)).
///
/// Remove device (§ Room detail): a non-slidable tile (switch/sensor/lock) left-swipes to reveal
/// Remove, the standard mobile list-delete gesture. A slidable tile (dimmer/cover) already uses
/// horizontal drag on the same axis to set brightness/position, so it gets a small delete button
/// alongside instead rather than a competing swipe gesture.
class CategoryDeviceListScreen extends ConsumerStatefulWidget {
  const CategoryDeviceListScreen({super.key, required this.roomName, required this.category});

  final String roomName;
  final Category category;

  @override
  ConsumerState<CategoryDeviceListScreen> createState() => _CategoryDeviceListScreenState();
}

class _CategoryDeviceListScreenState extends ConsumerState<CategoryDeviceListScreen> {
  final List<Device> _devices = [];

  @override
  void initState() {
    super.initState();
    _devices.addAll(widget.category.devices);
  }

  Future<void> _toggle(Device d, TileSpec spec) async {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    ref.read(usageProvider.notifier).record('device', d.id);
    final next = !spec.on;
    if (spec.kind == 'position') {
      apply(d.id, 'position', {'kind': 'position', 'position': next ? 100 : 0, 'moving': false});
      await client.command(d.id, {'capability': 'position', 'action': next ? 'open' : 'close'});
    } else {
      apply(d.id, 'onoff', {'kind': 'onoff', 'on': next});
      await client.command(d.id, {'capability': 'onoff', 'action': 'toggle'});
    }
  }

  Future<void> _drag(Device d, double v) async {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final val = (v * 100).round();
    apply(d.id, 'position', {'kind': 'position', 'position': val, 'moving': false});
    await client.command(d.id, {'capability': 'position', 'action': 'set', 'position': val});
  }

  Future<void> _open(Device d) async {
    ref.read(usageProvider.notifier).record('device', d.id);
    if (d.capabilities.contains('brightness') || d.capabilities.contains('color')) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => DeviceDetailScreen(device: d)));
    } else {
      await showDeviceSheet(context, d);
    }
  }

  Future<bool> _confirmRemove(Device d) => confirmRemoveDevice(context, d.name);

  Future<void> _remove(Device d) async {
    try {
      await ref.read(clientProvider).deleteDevice(d.id);
      if (!mounted) return;
      setState(() => _devices.removeWhere((x) => x.id == d.id));
    } catch (e) {
      if (!mounted) return;
      // The Dismissible has already animated the tile away — put it back rather than leave
      // the list silently missing a device the removal actually failed for.
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not remove ${d.name}: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(liveStatesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(widget.category.def.label)),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          for (final d in _devices)
            Padding(
              padding: const EdgeInsets.only(bottom: AureonSpacing.md),
              child: Builder(builder: (_) {
                final spec = tileSpec(d, mergedDeviceState(d, live));
                final tile = DeviceControlTile(
                  icon: spec.icon,
                  name: d.name,
                  valueLabel: spec.value,
                  fill: spec.fill,
                  on: spec.on,
                  slidable: spec.slidable,
                  onChanged: spec.slidable ? (v) => _drag(d, v) : null,
                  onToggle: spec.slidable ? () => _toggle(d, spec) : null,
                  onTap: spec.slidable ? null : () => _open(d),
                  onOpenDetail: spec.slidable ? () => _open(d) : null,
                );
                if (spec.slidable) {
                  return Row(children: [
                    Expanded(child: tile),
                    const SizedBox(width: AureonSpacing.sm),
                    IconButton(
                      onPressed: () async { if (await _confirmRemove(d)) await _remove(d); },
                      icon: const Icon(Icons.delete_outline),
                      color: Theme.of(context).colorScheme.error,
                      tooltip: 'Remove ${d.name}',
                    ),
                  ]);
                }
                return Dismissible(
                  key: ValueKey(d.id),
                  direction: DismissDirection.endToStart,
                  confirmDismiss: (_) => _confirmRemove(d),
                  onDismissed: (_) => _remove(d),
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.lg),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.error,
                      borderRadius: BorderRadius.circular(AureonRadius.lg),
                    ),
                    child: const Icon(Icons.delete_outline, color: Colors.white),
                  ),
                  child: tile,
                );
              }),
            ),
        ],
      ),
    );
  }
}
