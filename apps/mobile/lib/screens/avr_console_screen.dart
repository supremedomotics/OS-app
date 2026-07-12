import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../widgets/avr_console.dart';

/// The tablet AVR console (§ AVR Detail Page "Tablet Layout") — a dedicated full-page,
/// two-pane layout, reached from [showDeviceSheet] on a tablet-sized screen instead of
/// the phone's bottom sheet. Same [AvrConsoleBody] content as the phone sheet, just
/// arranged as a two-pane split with its own app bar (back / power / rename / remove)
/// instead of a grab-handle sheet.
class AvrConsoleScreen extends ConsumerWidget {
  const AvrConsoleScreen({super.key, required this.device});
  final Device device;

  Future<void> _rename(BuildContext context, WidgetRef ref) async {
    final name = await promptRenameDevice(context, device.name);
    if (name == null) return;
    await ref.read(clientProvider).updateDevice(device.id, name: name);
    ref.invalidate(homeProvider);
    ref.invalidate(allDevicesProvider);
  }

  Future<void> _remove(BuildContext context, WidgetRef ref) async {
    final ok = await confirmRemoveDevice(context, device.name);
    if (!ok) return;
    await ref.read(clientProvider).deleteDevice(device.id);
    ref.invalidate(homeProvider);
    ref.invalidate(allDevicesProvider);
    if (context.mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(liveStatesProvider);
    final merged = mergedDeviceState(device, live);
    final onoff = (merged['onoff'] as Map<String, dynamic>?);
    final hasPower = device.capabilities.contains('onoff');
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
          if (hasPower)
            IconButton(
              icon: Icon(Icons.power_settings_new, color: (onoff?['on'] as bool?) == true ? AureonGold.c400 : AureonText.secondary),
              onPressed: () {
                final on = (onoff?['on'] as bool?) ?? false;
                ref.read(liveStatesProvider.notifier).apply(device.id, 'onoff', {'kind': 'onoff', 'on': !on});
                ref.read(clientProvider).command(device.id, {'capability': 'onoff', 'action': on ? 'off' : 'on'});
              },
            ),
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
      // A whisper of a vignette so the console reads as intentionally composed rather
      // than floating in dead black (§ Empty Space).
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(-0.5, -0.9), radius: 1.4,
            colors: [AureonGold.c400.withValues(alpha: 0.04), Colors.transparent],
          ),
        ),
        child: SafeArea(
          child: AvrConsoleBody(
            device: device,
            layout: AvrConsoleLayout.wide,
            onNavigateSibling: (ctx, d) => Navigator.of(ctx).pushReplacement(MaterialPageRoute<void>(builder: (_) => AvrConsoleScreen(device: d))),
          ),
        ),
      ),
    );
  }
}
