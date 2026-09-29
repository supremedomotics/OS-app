import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../theme/supreme_colors.dart';

/// A room's picture, taking on the room's CONFIRMED light (Golden Master `tone.js`): the
/// photograph is colour-graded by [look]; the grade eases over 1100 ms so a change reads as
/// light changing in the room, and does not ease at all under reduced motion.
///
/// With no photograph ([image] null) the surface is an honest tonal plate — the same look
/// applied to a dark ground with a soft pool of light — never a stock or invented picture.
class ToneSurface extends StatelessWidget {
  final RoomLook look;
  final ImageProvider? image;
  const ToneSurface({super.key, required this.look, this.image});

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return TweenAnimationBuilder<RoomLook>(
      tween: _LookTween(end: look),
      duration: reduce ? Duration.zero : const Duration(milliseconds: 1100),
      curve: Curves.easeOutCubic,
      builder: (context, l, _) {
        if (image != null) {
          return ColorFiltered(
            colorFilter: ColorFilter.matrix(colorMatrix(l)),
            child: Image(
                image: image!,
                fit: BoxFit.cover,
                width: double.infinity,
                height: double.infinity,
                errorBuilder: (_, __, ___) => _Plate(look: l)),
          );
        }
        return _Plate(look: l);
      },
    );
  }
}

class _LookTween extends Tween<RoomLook> {
  _LookTween({required RoomLook end}) : super(end: end);
  @override
  RoomLook lerp(double t) => RoomLook.lerp(begin ?? end!, end!, t);
}

/// A dark ground with a pool of the room's light: the residence's own brass, stronger as the
/// confirmed light is brighter. It states brightness only — never a colour temperature the devices
/// did not report — and is not a picture of the room. Lights off → the ground alone.
class _Plate extends StatelessWidget {
  final RoomLook look;
  const _Plate({required this.look});

  @override
  Widget build(BuildContext context) {
    final lit = look.exposure > .45;
    final strength = lit ? ((look.exposure - .5) * 1.1 + .16).clamp(0.0, .5) : 0.0;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: SupremeColorScheme.glassSolid,
        gradient: RadialGradient(
          center: const Alignment(.35, -.45),
          radius: 1.15,
          colors: [
            Color.lerp(SupremeColorScheme.glassSolid, SupremeColorScheme.brass, strength * .9)!,
            SupremeColorScheme.glassSolid,
          ],
        ),
      ),
      child: const SizedBox.expand(),
    );
  }
}
