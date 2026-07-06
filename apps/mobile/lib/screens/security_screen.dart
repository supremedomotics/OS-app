import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../errors.dart';
import '../providers.dart';
import 'camera_player.dart';

/// Security panel (§11.1): mode chips + slide-to-confirm arm/disarm for sensitive
/// transitions, with a prominent triggered state.
class SecurityScreen extends ConsumerWidget {
  const SecurityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(securityProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: state.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(child: Text(friendlyError(e, 'Could not load security.'), textAlign: TextAlign.center)),
          data: (s) {
            final mode = s['mode'] as String;
            final triggered = s['triggered'] as bool? ?? false;
            return SingleChildScrollView(
                child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Security', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: AureonSpacing.lg),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(AureonSpacing.lg),
                  decoration: BoxDecoration(
                    color: triggered
                        ? AureonStatus.critical.withValues(alpha: 0.18)
                        : AureonBase.surfaceRaised,
                    borderRadius: BorderRadius.circular(AureonRadius.lg),
                    border: Border.all(color: AureonBase.hairline),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(triggered ? 'ALARM TRIGGERED' : _label(mode),
                          style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: AureonSpacing.xs),
                      Text('Current mode: $mode',
                          style: Theme.of(context).textTheme.labelMedium),
                    ],
                  ),
                ),
                const SizedBox(height: AureonSpacing.xl),
                Wrap(
                  spacing: AureonSpacing.sm,
                  children: [
                    for (final m in const [
                      'armed_home',
                      'armed_away',
                      'armed_night'
                    ])
                      ChoiceChip(
                        label: Text(_label(m)),
                        selected: mode == m,
                        onSelected: (_) async {
                          await ref.read(clientProvider).arm(m);
                          ref.invalidate(securityProvider);
                        },
                      ),
                  ],
                ),
                const SizedBox(height: AureonSpacing.xl),
                if (mode != 'disarmed')
                  SlideToConfirm(
                    label: 'Slide to disarm',
                    icon: Icons.lock_open,
                    onConfirmed: () async {
                      await ref.read(clientProvider).disarm();
                      ref.invalidate(securityProvider);
                    },
                  ),
                const SizedBox(height: AureonSpacing.xl),
                const _VacationModeTile(),
                const SizedBox(height: AureonSpacing.md),
                _HomeAlertsTile(),
                const SizedBox(height: AureonSpacing.xl),
                const _CamerasSection(),
              ],
            ));
          },
        ),
      ),
    );
  }

  String _label(String mode) => switch (mode) {
        'armed_home' => 'Armed · Home',
        'armed_away' => 'Armed · Away',
        'armed_night' => 'Armed · Night',
        _ => 'Disarmed',
      };
}

/// Vacation mode: a toggle that runs occupancy simulation (lived-in lighting while away).
class _VacationModeTile extends ConsumerWidget {
  const _VacationModeTile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final running = ref.watch(occupancyProvider);
    return Container(
      decoration: BoxDecoration(
        color: AureonBase.surfaceRaised,
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        border: Border.all(color: AureonBase.hairline),
      ),
      child: SwitchListTile(
        secondary: const Icon(Icons.luggage_outlined),
        title: const Text('Vacation mode'),
        subtitle: const Text('Simulate occupancy with lived-in lighting while away'),
        value: running.valueOrNull ?? false,
        onChanged: running.isLoading
            ? null
            : (v) async {
                final messenger = ScaffoldMessenger.of(context);
                try {
                  await ref.read(clientProvider).setOccupancy(v);
                  ref.invalidate(occupancyProvider);
                } catch (_) {
                  messenger.showSnackBar(const SnackBar(content: Text('Could not update vacation mode')));
                }
              },
      ),
    );
  }
}

/// Entry tile that opens the duration-based home-alert rules editor.
class _HomeAlertsTile extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      decoration: BoxDecoration(
        color: AureonBase.surfaceRaised,
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        border: Border.all(color: AureonBase.hairline),
      ),
      child: ListTile(
        leading: const Icon(Icons.notifications_active_outlined),
        title: const Text('Home alerts'),
        subtitle: const Text('Notify if a door, lock, or light is left for too long'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => const _AlertRulesSheet(),
        ),
      ),
    );
  }
}

/// Editor for duration-based alert rules: list, add (device + type + minutes), delete.
class _AlertRulesSheet extends ConsumerWidget {
  const _AlertRulesSheet();

  static const _types = {
    'left_open': 'left open',
    'left_unlocked': 'left unlocked',
    'left_on': 'left on',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rules = ref.watch(alertRulesProvider);
    final devices = ref.watch(allDevicesProvider);
    String name(String id) => devices.maybeWhen(
        data: (list) => list.firstWhere((d) => d.id == id, orElse: () => list.first).name,
        orElse: () => id);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Home alerts', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AureonSpacing.md),
            rules.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Text(friendlyError(e, 'Could not load alerts.')),
              data: (list) => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (list.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: AureonSpacing.md), child: Text('No alerts yet')),
                  for (final r in list)
                    ListTile(
                      leading: const Icon(Icons.warning_amber_outlined),
                      title: Text(name(r['deviceId'] as String)),
                      subtitle: Text('${_types[r['type']] ?? r['type']} for ${r['durationMinutes']} min'),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () async {
                          final next = [...list]..remove(r);
                          await ref.read(clientProvider).setAlertRules(next.cast<Map<String, dynamic>>());
                          ref.invalidate(alertRulesProvider);
                        },
                      ),
                    ),
                  const SizedBox(height: AureonSpacing.sm),
                  FilledButton.icon(
                    icon: const Icon(Icons.add),
                    label: const Text('Add alert'),
                    onPressed: devices.maybeWhen(
                      data: (devs) => devs.isEmpty ? null : () => _add(context, ref, list, devs),
                      orElse: () => null,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _add(BuildContext context, WidgetRef ref, List<Map<String, dynamic>> existing, List<Device> devices) async {
    var deviceId = devices.first.id;
    var type = 'left_open';
    var minutes = 10;
    final created = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setState) => AlertDialog(
          title: const Text('New alert'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButton<String>(
                isExpanded: true,
                value: deviceId,
                items: [for (final d in devices) DropdownMenuItem(value: d.id, child: Text(d.name))],
                onChanged: (v) => setState(() => deviceId = v ?? deviceId),
              ),
              const SizedBox(height: AureonSpacing.sm),
              Wrap(
                spacing: AureonSpacing.sm,
                children: [
                  for (final entry in _types.entries)
                    ChoiceChip(
                      label: Text(entry.value),
                      selected: type == entry.key,
                      onSelected: (_) => setState(() => type = entry.key),
                    ),
                ],
              ),
              const SizedBox(height: AureonSpacing.sm),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton(icon: const Icon(Icons.remove), onPressed: () => setState(() => minutes = (minutes - 5).clamp(1, 1440))),
                  Text('$minutes min'),
                  IconButton(icon: const Icon(Icons.add), onPressed: () => setState(() => minutes = (minutes + 5).clamp(1, 1440))),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, {'deviceId': deviceId, 'type': type, 'durationMinutes': minutes}),
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
    if (created != null) {
      await ref.read(clientProvider).setAlertRules([...existing, created]);
      ref.invalidate(alertRulesProvider);
    }
  }
}

/// Camera strip on the security screen — snapshot tiles that open a live HLS view.
class _CamerasSection extends ConsumerWidget {
  const _CamerasSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cameras = ref.watch(camerasProvider);
    return cameras.when(
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (list) {
        if (list.isEmpty) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Cameras', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AureonSpacing.sm),
            SizedBox(
              height: 132,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: list.length,
                separatorBuilder: (_, __) =>
                    const SizedBox(width: AureonSpacing.sm),
                itemBuilder: (context, i) => _CameraTile(camera: list[i]),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _CameraTile extends StatelessWidget {
  const _CameraTile({required this.camera});

  final Camera camera;

  @override
  Widget build(BuildContext context) {
    final playable = camera.streamUrl != null;
    return GestureDetector(
      onTap: playable
          ? () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => CameraPlayerScreen(camera: camera),
                ),
              )
          : null,
      child: SizedBox(
        width: 200,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AureonRadius.md),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Container(color: Colors.black),
                    if (camera.snapshotUrl != null)
                      Image.network(camera.snapshotUrl!,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => const SizedBox()),
                    if (playable)
                      const Center(
                        child: Icon(Icons.play_circle_fill,
                            color: Colors.white70, size: 40),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: AureonSpacing.xs),
            Text(camera.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelLarge),
          ],
        ),
      ),
    );
  }
}
