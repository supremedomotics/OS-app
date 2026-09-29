import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../_shared/residence_presentation.dart';
import '../control/control_blocks.dart';
import '../experiences/activate.dart';

/// A space, photo-led (Golden Master `space.js`): how it feels → Change. The page says what the
/// space is like and offers its Experiences; "Feels like" is DERIVED from the devices, never from
/// a button. On compact surfaces and room panels the room's own controls sit right under the words
/// (one line per system); larger surfaces reach them through Control, opened in this space's scope.
///
/// PENDING OWNER DECISION (D5 — Shape): the prototype's "Shape" / "Keep this" (authoring an
/// Experience from the room) is not built and its entry is not drawn — there is no authoring
/// contract to back it.
class SpaceScreen extends ConsumerStatefulWidget {
  final String spaceId;
  final VoidCallback onBack;
  const SpaceScreen({super.key, required this.spaceId, required this.onBack});
  @override
  ConsumerState<SpaceScreen> createState() => _SpaceScreenState();
}

class _SpaceScreenState extends ConsumerState<SpaceScreen> {
  // Presentation state only: whether the Experience list is unfolded.
  bool _changeOpen = false;

  void _activate(ResidenceView v, Experience e) {
    activateExperience(ref, v, e, spaceId: widget.spaceId);
  }

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final hour = ref.watch(residenceHourProvider);
    final profile = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final snap = view?.snapshot;
    final space = snap?.space(widget.spaceId);
    if (view == null || snap == null || space == null) {
      return const SizedBox.shrink(key: ValueKey('space-loading'));
    }
    final watch = profile.skeleton == SurfaceSkeleton.watch;
    final phone = profile.skeleton == SurfaceSkeleton.phone;
    final feel = spaceFeel(snap, space.id, commands: view.inFlight);
    final settled = !feel.endsWith('…');
    final summary = spaceSummary(snap, space.id);
    final cond = spaceCondition(snap, space.id,
        commands: view.inFlight, sunUp: sunUpAt(hour));
    final xs = spaceExperiences(snap, space.id);
    final active = cond.experience;
    final immediate = profile.mode == SurfaceMode.compact ||
        profile.role == SurfaceRole.roomPanel;
    final look = lookFor(lightOf(snap.devicesIn(space.id)));
    final pad = watch ? 12.0 : phone ? 20.0 : 32.0;
    // The photograph runs under the header; the words start below it.
    final top = ShellInsets.of(context).top;

    return Stack(
      key: ValueKey('space-page-${space.id}'),
      fit: StackFit.expand,
      children: [
        if (!watch) ToneSurface(look: look, image: heroImageFor(space)),
        // The scrim the prototype lays over the photograph so the words always read.
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              stops: phone
                  ? const [0, .36, .58, .7]
                  : const [0, .28, .52, .66],
              colors: phone
                  ? const [Color(0xF008090A), Color(0xC208090A), Color(0x3308090A), Color(0x0008090A)]
                  : const [Color(0xE608090A), Color(0x9E08090A), Color(0x2908090A), Color(0x0008090A)],
            ),
          ),
        ),
        LayoutBuilder(
          builder: (context, c) => SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(pad, pad + top, pad, pad + 16),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight - pad * 2 - 16 - top),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 18),
                    child: Row(children: [
                      SupremeTappable(
                        key: const ValueKey('space-back'),
                        onTap: widget.onBack,
                        semanticLabel: 'Back to Spaces',
                        radius: 999,
                        child: Container(
                          height: 44,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: SupremeColorScheme.rule),
                            color: SupremeColorScheme.veil,
                          ),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            const SupremeGlyph('arrow_back', size: 18),
                            const SizedBox(width: 8),
                            Text('Spaces', style: text.body.copyWith(fontSize: 14)),
                          ]),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Flexible(
                        child: Text(floorLabel(space.floorId).toUpperCase(),
                            overflow: TextOverflow.ellipsis,
                            style: text.body.copyWith(
                                fontSize: 12,
                                letterSpacing: 2.2,
                                color: SupremeColorScheme.text3)),
                      ),
                    ]),
                  ),
                  Text(space.name,
                      style: text.pageTitle.copyWith(
                          fontSize: watch ? 24 : phone ? 34 : null,
                          shadows: const [Shadow(color: Color(0x8C000000), blurRadius: 14, offset: Offset(0, 1))])),
                  const SizedBox(height: 10),
                  Text(feel,
                      key: const ValueKey('space-feel'),
                      style: text.name.copyWith(
                          fontSize: watch ? 18 : phone ? 24 : 30,
                          height: 1.2,
                          color: settled ? SupremeColorScheme.text : SupremeColorScheme.brassPale)),
                  const SizedBox(height: 4),
                  Padding(
                    padding: const EdgeInsets.only(top: 6, bottom: 16),
                    child: Text(summary.isEmpty ? 'Nothing is on' : summary,
                        style: text.body.copyWith(
                            fontSize: watch ? 12 : 16, color: SupremeColorScheme.text2)),
                  ),
                  if (cond.attention != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                          '${snap.devicesIn(space.id).where((d) => !d.isOnline).map((d) => d.name).join(', ')} ${snap.devicesIn(space.id).where((d) => !d.isOnline).length == 1 ? 'isn’t' : 'aren’t'} responding.',
                          key: const ValueKey('space-attention'),
                          style: text.body.copyWith(
                              fontSize: 14, color: SupremeColorScheme.brassPale)),
                    ),
                  if (xs.isNotEmpty)
                    SupremeAct('Change',
                        key: const ValueKey('space-change'),
                        fontSize: 16,
                        onTap: () => setState(() => _changeOpen = !_changeOpen)),
                  if (_changeOpen && xs.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: SupremeOptions<String>(
                        label: 'How ${space.name.toLowerCase()} should feel',
                        options: [for (final e in xs) e.id],
                        name: (id) => xs.firstWhere((e) => e.id == id).name,
                        fontSize: 16,
                        value: active?.id,
                        pending: [
                          for (final e in xs)
                            if (experienceStatus(e, snap, commands: view.inFlight, spaceId: space.id).phase ==
                                ExperiencePhase.becoming)
                              e.id
                        ].firstOrNull,
                        onSelect: (id) => _activate(view, xs.firstWhere((e) => e.id == id)),
                      ),
                    ),
                  if (immediate) ImmediateRows(spaceId: space.id, view: view),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
