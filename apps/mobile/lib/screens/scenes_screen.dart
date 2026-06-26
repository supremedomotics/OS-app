import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

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
                scenes.maybeWhen(
                  data: (list) => list.isEmpty
                      ? const SizedBox.shrink()
                      : FilledButton.tonal(
                          onPressed: () {
                            if (_edit) {
                              ref.read(sceneOrderProvider.notifier).state = _ordered(list).map((s) => s.id).toList();
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
                    ? Text('No scenes yet', style: text.labelMedium)
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
                                  onTap: () => ref.read(clientProvider).activateScene(s.id),
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
  const _SceneCard({required this.name, this.onTap, this.handle = false});
  final String name;
  final VoidCallback? onTap;
  final bool handle;

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
