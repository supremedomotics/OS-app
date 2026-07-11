import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../widgets/climate_console.dart';
import 'climate_scheduler_screen.dart';

/// The tablet HVAC console (§ HVAC Detail Page) — a dedicated full-page, wide layout,
/// reached from [showDeviceSheet] on a tablet-sized screen instead of the phone's bottom
/// sheet. Same [ClimateConsoleBody] content as the phone sheet, just arranged as a
/// wide split with its own app bar (back / rename / remove) instead of a grab-handle
/// sheet — mirrors AvrConsoleScreen's exact structure.
class ClimateConsoleScreen extends ConsumerWidget {
  const ClimateConsoleScreen({super.key, required this.device});
  final Device device;

  Future<void> _rename(BuildContext context, WidgetRef ref) async {
    final ctrl = TextEditingController(text: device.name);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename device'),
        content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(labelText: 'Name')),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (name != null && name.isNotEmpty && name != device.name) {
      await ref.read(clientProvider).updateDevice(device.id, name: name);
      ref.invalidate(homeProvider);
      ref.invalidate(allDevicesProvider);
    }
  }

  Future<void> _remove(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove device?'),
        content: Text('"${device.name}" will be removed. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok == true) {
      await ref.read(clientProvider).deleteDevice(device.id);
      ref.invalidate(homeProvider);
      ref.invalidate(allDevicesProvider);
      if (context.mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rooms = ref.watch(homeProvider).maybeWhen(data: (h) => h.rooms, orElse: () => const <Room>[]);
    final roomName = rooms.where((r) => r.id == device.roomId).map((r) => r.name).firstOrNull ?? 'Home';

    return Scaffold(
      backgroundColor: AureonBase.voidColor,
      appBar: AppBar(
        backgroundColor: AureonBase.voidColor,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(device.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          Text(roomName, style: const TextStyle(fontSize: 11, color: AureonText.secondary)),
        ]),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'rename') {
                _rename(context, ref);
              } else if (v == 'remove') {
                _remove(context, ref);
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'rename', child: Text('Rename')),
              PopupMenuItem(value: 'remove', child: Text('Remove device')),
            ],
          ),
        ],
      ),
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(-0.5, -0.9), radius: 1.4,
            colors: [AureonGold.c400.withValues(alpha: 0.04), Colors.transparent],
          ),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            child: ClimateConsoleBody(
              device: device,
              roomName: roomName,
              layout: ClimateConsoleLayout.wide,
              onOpenSchedule: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ClimateSchedulerScreen(device: device))),
            ),
          ),
        ),
      ),
    );
  }
}
