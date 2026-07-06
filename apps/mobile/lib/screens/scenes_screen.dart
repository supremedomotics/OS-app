import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../usage.dart';
import '../widgets/empty_state.dart';

/// Scenes (§10/§11.1) — Ovio interactive cards in a grid, with an Edit mode that turns on
/// drag-to-reorder + Save. One tap activates a scene; HA is never involved.
class ScenesScreen extends ConsumerStatefulWidget {
  const ScenesScreen({super.key});

  @override
  ConsumerState<ScenesScreen> createState() => _ScenesScreenState();
}

class _ScenesScreenState extends ConsumerState<ScenesScreen> {
  bool _edit = false;
  List<String> _order = [];

  List<Scene> _ordered(List<Scene> scenes) {
    final saved = _order.isEmpty ? ref.read(sceneOrderProvider) : _order;
    final ids = scenes.map((s) => s.id).toList();
    final seq = [...saved.where(ids.contains), ...ids.where((id) => !saved.contains(id))];
    return [for (final id in seq) scenes.firstWhere((s) => s.id == id)];
  }

  @override
  Widget build(BuildContext context) {
    final scenes = ref.watch(scenesProvider);
    final favIds = {for (final f in ref.watch(favoritesProvider).valueOrNull ?? const []) if (f.type == 'scene') f.refId};
    final text = Theme.of(context).textTheme;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('One tap to set the mood', style: text.labelMedium),
                      Text('Scenes', style: text.titleLarge),
                    ],
                  ),
                ),
                // Human-centric lighting: one tap aligns every tunable-white light to the
                // time-of-day color temperature + brightness.
                IconButton.filledTonal(
                  tooltip: 'Circadian lighting',
                  icon: const Icon(Icons.brightness_4_outlined),
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.of(context);
                    try {
                      final applied = await ref.read(clientProvider).applyCircadian();
                      messenger.showSnackBar(SnackBar(content: Text('Circadian applied to ${applied.length} lights')));
                    } catch (_) {
                      messenger.showSnackBar(const SnackBar(content: Text('Could not apply circadian lighting')));
                    }
                  },
                ),
                const SizedBox(width: AureonSpacing.sm),
                // Scene schedules (time / sunrise / sunset).
                IconButton.filledTonal(
                  tooltip: 'Schedules',
                  icon: const Icon(Icons.schedule_outlined),
                  onPressed: scenes.maybeWhen(
                    data: (list) => () => showModalBottomSheet<void>(
                          context: context,
                          isScrollControlled: true,
                          builder: (_) => _SchedulesSheet(scenes: list),
                        ),
                    orElse: () => null,
                  ),
                ),
                const SizedBox(width: AureonSpacing.sm),
                scenes.maybeWhen(
                  data: (list) => list.isEmpty
                      ? const SizedBox.shrink()
                      : FilledButton.tonal(
                          onPressed: () {
                            if (_edit) {
                              ref.read(sceneOrderProvider.notifier).set(_ordered(list).map((s) => s.id).toList());
                            } else {
                              _order = _ordered(list).map((s) => s.id).toList();
                            }
                            setState(() => _edit = !_edit);
                          },
                          child: Text(_edit ? 'Save' : 'Edit'),
                        ),
                  orElse: () => const SizedBox.shrink(),
                ),
              ],
            ),
            const SizedBox(height: AureonSpacing.lg),
            Expanded(
              child: scenes.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(child: Text('Could not load scenes\n$e')),
                data: (list) => list.isEmpty
                    ? const EmptyState(
                        icon: Icons.auto_awesome_outlined,
                        title: 'No scenes yet',
                        hint: 'A scene sets many devices at once — “Movie Night”, “Good Morning”, “Away”. Arrange your home, then save it as a scene.',
                      )
                    : _edit
                        ? _ReorderList(
                            scenes: _ordered(list),
                            onReorder: (a, b) => setState(() {
                              final ids = _ordered(list).map((s) => s.id).toList();
                              if (b > a) b -= 1;
                              ids.insert(b, ids.removeAt(a));
                              _order = ids;
                            }),
                          )
                        : GridView.count(
                            crossAxisCount: 2,
                            mainAxisSpacing: AureonSpacing.md,
                            crossAxisSpacing: AureonSpacing.md,
                            childAspectRatio: 1.1,
                            children: [
                              for (final s in _ordered(list))
                                _SceneCard(
                                  name: s.name,
                                  onTap: () { ref.read(usageProvider.notifier).record('scene', s.id); ref.read(clientProvider).activateScene(s.id); },
                                  favorite: favIds.contains(s.id),
                                  onFav: () async {
                                    await ref.read(clientProvider).setFavorite({'type': 'scene', 'sceneId': s.id}, favorite: !favIds.contains(s.id));
                                    ref.invalidate(favoritesProvider);
                                  },
                                ),
                            ],
                          ),
              ),
            ),
            if (_edit) Text('Drag the cards to reorder, then Save.', style: text.labelMedium),
          ],
        ),
      ),
    );
  }
}

class _SceneCard extends StatelessWidget {
  const _SceneCard({required this.name, this.onTap, this.handle = false, this.favorite = false, this.onFav});
  final String name;
  final VoidCallback? onTap;
  final bool handle;
  final bool favorite;
  final VoidCallback? onFav;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(AureonSpacing.md),
        decoration: BoxDecoration(
          color: Theme.of(context).cardTheme.color ?? scheme.surface,
          borderRadius: BorderRadius.circular(AureonRadius.lg),
          border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: scheme.surface,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(handle ? Icons.drag_indicator : Icons.play_arrow_rounded,
                    color: handle ? scheme.onSurface.withValues(alpha: 0.6) : scheme.primary),
              ),
              const Spacer(),
              if (!handle && onFav != null)
                GestureDetector(
                  onTap: onFav,
                  child: Icon(favorite ? Icons.favorite : Icons.favorite_border,
                      size: 18, color: favorite ? AureonGold.c400 : scheme.onSurfaceVariant),
                ),
            ]),
            Text(name, style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class _ReorderList extends StatelessWidget {
  const _ReorderList({required this.scenes, required this.onReorder});
  final List<Scene> scenes;
  final void Function(int oldIndex, int newIndex) onReorder;

  @override
  Widget build(BuildContext context) {
    return ReorderableListView(
      // onReorder gives the pre-removal newIndex; the caller adjusts it. (Kept for
      // compatibility across the pinned Flutter version.)
      // ignore: deprecated_member_use
      onReorder: onReorder,
      children: [
        for (final s in scenes)
          Padding(
            key: ValueKey(s.id),
            padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
            child: SizedBox(height: 84, child: _SceneCard(name: s.name, handle: true)),
          ),
      ],
    );
  }
}

/// Manage scene schedules: list existing ones, add a time/sunrise/sunset trigger, delete.
class _SchedulesSheet extends ConsumerWidget {
  const _SchedulesSheet({required this.scenes});

  final List<Scene> scenes;

  String _sceneName(String id) =>
      scenes.firstWhere((s) => s.id == id, orElse: () => scenes.first).name;

  String _describe(Map<String, dynamic> s) {
    final t = s['trigger'] as Map<String, dynamic>;
    if (t['type'] == 'solar') {
      final off = (t['offsetMinutes'] as num?)?.toInt() ?? 0;
      final tail = off == 0 ? '' : (off > 0 ? ' +${off}m' : ' ${off}m');
      return 'At ${t['event']}$tail';
    }
    final m = (t['atMinutes'] as num).toInt();
    return 'At ${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final schedules = ref.watch(sceneSchedulesProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Scene schedules',
                style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AureonSpacing.md),
            schedules.when(
              loading: () => const Padding(
                  padding: EdgeInsets.all(AureonSpacing.lg),
                  child: Center(child: CircularProgressIndicator())),
              error: (e, _) => Text('Could not load schedules\n$e'),
              data: (list) => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (list.isEmpty)
                    const Padding(
                        padding: EdgeInsets.symmetric(vertical: AureonSpacing.md),
                        child: Text('No schedules yet')),
                  for (final s in list)
                    ListTile(
                      leading: const Icon(Icons.event_outlined),
                      title: Text(_sceneName(s['sceneId'] as String)),
                      subtitle: Text(_describe(s)),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () async {
                          final next = [...list]..remove(s);
                          await ref.read(clientProvider).setSceneSchedules(
                              next.cast<Map<String, dynamic>>());
                          ref.invalidate(sceneSchedulesProvider);
                        },
                      ),
                    ),
                  const SizedBox(height: AureonSpacing.sm),
                  FilledButton.icon(
                    icon: const Icon(Icons.add),
                    label: const Text('Add schedule'),
                    onPressed: () => _add(context, ref, list),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _add(BuildContext context, WidgetRef ref,
      List<Map<String, dynamic>> existing) async {
    var sceneId = scenes.first.id;
    Map<String, dynamic>? trigger;
    final created = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setState) => AlertDialog(
          title: const Text('New schedule'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButton<String>(
                isExpanded: true,
                value: sceneId,
                items: [
                  for (final s in scenes)
                    DropdownMenuItem(value: s.id, child: Text(s.name)),
                ],
                onChanged: (v) => setState(() => sceneId = v ?? sceneId),
              ),
              const SizedBox(height: AureonSpacing.sm),
              Wrap(
                spacing: AureonSpacing.sm,
                children: [
                  ChoiceChip(
                    label: const Text('At sunrise'),
                    selected: trigger?['event'] == 'sunrise',
                    onSelected: (_) => setState(
                        () => trigger = {'type': 'solar', 'event': 'sunrise'}),
                  ),
                  ChoiceChip(
                    label: const Text('At sunset'),
                    selected: trigger?['event'] == 'sunset',
                    onSelected: (_) => setState(
                        () => trigger = {'type': 'solar', 'event': 'sunset'}),
                  ),
                  ActionChip(
                    avatar: const Icon(Icons.access_time, size: 18),
                    label: Text(trigger?['type'] == 'time'
                        ? '${((trigger!['atMinutes'] as int) ~/ 60).toString().padLeft(2, '0')}:${((trigger!['atMinutes'] as int) % 60).toString().padLeft(2, '0')}'
                        : 'Pick time'),
                    onPressed: () async {
                      final picked = await showTimePicker(
                          context: dialogContext,
                          initialTime: const TimeOfDay(hour: 18, minute: 0));
                      if (picked != null) {
                        setState(() => trigger = {
                              'type': 'time',
                              'atMinutes': picked.hour * 60 + picked.minute,
                            });
                      }
                    },
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Cancel')),
            FilledButton(
              onPressed: trigger == null
                  ? null
                  : () => Navigator.pop(
                      dialogContext, {'sceneId': sceneId, 'trigger': trigger}),
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
    if (created != null) {
      await ref.read(clientProvider).setSceneSchedules([...existing, created]);
      ref.invalidate(sceneSchedulesProvider);
    }
  }
}
