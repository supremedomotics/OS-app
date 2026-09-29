import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../_shared/residence_presentation.dart';

/// Spaces — the physical architecture of the residence (Golden Master `spaces.js`): floors, each
/// a run of photographic plates in an asymmetric rhythm (wide+narrow, narrow+wide, a single
/// panorama). Every word on a plate is derived from confirmed device state; there are no device
/// statistics and no controls here — a plate opens the space.
class SpacesScreen extends ConsumerWidget {
  final void Function(Space) onOpenSpace;
  const SpacesScreen({super.key, required this.onOpenSpace});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final hour = ref.watch(residenceHourProvider);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final snap = view?.snapshot;

    final children = <Widget>[
      SupremePageHead(kicker: snap?.name ?? '', title: 'Spaces'),
    ];
    if (snap == null || !snap.loaded) {
      children.add(_Quiet(
          snap?.reachable == false
              ? 'Your residence isn’t reachable right now.'
              : 'Loading your spaces…',
          text));
    } else if (snap.spaces.isEmpty) {
      children.add(_Quiet('No Spaces yet', text));
    } else {
      for (final group in floorsOf(snap.spaces)) {
        children.add(_Floor(
          label: floorLabel(group.floorId),
          plates: [
            for (final s in group.spaces)
              plateFor(context, ref, s, snap, view!.inFlight, hour, () => onOpenSpace(s)),
          ],
        ));
      }
    }
    return SupremePage(key: const ValueKey('spaces-page'), children: children);
  }
}

class _Quiet extends StatelessWidget {
  final String text;
  final SupremeTextStyles styles;
  const _Quiet(this.text, this.styles);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 24),
        child: Text(text,
            style: styles.body.copyWith(color: SupremeColorScheme.text2)),
      );
}

class _Floor extends StatelessWidget {
  final String label;
  final List<Widget> plates;
  const _Floor({required this.label, required this.plates});

  @override
  Widget build(BuildContext context) {
    final profile = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final watch = profile.skeleton == SurfaceSkeleton.watch;
    return Padding(
      padding: EdgeInsets.only(bottom: watch ? 18 : 56),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (label.isNotEmpty)
            Container(
              width: double.infinity,
              padding: EdgeInsets.only(bottom: watch ? 6 : 14),
              margin: EdgeInsets.only(bottom: watch ? 6 : 22),
              decoration: const BoxDecoration(
                  border: Border(
                      bottom: BorderSide(color: SupremeColorScheme.rule))),
              child: Text(label,
                  style: text.name.copyWith(fontSize: watch ? 16 : 28)),
            ),
          LayoutBuilder(builder: (context, c) {
            // The prototype's 900px rule: below it every plate takes the full width.
            final narrow = c.maxWidth < 900 || watch;
            final gap = watch ? 4.0 : 28.0;
            final rows = <Widget>[];
            for (var i = 0; i < plates.length; i += 2) {
              final pair = plates.sublist(i, i + 2 > plates.length ? plates.length : i + 2);
              final alt = (i ~/ 2).isOdd;
              if (pair.length == 1) {
                rows.add(_Aspect(pair[0], watch ? null : 21 / 8, narrow));
              } else if (narrow) {
                rows.add(_Aspect(pair[0], watch ? null : 16 / 9, narrow));
                rows.add(SizedBox(height: gap));
                rows.add(_Aspect(pair[1], watch ? null : 16 / 10, narrow));
              } else {
                rows.add(IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                          flex: alt ? 5 : 8,
                          child: alt
                              ? ConstrainedBox(
                                  constraints:
                                      const BoxConstraints(minHeight: 220),
                                  child: pair[0])
                              : AspectRatio(aspectRatio: 16 / 9, child: pair[0])),
                      SizedBox(width: gap),
                      Expanded(
                          flex: alt ? 7 : 4,
                          child: alt
                              ? AspectRatio(aspectRatio: 16 / 10, child: pair[1])
                              : ConstrainedBox(
                                  constraints:
                                      const BoxConstraints(minHeight: 220),
                                  child: pair[1])),
                    ],
                  ),
                ));
              }
              if (i + 2 < plates.length) rows.add(SizedBox(height: gap));
            }
            return Column(children: rows);
          }),
        ],
      ),
    );
  }
}

class _Aspect extends StatelessWidget {
  final Widget child;
  final double? ratio;
  final bool narrow;
  const _Aspect(this.child, this.ratio, this.narrow);
  @override
  Widget build(BuildContext context) => ratio == null
      ? child
      : AspectRatio(aspectRatio: ratio!, child: child);
}
