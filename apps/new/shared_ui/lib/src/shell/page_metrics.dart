import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/surface_scope.dart';
import 'supreme_shell.dart';

/// Where a page's content sits inside the shell — the Golden Master's page geometry
/// (`--sos-gutter`, `--pad-top`, `--pad-bottom`, `.sos-page{max-width:1180px}`), keyed by surface,
/// never by a width alone:
///
///  * gutter: `clamp(16, 4vw, 56)`; phone 18 · TV 48 · watch 10
///  * the gap under the header: desktop 32 · tablet/TV 20 · phone 16 (12 on its side) · watch 4
///  * a page (Spaces, Experiences, Settings) is a centred column at most 1180 wide; a photo-led
///    view (Home, a space) is not — its words hold to the left gutter.
class PageGeometry {
  final double gutter;
  final double top;
  final double bottom;

  const PageGeometry(this.gutter, this.top, this.bottom);

  static const columnMax = 1180.0;

  factory PageGeometry.of(SurfaceProfile p) {
    final w = p.widthDp;
    switch (p.skeleton) {
      case SurfaceSkeleton.watch:
        return const PageGeometry(10, 4, 10);
      case SurfaceSkeleton.phone:
        final side = p.orientation == SurfaceOrientation.landscape;
        return PageGeometry(side ? (w * .04).clamp(16.0, 56.0) : 18, side ? 12 : 16, 20);
      case SurfaceSkeleton.tv:
        return const PageGeometry(48, 20, 56);
      case SurfaceSkeleton.tablet:
        return PageGeometry((w * .04).clamp(16.0, 56.0), 20, 56);
      case SurfaceSkeleton.desktop:
        return PageGeometry((w * .04).clamp(16.0, 56.0), 32, 56);
    }
  }
}

/// A scrolling page: the gutter, the gap under the header, and the 1180 column. Give it the page's
/// children; it draws no chrome of its own.
class SupremePage extends StatelessWidget {
  final List<Widget> children;

  /// Photo-led views are not held to the 1180 column.
  final bool hero;
  const SupremePage({super.key, required this.children, this.hero = false});

  @override
  Widget build(BuildContext context) {
    final p = SurfaceScope.of(context);
    final m = PageGeometry.of(p);
    final under = ShellInsets.of(context).top;
    return LayoutBuilder(builder: (context, c) {
      final extra = hero ? 0.0 : ((c.maxWidth - m.gutter * 2 - PageGeometry.columnMax) / 2).clamp(0.0, double.infinity);
      return ListView(
        padding: EdgeInsets.fromLTRB(
            m.gutter + extra, under + m.top, m.gutter + extra, m.bottom + 32),
        children: children,
      );
    });
  }
}
