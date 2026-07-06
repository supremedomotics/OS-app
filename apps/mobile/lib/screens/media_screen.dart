import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../widgets/empty_state.dart';
import 'device_sheet.dart';

/// Media (§ Navigation → Media) — mobile parity with the web Media view. The whole-home list of
/// everything that plays: every device the home already exposes with a `media` capability, grouped
/// by room, each opening the existing DeviceSheet transport controls. Pure presentation over the
/// real devices()/command() surface — no new backend, no duplicate media system.
class MediaScreen extends ConsumerWidget {
  const MediaScreen({super.key});

  String _nowPlaying(Device d) {
    final m = d.state['media'] as Map<String, dynamic>?;
    if (m == null) return 'Idle';
    final title = m['title'] as String? ?? '';
    final artist = m['artist'] as String? ?? '';
    final playing = m['playing'] == true || m['state'] == 'playing';
    if (title.isNotEmpty) return artist.isNotEmpty ? '$title · $artist' : title;
    return playing ? 'Playing' : 'Idle';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(allDevicesProvider);
    final rooms = ref.watch(homeProvider).valueOrNull?.rooms ?? const <Room>[];
    String roomName(String? id) => rooms.where((r) => r.id == id).map((r) => r.name).firstOrNull ?? 'Other';

    return Scaffold(
      appBar: AppBar(title: const Text('Media')),
      body: devices.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load media\n$e', textAlign: TextAlign.center)),
        data: (all) {
          final media = all.where((d) => d.capabilities.contains('media')).toList();
          if (media.isEmpty) {
            return const EmptyState(
              icon: Icons.music_note_outlined,
              title: 'No media players yet',
              hint: 'Speakers and TVs you add will appear here, ready to play — grouped by room.',
            );
          }
          final byRoom = <String, List<Device>>{};
          for (final d in media) { (byRoom[roomName(d.roomId)] ??= []).add(d); }
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
                        leading: const Icon(Icons.music_note, color: AureonGold.c400),
                        title: Text(d.name),
                        subtitle: Text(_nowPlaying(d), maxLines: 1, overflow: TextOverflow.ellipsis),
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
