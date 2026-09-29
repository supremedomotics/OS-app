import 'package:flutter/widgets.dart';

import '../theme/supreme_colors.dart';
import '../theme/supreme_curves.dart';

/// The residence's mark: the five rings where the residence "landed" in SupremeOS's field, with a
/// core. It is the residence-link indicator on every surface — brass and steady while the residence
/// answers, faded with a hollow core while it is being reconnected to (the last known state is
/// shown meanwhile). Geometry from the Golden Master's own mark.
class PresenceMark extends StatelessWidget {
  final bool present;
  final double size;
  final String? semanticLabel;

  const PresenceMark(
      {super.key, required this.present, this.size = 22, this.semanticLabel});

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Semantics(
      label: semanticLabel,
      image: true,
      child: ExcludeSemantics(
        child: AnimatedOpacity(
          duration: still ? Duration.zero : const Duration(milliseconds: 600),
          curve: SupremeMotionCurves.settle,
          opacity: present ? 1 : .45,
          child: SizedBox(
            width: size,
            height: size,
            child: CustomPaint(painter: _MarkPainter(present)),
          ),
        ),
      ),
    );
  }
}

/// Which of the field's eight rings the residence's five rings settle onto.
const _received = [0, 2, 4, 5, 7];
double _ring(int i) => 228 * (.28 + .72 * i / 7);

/// The mark's ring radii on its 200-unit grid (−100…100).
List<double> presenceRingRadii() => [for (final i in _received) _ring(i) * .42];

class _MarkPainter extends CustomPainter {
  final bool present;
  const _MarkPainter(this.present);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(size.width / 200, size.height / 200);
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.2
      ..color = SupremeColorScheme.brassLight.withValues(alpha: .75);
    for (final r in presenceRingRadii()) {
      canvas.drawCircle(Offset.zero, r, ring);
    }
    if (present) {
      canvas.drawCircle(Offset.zero, 12.5,
          Paint()..color = SupremeColorScheme.brass);
    } else {
      canvas.drawCircle(
          Offset.zero,
          12.5,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.2
            ..color = SupremeColorScheme.brass);
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.present != present;
}
