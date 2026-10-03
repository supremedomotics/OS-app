import 'package:flutter/widgets.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

const double _bannerContentHeight = 24;

/// The words shown (and spoken) whenever the simulated residence is feeding the app.
const simulationBannerText = 'DEMO · SIMULATED RESIDENCE';

/// A persistent strip across the top of every route while the simulator is active, so simulated
/// state can never be mistaken for a real residence. It takes the status-bar inset itself, then
/// removes it from what the app below sees, so nothing underneath is overlapped or clipped.
///
/// Mounted in `MaterialApp.builder` (every route, dialog and layer) and only when
/// `simulatedResidenceProvider` is non-null — i.e. only in a build compiled with
/// `SUPREME_SIMULATED_RESIDENCE=true`. It draws nothing otherwise.
class SimulationBanner extends StatelessWidget {
  final bool active;
  final Widget child;
  const SimulationBanner(
      {super.key, required this.active, required this.child});

  @override
  Widget build(BuildContext context) {
    if (!active) return child;
    final top = MediaQuery.paddingOf(context).top;
    final bannerHeight = top + _bannerContentHeight;
    // The app is laid out below the banner but PAINTED FIRST: an opaque route inside the Navigator
    // blocks the semantics of everything painted before it (BlockSemantics), so a banner drawn
    // earlier would be invisible to a screen reader. Painted last, it is announced.
    return Stack(
      children: [
        Positioned(
          top: bannerHeight,
          left: 0,
          right: 0,
          bottom: 0,
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            child: child,
          ),
        ),
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          height: bannerHeight,
          child: Semantics(
            container: true,
            excludeSemantics: true,
            textDirection: TextDirection.ltr,
            label: 'Demo. This is a simulated residence, not your home.',
            child: Container(
              padding: EdgeInsets.only(top: top),
              color: SupremeColorScheme.brass,
              alignment: Alignment.bottomCenter,
              child: SizedBox(
                height: _bannerContentHeight,
                child: Center(
                  child: Text(
                    simulationBannerText,
                    textDirection: TextDirection.ltr,
                    style: const TextStyle(
                      fontFamily: SupremeFonts.sans,
                      package: SupremeFonts.package,
                      fontSize: 11,
                      fontWeight: FontWeight.w400,
                      letterSpacing: 2.2,
                      color: SupremeColorScheme.onIvory,
                      decoration: TextDecoration.none,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
