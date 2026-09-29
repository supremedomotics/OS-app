import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import 'activate.dart';

/// Experiences — one vocabulary, a preview of the intended effect, real activation (Golden Master
/// `experiences.js`). An Experience is a desired state of the environment, never a device
/// command list. Whether it is in effect is DERIVED from the devices against its authored steps —
/// there is no "active" flag, and pressing Set changes nothing here except by asking the residence.
///
/// PENDING OWNER DECISIONS: "Make your own" / Edit / Rename / Duplicate / Delete (authoring, D5)
/// are not drawn — there is no authoring contract; the Golden Master's authored per-Experience
/// words and per-system effect text do not exist on the Hub's `Scene`, so the lines shown are
/// derived from its steps.
class ExperiencesScreen extends ConsumerStatefulWidget {
  const ExperiencesScreen({super.key});
  @override
  ConsumerState<ExperiencesScreen> createState() => _ExperiencesScreenState();
}

class _ExperiencesScreenState extends ConsumerState<ExperiencesScreen> {
  // Presentation state only: which scope and which tab are showing.
  String? _spaceId; // null = the whole residence
  String? _selected;

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final profile = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final snap = view?.snapshot;
    final phone = profile.skeleton == SurfaceSkeleton.phone;
    final watch = profile.skeleton == SurfaceSkeleton.watch;
    final pad = watch ? 12.0 : 24.0;

    final children = <Widget>[
      SupremePageHead(kicker: snap?.name ?? '', title: 'Experiences'),
    ];

    if (view == null || snap == null || !snap.loaded) {
      children.add(Text(
          snap?.reachable == false
              ? 'Your residence isn’t reachable right now.'
              : 'Loading your experiences…',
          style: text.body.copyWith(color: SupremeColorScheme.text2)));
      return _page(pad, children);
    }

    // Where: the whole residence, or one of the spaces an Experience acts in.
    final scopes = <String?>[
      null,
      for (final s in snap.spaces)
        if (spaceExperiences(snap, s.id).isNotEmpty) s.id,
    ];
    if (!scopes.contains(_spaceId)) _spaceId = null;
    String scopeName(String? id) =>
        id == null ? 'the whole residence' : 'the ${snap.space(id)!.name.toLowerCase()}';

    final list = _spaceId == null
        ? snap.experiences
        : spaceExperiences(snap, _spaceId!);
    final sel = list.where((e) => e.id == _selected).firstOrNull ??
        list.firstOrNull;

    children.add(Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Text('Shape', style: text.body.copyWith(fontSize: 17, color: SupremeColorScheme.text2)),
          SupremeOptions<String?>(
            label: 'Where',
            options: scopes,
            name: scopeName,
            value: _spaceId,
            fontSize: 17,
            onSelect: (id) => setState(() {
              _spaceId = id;
              _selected = null;
            }),
          ),
        ],
      ),
    ));

    if (sel == null) {
      children.add(Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Text('No experiences are set up here yet.',
            style: text.body.copyWith(color: SupremeColorScheme.text2)),
      ));
      return _page(pad, children);
    }

    final activeHere = _spaceId == null
        ? activeExperienceInResidence(snap, commands: view.inFlight)
        : activeExperienceIn(snap, _spaceId!, commands: view.inFlight);
    final st = experienceStatus(sel, snap, commands: view.inFlight, spaceId: _spaceId);
    final plan = experiencePlan(sel, snap, spaceId: _spaceId);
    final becoming = st.phase == ExperiencePhase.becoming;
    final rows = experiencePreview(sel, snap, commands: view.inFlight, spaceId: _spaceId);
    final look = lookFor(intendedLight(sel, snap, spaceId: _spaceId));

    // tabs
    children.add(Container(
      margin: const EdgeInsets.only(top: 12, bottom: 22),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          for (final e in list)
            SupremeTappable(
              key: ValueKey('exp-tab-${e.id}'),
              onTap: () => setState(() => _selected = e.id),
              semanticLabel: e.name,
              selected: e.id == sel.id,
              radius: 2,
              child: Container(
                constraints: const BoxConstraints(minHeight: 46),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                decoration: BoxDecoration(
                    border: Border(
                        bottom: BorderSide(
                            width: 2,
                            color: e.id == sel.id
                                ? SupremeColorScheme.brassLight
                                : const Color(0x00000000)))),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(e.name,
                      style: text.body.copyWith(
                          fontSize: 15,
                          color: e.id == sel.id
                              ? SupremeColorScheme.text
                              : SupremeColorScheme.text3)),
                  if (activeHere?.id == e.id) ...[
                    const SizedBox(width: 8),
                    Semantics(
                      label: 'active now',
                      child: Container(
                          key: ValueKey('exp-active-${e.id}'),
                          width: 6,
                          height: 6,
                          decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: SupremeColorScheme.brassLight)),
                    ),
                  ],
                ]),
              ),
            ),
        ]),
      ),
    ));

    // hero
    final heroName = text.hero.copyWith(fontSize: phone ? 40 : 56, height: 1);
    children.add(ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        height: watch ? 120 : phone ? 280 : 340,
        child: Stack(fit: StackFit.expand, children: [
          if (!watch) ToneSurface(look: look),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.bottomCenter,
                end: Alignment.topCenter,
                stops: [0, .55, 1],
                colors: [Color(0xEB08090A), Color(0x5908090A), Color(0x2608090A)],
              ),
            ),
          ),
          Padding(
            padding: EdgeInsets.all(watch ? 10 : phone ? 18 : 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.end,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                    (_spaceId == null ? 'Whole residence' : snap.space(_spaceId!)!.name)
                        .toUpperCase(),
                    style: text.kicker.copyWith(letterSpacing: 2.4)),
                const SizedBox(height: 4),
                Text(sel.name, key: const ValueKey('exp-name'), style: heroName),
                const SizedBox(height: 6),
                Text(experienceLine(sel, snap, spaceId: _spaceId),
                    style: text.body.copyWith(fontSize: 16, color: SupremeColorScheme.text2)),
              ],
            ),
          ),
        ]),
      ),
    ));

    // status + the one action
    final statusText = experienceStatusText(st);
    children.add(Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        alignment: WrapAlignment.spaceBetween,
        runSpacing: 12,
        spacing: 12,
        children: [
          if (statusText.isNotEmpty)
            Text(statusText,
                key: const ValueKey('exp-status'),
                style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.brassPale)),
          Opacity(
            opacity: plan.isEmpty || becoming ? .5 : 1,
            child: SupremeTappable(
              key: const ValueKey('exp-set'),
              onTap: plan.isEmpty || becoming
                  ? () {}
                  : () => activateExperience(ref, view, sel, spaceId: _spaceId),
              semanticLabel: becoming
                  ? 'Setting ${sel.name}'
                  : st.phase == ExperiencePhase.active
                      ? 'Set ${sel.name} again'
                      : 'Set ${sel.name}',
              radius: 999,
              child: Container(
                height: 46,
                padding: const EdgeInsets.symmetric(horizontal: 26),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: const Color(0x6B08090A),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: const Color(0x99C9A66B)),
                ),
                child: Text(
                    becoming
                        ? 'Setting…'
                        : st.phase == ExperiencePhase.active
                            ? 'Set again'
                            : 'Set ${sel.name}',
                    style: text.body.copyWith(fontSize: 15, color: SupremeColorScheme.text)),
              ),
            ),
          ),
        ],
      ),
    ));

    // What changes
    children.add(_Label('What changes'));
    if (rows.isEmpty) {
      children.add(Text('Nothing here for this experience to change.',
          style: text.body.copyWith(color: SupremeColorScheme.text2)));
    } else {
      final converging = becoming || st.phase == ExperiencePhase.active;
      for (final r in rows) {
        final stateTxt = r.allArrived
            ? 'Arrived'
            : r.changing > 0
                ? 'Changing · ${r.arrived} of ${r.total}'
                : '${r.arrived} of ${r.total}${r.unreachable > 0 ? ' · ${r.unreachable} not responding' : ''}';
        children.add(Container(
          key: ValueKey('exp-row-${r.system.name}'),
          constraints: const BoxConstraints(minHeight: 60),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
          child: Row(children: [
            SizedBox(
                width: 96,
                child: Text(r.label.toUpperCase(),
                    style: text.body.copyWith(
                        fontSize: 12, letterSpacing: 2.2, color: const Color(0x8FF7F4EE)))),
            Expanded(
                child: Text(r.effect,
                    style: text.name.copyWith(fontSize: phone ? 19 : 22))),
            const SizedBox(width: 12),
            Flexible(
              child: Text(
                  converging
                      ? stateTxt
                      : '${r.count}${r.unreachable > 0 ? ' · ${r.unreachable} not responding, will be skipped' : ''}',
                  textAlign: TextAlign.end,
                  style: text.body.copyWith(
                      fontSize: 13,
                      color: converging && r.allArrived
                          ? SupremeColorScheme.brassPale
                          : SupremeColorScheme.text2)),
            ),
          ]),
        ));
      }
    }

    // Where (whole-residence scope): each space it acts in
    if (_spaceId == null) {
      final where = <String>{
        for (final c in plan) if (snap.devices[c.deviceId]?.roomId != null) snap.devices[c.deviceId]!.roomId!
      };
      if (where.isNotEmpty) {
        children.add(_Label('Where'));
        for (final id in where) {
          final sp = snap.space(id);
          if (sp == null) continue;
          final already = experienceStatus(sel, snap, spaceId: id).phase == ExperiencePhase.active;
          final now = activeExperienceIn(snap, id, commands: view.inFlight);
          children.add(Container(
            key: ValueKey('exp-where-$id'),
            constraints: const BoxConstraints(minHeight: 52),
            decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
            child: Row(children: [
              Expanded(child: Text(sp.name, style: text.name.copyWith(fontSize: 20))),
              Text(already ? 'Already ${sel.name}' : (now?.name ?? 'Own setting'),
                  style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.text2)),
            ]),
          ));
        }
      }
    }
    return _page(pad, children);
  }

  Widget _page(double pad, List<Widget> children) => ListView(
        key: const ValueKey('experiences-page'),
        padding: EdgeInsets.fromLTRB(pad, pad, pad, pad + 32),
        children: children,
      );
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 26, bottom: 6),
        child: Text(text.toUpperCase(),
            style: SupremeTextStyles.resolve(SupremeDensity.comfortable)
                .body
                .copyWith(fontSize: 12, letterSpacing: 2.4, color: const Color(0x8FF7F4EE))),
      );
}
