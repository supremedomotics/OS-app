import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../errors.dart';
import '../providers.dart';
import '../widgets/empty_state.dart';
import 'device_sheet.dart';

/// Climate (§ Navigation → Climate) — mobile parity with the web Climate view. The
/// whole-home list of HVAC units: every device the home exposes with a `temperature`
/// capability, grouped by room. The console (ClimateConsoleScreen) already degrades
/// gracefully when a unit's capability config is bare (no modes/fan speeds/swing
/// positions declared) — it just hides the sections it has nothing to show — so this
/// list doesn't gate on that either; any commissioned AC/thermostat belongs here.
/// Mirrors media_screen.dart's exact structure.
class ClimateScreen extends ConsumerWidget {
  const ClimateScreen({super.key});

  bool _hasClimateConfig(Device d) => d.capabilities.contains('temperature');

  String _summary(Device d, Map<String, Map<String, dynamic>> live) {
    final state = mergedDeviceState(d, live);
    final onoff = state['onoff'] as Map<String, dynamic>?;
    final t = state['temperature'] as Map<String, dynamic>?;
    final mode = t?['mode'] as String?;
    if (onoff?['on'] != true || t == null || mode == 'off') return 'Off';
    final targetC = t['targetC'] as num?;
    final label = mode != null ? (mode[0].toUpperCase() + mode.substring(1)) : '';
    return targetC != null ? '$targetC°C · $label' : (label.isNotEmpty ? label : 'On');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(allDevicesProvider);
    final live = ref.watch(liveStatesProvider);
    final rooms = ref.watch(homeProvider).valueOrNull?.rooms ?? const <Room>[];
    String roomName(String? id) => rooms.where((r) => r.id == id).map((r) => r.name).firstOrNull ?? 'Other';

    return Scaffold(
      appBar: AppBar(title: const Text('Climate')),
      body: devices.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(friendlyError(e, 'Could not load your HVAC units.'), textAlign: TextAlign.center))),
        data: (all) {
          final units = all.where(_hasClimateConfig).toList();
          if (units.isEmpty) {
            return const EmptyState(
              icon: Icons.thermostat_outlined,
              title: 'No HVAC units yet',
              hint: 'Air conditioners and thermostats you add will appear here, ready to control — grouped by room.',
            );
          }
          final byRoom = <String, List<Device>>{};
          for (final d in units) { (byRoom[roomName(d.roomId)] ??= []).add(d); }
          final groups = byRoom.entries.toList()..sort((a, b) => a.key.compareTo(b.key));

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(allDevicesProvider),
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                for (final g in groups) ...[
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: AureonSpacing.sm),
                    child: Text('${g.key} · ${g.value.length}', style: Theme.of(context).textTheme.titleSmall),
                  ),
                  for (final d in g.value)
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.ac_unit, color: AureonGold.c400),
                        title: Text(d.name),
                        subtitle: Text(_summary(d, live), maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => showDeviceSheet(context, d),
                      ),
                    ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}
