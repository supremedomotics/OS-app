import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/surface_scope.dart';
import '../shell/supreme_tappable.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_theme.dart';
import 'tone_surface.dart';

/// A space as a photographic plate (Golden Master `spaces.js`): the room itself, its name, and
/// what it feels like now — no device statistics. Kicker = the Experience in effect; flag =
/// what needs a look, or "Adjusting…" while a command is in flight.
///
/// On the watch the plate is a text row (no picture, hairline below), as in the prototype.
class SpacePlate extends StatelessWidget {
  final String name;
  final String? kicker;
  final String line;
  final String? flag;
  final bool flagQuiet;
  final RoomLook look;
  final ImageProvider? image;

  /// Height ÷ width when the parent gives a width; null lets the parent size the plate.
  final double? aspectRatio;
  final String semanticLabel;
  final VoidCallback onTap;

  const SpacePlate({
    super.key,
    required this.name,
    required this.line,
    required this.look,
    required this.semanticLabel,
    required this.onTap,
    this.kicker,
    this.flag,
    this.flagQuiet = false,
    this.image,
    this.aspectRatio,
  });

  @override
  Widget build(BuildContext context) {
    final p = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final watch = p.skeleton == SurfaceSkeleton.watch;
    final phone = p.skeleton == SurfaceSkeleton.phone;

    final words = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (kicker != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(kicker!.toUpperCase(),
                style: text.kicker.copyWith(letterSpacing: 2.2)),
          ),
        Text(name,
            style: text.name.copyWith(
                fontSize: watch ? 18 : phone ? 28 : 34, height: 1, shadows: const [
              Shadow(color: Color(0x80000000), blurRadius: 16, offset: Offset(0, 1))
            ])),
        if (line.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(line,
                style: text.body.copyWith(
                    fontSize: watch ? 12 : 14,
                    color: SupremeColorScheme.text2)),
          ),
      ],
    );

    if (watch) {
      return SupremeTappable(
        onTap: onTap,
        semanticLabel: semanticLabel,
        radius: 4,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
          alignment: Alignment.centerLeft,
          child: words,
        ),
      );
    }

    final plate = ClipRRect(
      borderRadius: BorderRadius.circular(4),
      child: DecoratedBox(
        decoration: BoxDecoration(
            border: Border.all(color: const Color(0x0FFFFFFF)),
            borderRadius: BorderRadius.circular(4)),
        child: Stack(
          fit: StackFit.expand,
          children: [
            ToneSurface(look: look, image: image),
            // The legibility gradient the prototype lays under the words.
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.center,
                  stops: [0, .5, 1],
                  colors: [Color(0xC708090A), Color(0x5708090A), Color(0x0008090A)],
                ),
              ),
            ),
            if (flag != null) Positioned(left: 12, top: 12, child: _Flag(flag!, flagQuiet)),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Padding(
                padding: EdgeInsets.all(phone ? 16 : 24),
                child: words,
              ),
            ),
          ],
        ),
      ),
    );

    return SupremeTappable(
      onTap: onTap,
      semanticLabel: semanticLabel,
      radius: 4,
      child: aspectRatio == null
          ? plate
          : AspectRatio(aspectRatio: aspectRatio!, child: plate),
    );
  }
}

class _Flag extends StatelessWidget {
  final String text;
  final bool quiet;
  const _Flag(this.text, this.quiet);
  @override
  Widget build(BuildContext context) {
    final t = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0xB808090A),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
            color: quiet ? const Color(0x33FFFFFF) : SupremeColorScheme.brassEdge),
      ),
      child: Text(text,
          style: t.body.copyWith(
              fontSize: 12,
              color: quiet ? SupremeColorScheme.text2 : SupremeColorScheme.brassPale)),
    );
  }
}
