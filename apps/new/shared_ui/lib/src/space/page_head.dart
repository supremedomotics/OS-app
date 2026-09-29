import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/surface_scope.dart';
import '../theme/supreme_theme.dart';

/// The page header every Golden Master page opens with: a brass kicker (the residence or floor)
/// over a serif page title. Type follows the fluid scale; the watch takes its own small size.
class SupremePageHead extends StatelessWidget {
  final String kicker;
  final String title;
  const SupremePageHead({super.key, required this.kicker, required this.title});

  @override
  Widget build(BuildContext context) {
    final p = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final watch = p.skeleton == SurfaceSkeleton.watch;
    final phone = p.skeleton == SurfaceSkeleton.phone;
    return Padding(
      padding: EdgeInsets.only(bottom: watch ? 10 : 26),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (kicker.isNotEmpty)
            Text(kicker.toUpperCase(),
                style: text.kicker.copyWith(fontSize: watch ? 9 : null)),
          SizedBox(height: watch ? 2 : 4),
          Text(title,
              style: text.pageTitle.copyWith(
                  fontSize: watch ? 24 : phone ? 34 : null, height: 1.05)),
        ],
      ),
    );
  }
}
