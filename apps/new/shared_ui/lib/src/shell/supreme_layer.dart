import 'package:flutter/material.dart' show Material, MaterialType;
import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../theme/supreme_colors.dart';
import '../theme/supreme_curves.dart';

/// Opens a layer over the current page — the Control layer, and later the device sheet — in the
/// expression the surface calls for (`ShellNavigation.controlPresentation`):
///
///  * [ControlLayerPresentation.sheet] — a bottom sheet 88 % high with a grab handle;
///  * [ControlLayerPresentation.drawer] — a right-hand drawer, 520 wide at most;
///  * [ControlLayerPresentation.secondSegment] / [ControlLayerPresentation.lowerSegment] — docked on
///    the far side of the hinge. **Nothing interactive or written crosses the hinge**, so the layer
///    starts at the hinge's far edge.
///
/// Back closes it (it is a route). Reduced motion removes the slide.
Future<T?> showSupremeLayer<T>(
  BuildContext context, {
  required ControlLayerPresentation presentation,
  SurfaceFold? fold,
  required WidgetBuilder builder,
  String? semanticLabel,

  /// Opened from inside another layer (the device sheet over Devices over Control): the surface is
  /// fully opaque, so the layer beneath — which occupies the same rectangle on a drawer — cannot
  /// show through as ghost text.
  bool stacked = false,
}) {
  final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  // A plain route, not showGeneralDialog: a dialog wraps its page in DisplayFeatureSubScreen, which
  // would re-lay the page out inside ONE side of the hinge and defeat the hinge-docking below.
  return Navigator.of(context, rootNavigator: true).push<T>(PageRouteBuilder<T>(
    opaque: false,
    barrierDismissible: true,
    barrierLabel: 'Close',
    barrierColor: const Color(0x40000000),
    transitionDuration: still ? Duration.zero : SupremeMotionCurves.layer,
    reverseTransitionDuration: still ? Duration.zero : SupremeMotionCurves.layer,
    pageBuilder: (ctx, _, __) => Semantics(
      scopesRoute: true,
      namesRoute: true,
      explicitChildNodes: true,
      label: semanticLabel,
      child: SupremeLayerFrame(
          presentation: presentation, fold: fold, stacked: stacked, child: builder(ctx)),
    ),
    transitionsBuilder: (ctx, animation, _, child) {
      final curved = CurvedAnimation(
          parent: animation, curve: SupremeMotionCurves.settle);
      final from = switch (presentation) {
        ControlLayerPresentation.sheet ||
        ControlLayerPresentation.lowerSegment =>
          const Offset(0, 1),
        ControlLayerPresentation.drawer ||
        ControlLayerPresentation.secondSegment =>
          const Offset(1, 0),
      };
      return SlideTransition(
        position: Tween<Offset>(begin: from, end: Offset.zero).animate(curved),
        child: child,
      );
    },
  ));
}

/// Where a layer sits within the area it is opened over. Public so tests (and the shell) can lay a
/// layer out without a route.
class SupremeLayerFrame extends StatelessWidget {
  final ControlLayerPresentation presentation;
  final SurfaceFold? fold;
  final bool stacked;
  final Widget child;
  const SupremeLayerFrame(
      {super.key,
      required this.presentation,
      required this.fold,
      required this.child,
      this.stacked = false});

  static const drawerWidth = 520.0;
  static const sheetFraction = .88;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final safe = MediaQuery.paddingOf(context);
      switch (presentation) {
        case ControlLayerPresentation.sheet:
          return Align(
            alignment: Alignment.bottomCenter,
            child: SizedBox(
              height: box.maxHeight * sheetFraction,
              width: box.maxWidth,
              child: _Surface(
                solid: stacked,
                radius: const BorderRadius.vertical(top: Radius.circular(22)),
                edge: const Border(
                    top: BorderSide(color: SupremeColorScheme.glassEdge)),
                topInset: 0,
                bottomInset: safe.bottom,
                grabHandle: true,
                child: child,
              ),
            ),
          );
        case ControlLayerPresentation.drawer:
          return Align(
            alignment: Alignment.centerRight,
            child: SizedBox(
              width: box.maxWidth < drawerWidth ? box.maxWidth : drawerWidth,
              height: box.maxHeight,
              child: _Surface(
                solid: stacked,
                radius: BorderRadius.zero,
                edge: const Border(
                    left: BorderSide(color: SupremeColorScheme.glassEdge)),
                topInset: safe.top,
                bottomInset: safe.bottom,
                child: child,
              ),
            ),
          );
        case ControlLayerPresentation.secondSegment:
          final start = fold?.end ?? box.maxWidth / 2;
          return Stack(children: [
            Positioned.fill(
              left: start,
              child: _Surface(
                solid: stacked,
                radius: BorderRadius.zero,
                edge: const Border(
                    left: BorderSide(color: SupremeColorScheme.glassEdge)),
                topInset: safe.top,
                bottomInset: safe.bottom,
                child: child,
              ),
            ),
          ]);
        case ControlLayerPresentation.lowerSegment:
          final start = fold?.end ?? box.maxHeight / 2;
          return Stack(children: [
            Positioned.fill(
              top: start,
              child: _Surface(
                solid: stacked,
                radius: BorderRadius.zero,
                edge: const Border(
                    top: BorderSide(color: SupremeColorScheme.glassEdge)),
                topInset: 0,
                bottomInset: safe.bottom,
                child: child,
              ),
            ),
          ]);
      }
    });
  }
}

class _Surface extends StatelessWidget {
  final bool solid;
  final BorderRadius radius;
  final Border edge;
  final double topInset;
  final double bottomInset;
  final bool grabHandle;
  final Widget child;
  const _Surface(
      {required this.solid,
      required this.radius,
      required this.edge,
      required this.topInset,
      required this.bottomInset,
      required this.child,
      this.grabHandle = false});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: solid ? SupremeColorScheme.glassSolid.withValues(alpha: 1) : SupremeColorScheme.glassSolid,
        border: edge,
        borderRadius: radius,
      ),
      // A layer is a route: it has no Material ancestor of its own, so without one its text would
      // draw with the framework's default (yellow double underline) and controls could not paint ink.
      child: Material(
        type: MaterialType.transparency,
        child: ClipRRect(
        borderRadius: radius,
        child: Padding(
          padding: EdgeInsets.only(top: topInset, bottom: bottomInset),
          child: Column(
            children: [
              if (grabHandle)
                Padding(
                  padding: const EdgeInsets.only(top: 8, bottom: 6),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: SupremeColorScheme.text.withValues(alpha: .25),
                      borderRadius: BorderRadius.circular(2),
                    ),
                    child: const SizedBox(width: 36, height: 4),
                  ),
                ),
              Expanded(child: child),
            ],
          ),
        ),
        ),
      ),
    );
  }
}
