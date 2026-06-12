import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

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
          error: (e, _) => Center(child: Text('Could not load security\n$e')),
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
