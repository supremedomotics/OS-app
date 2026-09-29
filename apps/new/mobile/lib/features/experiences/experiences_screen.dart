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
    final wide = profile.widthDp >= 700 && !watch;

    final children = <Widget>[
      SupremePageHead(kicker: snap?.name ?? '', title: 'Experiences'),
    ];

    if (view == null || snap == null || !snap.loaded) {
      children.add(Text(
          snap?.reachable == false
              ? 'Your residence isn’t reachable right now.'
              : 'Loading your experiences…',
          style: text.body.copyWith(color: SupremeColorScheme.text2)));
      return _page(children);
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
        children: [
          Text('Shape ', style: text.body.copyWith(fontSize: 17, color: SupremeColorScheme.text2)),
          _WherePicker(
            scopes: scopes,
            current: _spaceId,
            name: scopeName,
            onPick: (id) => setState(() {
              _spaceId = id;
              _selected = null;
            }),
          ),
          Text('.', style: text.body.copyWith(fontSize: 17, color: SupremeColorScheme.text2)),
        ],
      ),
    ));

    if (sel == null) {
      children.add(Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Text('No experiences are set up here yet.',
            style: text.body.copyWith(color: SupremeColorScheme.text2)),
      ));
      return _page(children);
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
    final statusText = experienceStatusText(st);
    final scopeKicker =
        (_spaceId == null ? 'Whole residence' : snap.space(_spaceId!)!.name).toUpperCase();
    final line = experienceLine(sel, snap, spaceId: _spaceId);
    final setLabel = becoming
        ? 'Setting…'
        : st.phase == ExperiencePhase.active
            ? 'Set again'
            : 'Set ${sel.name}';
    Widget setButton() => IntrinsicWidth(
        child: Opacity(
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
              child: Text(setLabel,
                  style: text.body.copyWith(fontSize: 15, color: SupremeColorScheme.text)),
            ),
          ),
        ));
    Widget status() => statusText.isEmpty
        ? const SizedBox.shrink()
        : Text(statusText,
            key: const ValueKey('exp-status'),
            textAlign: wide ? TextAlign.end : TextAlign.center,
            style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.brassPale));

    final heroPicture = ToneSurface(look: look);
    const scrim = DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.bottomCenter,
          end: Alignment.topCenter,
          stops: [0, .55, 1],
          colors: [Color(0xEB08090A), Color(0x5908090A), Color(0x2608090A)],
        ),
      ),
    );
    final words = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(scopeKicker,
            style: text.body.copyWith(
                fontSize: wide ? 16 : 15,
                letterSpacing: (wide ? 16 : 15) * .2,
                color: SupremeColorScheme.text2)),
        const SizedBox(height: 4),
        Text(sel.name,
            key: const ValueKey('exp-name'),
            style: text.hero.copyWith(fontSize: phone ? 40 : (profile.widthDp * .05).clamp(40.0, 64.0), height: 1)),
        const SizedBox(height: 6),
        Text(line,
            style: text.body.copyWith(fontSize: 16, color: SupremeColorScheme.text2)),
      ],
    );

    if (wide) {
      // A wide surface: the picture carries the words, and the one action sits in its corner.
      children.add(ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          height: (profile.heightDp * .42).clamp(300.0, 460.0),
          child: Stack(fit: StackFit.expand, children: [
            heroPicture,
            scrim,
            Padding(
              padding: const EdgeInsets.all(32),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(child: words),
                  const SizedBox(width: 20),
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [status(), const SizedBox(height: 10), setButton()],
                  ),
                ],
              ),
            ),
          ]),
        ),
      ));
    } else if (watch) {
      children.add(Container(
        padding: const EdgeInsets.all(10),
        color: SupremeColorScheme.glassSolid,
        child: words,
      ));
      children.add(Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Center(child: setButton())));
    } else {
      // A phone: the picture on its own (16:9), then the words, then the one action, centred.
      children.add(ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: AspectRatio(
            aspectRatio: 16 / 9,
            child: Stack(fit: StackFit.expand, children: [
              heroPicture,
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.bottomCenter,
                    end: Alignment.center,
                    colors: [Color(0x5908090A), Color(0x0008090A)],
                  ),
                ),
              ),
            ])),
      ));
      children.add(Padding(padding: const EdgeInsets.only(top: 16), child: words));
      children.add(Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Column(children: [
          status(),
          if (statusText.isNotEmpty) const SizedBox(height: 10),
          setButton(),
        ]),
      ));
    }

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
    return _page(children);
  }

  Widget _page(List<Widget> children) =>
      SupremePage(key: const ValueKey('experiences-page'), children: children);
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

/// "the whole residence ▾" — the Golden Master's one sentence with one choice in it (a native
/// select there). A quiet underlined phrase; the list opens as a menu in the shell's own surface.
class _WherePicker extends StatelessWidget {
  final List<String?> scopes;
  final String? current;
  final String Function(String?) name;
  final ValueChanged<String?> onPick;
  const _WherePicker(
      {required this.scopes,
      required this.current,
      required this.name,
      required this.onPick});

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    return PopupMenuButton<String>(
      key: const ValueKey('exp-where-picker'),
      tooltip: 'Where',
      color: SupremeColorScheme.glassSolid,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(6),
          side: const BorderSide(color: SupremeColorScheme.glassEdge)),
      onSelected: (v) => onPick(v.isEmpty ? null : v),
      itemBuilder: (_) => [
        for (final s in scopes)
          PopupMenuItem<String>(
            value: s ?? '',
            child: Text(name(s),
                style: text.body.copyWith(
                    fontSize: 16,
                    color: s == current ? SupremeColorScheme.text : SupremeColorScheme.text2)),
          ),
      ],
      child: Container(
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: 2),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.brass))),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(name(current), style: text.body.copyWith(fontSize: 17, color: SupremeColorScheme.text)),
          const SizedBox(width: 6),
          const SizedBox(width: 10, height: 6, child: CustomPaint(painter: _Caret())),
        ]),
      ),
    );
  }
}

class _Caret extends CustomPainter {
  const _Caret();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawPath(
        Path()
          ..moveTo(0, 0)
          ..lineTo(size.width, 0)
          ..lineTo(size.width / 2, size.height)
          ..close(),
        Paint()..color = SupremeColorScheme.text2);
  }

  @override
  bool shouldRepaint(_Caret o) => false;
}
