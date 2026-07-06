import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import '../widgets/empty_state.dart';
import 'automation_canvas.dart';
import 'automation_editor.dart';

/// Automations (§10) — the Ovio "at a glance" list. Each row shows the automation name,
/// a primary-action summary, and its enabled state; tapping opens the node canvas. The
/// FAB opens the drag-and-drop editor.
class AutomationsScreen extends ConsumerStatefulWidget {
  const AutomationsScreen({super.key});

  @override
  ConsumerState<AutomationsScreen> createState() => _AutomationsScreenState();
}

class _AutomationsScreenState extends ConsumerState<AutomationsScreen> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final automations = ref.watch(automationsProvider);
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      floatingActionButton: FloatingActionButton(
        onPressed: () async {
          await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AutomationEditor()));
          ref.invalidate(automationsProvider);
        },
        child: const Icon(Icons.add),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AureonSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Automations', style: text.titleLarge),
              Text('Your automations at a glance', style: text.labelMedium),
              const SizedBox(height: AureonSpacing.md),
              TextField(
                decoration: InputDecoration(
                  hintText: 'Search automations',
                  prefixIcon: const Icon(Icons.search),
                  filled: true,
                  fillColor: scheme.surface,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
                ),
                onChanged: (v) => setState(() => _q = v.toLowerCase()),
              ),
              const SizedBox(height: AureonSpacing.md),
              Expanded(
                child: automations.when(
                  loading: () => const Center(child: CircularProgressIndicator()),
                  error: (e, _) => Center(child: Text('Could not load automations\n$e')),
                  data: (list) {
                    final shown = list.where((a) => a.name.toLowerCase().contains(_q)).toList();
                    if (shown.isEmpty) {
                      return EmptyState(
                        icon: Icons.account_tree_outlined,
                        title: _q.isEmpty ? 'No automations yet' : 'No automations match',
                        hint: _q.isEmpty
                            ? 'Let your home run itself — lights at sunset, doors locked at night, a scene when you arrive.'
                            : 'Try a different name, or clear the search.',
                        actionLabel: _q.isEmpty ? 'Create automation' : null,
                        onAction: _q.isEmpty
                            ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AutomationEditor()))
                            : null,
                      );
                    }
                    return ListView.separated(
                      itemCount: shown.length,
                      separatorBuilder: (_, __) => const SizedBox(height: AureonSpacing.sm),
                      itemBuilder: (context, i) {
                        final a = shown[i];
                        return GestureDetector(
                          onTap: () async {
                            await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AutomationCanvas(automation: a)));
                            ref.invalidate(automationsProvider);
                          },
                          child: Container(
                            padding: const EdgeInsets.all(16),
                            decoration: BoxDecoration(
                              color: Theme.of(context).cardTheme.color ?? scheme.surface,
                              borderRadius: BorderRadius.circular(18),
                              border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
                            ),
                            child: Row(children: [
                              Container(
                                width: 44, height: 44, alignment: Alignment.center,
                                decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: scheme.outlineVariant, width: 1.5, style: BorderStyle.solid)),
                                child: Icon(automationGlyph(a.actions.isNotEmpty ? a.actions.first['type'] as String? : null), size: 20, color: scheme.onSurface.withValues(alpha: 0.7)),
                              ),
                              const SizedBox(width: 14),
                              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(a.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 17)),
                                Row(children: [
                                  Text(automationActionLabel(a.actions.isNotEmpty ? a.actions.first['type'] as String? : null), style: text.labelMedium),
                                  if (a.actions.length > 1) ...[
                                    const SizedBox(width: 8),
                                    Container(padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1), decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(8), border: Border.all(color: scheme.outlineVariant)), child: Text('+${a.actions.length - 1}', style: const TextStyle(fontSize: 12))),
                                  ],
                                ]),
                              ])),
                              Text(a.enabled ? 'Enabled' : 'Off', style: TextStyle(fontSize: 13, color: a.enabled ? AureonStatus.good : scheme.onSurface.withValues(alpha: 0.5))),
                            ]),
                          ),
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
