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
class CategoryDeviceListScreen extends ConsumerWidget {
  const CategoryDeviceListScreen({super.key, required this.roomName, required this.category});

  final String roomName;
  final Category category;

  Future<void> _toggle(WidgetRef ref, Device d, TileSpec spec) async {
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

  Future<void> _drag(WidgetRef ref, Device d, double v) async {
    final client = ref.read(clientProvider);
    final apply = ref.read(liveStatesProvider.notifier).apply;
    final val = (v * 100).round();
    apply(d.id, 'position', {'kind': 'position', 'position': val, 'moving': false});
    await client.command(d.id, {'capability': 'position', 'action': 'set', 'position': val});
  }

  Future<void> _open(BuildContext context, WidgetRef ref, Device d) async {
    ref.read(usageProvider.notifier).record('device', d.id);
    if (d.capabilities.contains('brightness') || d.capabilities.contains('color')) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => DeviceDetailScreen(device: d)));
    } else {
      await showDeviceSheet(context, d);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(liveStatesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(category.def.label)),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          for (final d in category.devices)
            Padding(
              padding: const EdgeInsets.only(bottom: AureonSpacing.md),
              child: Builder(builder: (_) {
                final spec = tileSpec(d, mergedDeviceState(d, live));
                return DeviceControlTile(
                  icon: spec.icon,
                  name: d.name,
                  valueLabel: spec.value,
                  fill: spec.fill,
                  on: spec.on,
                  slidable: spec.slidable,
                  onChanged: spec.slidable ? (v) => _drag(ref, d, v) : null,
                  onToggle: spec.slidable ? () => _toggle(ref, d, spec) : null,
                  onTap: spec.slidable ? null : () => _open(context, ref, d),
                  onOpenDetail: spec.slidable ? () => _open(context, ref, d) : null,
                );
              }),
            ),
        ],
      ),
    );
  }
}
