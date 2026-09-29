import 'dart:math' as math;

import 'package:flutter/material.dart' show Material;
import 'package:flutter/widgets.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/surface_scope.dart';
import '../glyph/glyph.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_theme.dart';
import 'presence_mark.dart';
import 'supreme_tappable.dart';

/// The space the shell's own chrome takes at the top and on the sides, published to the page so a
/// full-bleed page (Home's photograph) can run *under* the header and still lay its content out
/// clear of it.
class ShellInsets extends InheritedWidget {
  final EdgeInsets padding;
  const ShellInsets({super.key, required this.padding, required super.child});

  static EdgeInsets of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ShellInsets>()?.padding ??
      EdgeInsets.zero;

  @override
  bool updateShouldNotify(ShellInsets old) => old.padding != padding;
}

/// The SupremeOS navigation shell: header chrome, the frame the surface calls for, and the page.
///
/// It draws whatever [ShellNavigation] says (a pure function of `SurfaceProfile`) and decides
/// nothing about the surface itself. The destinations are always the same five; Control is a layer
/// the caller opens through [onOpenControl] — this widget never navigates to it.
///
/// Geometry is the Golden Master's (`docs/design/golden-master-implementation-map.md` §1): phone bar
/// 64, side rail 76 (phone on its side) / 92 (tablet) / 112 (TV), headers 80 / 72 / 56 / 48 / 30.
class SupremeShell extends StatelessWidget {
  final ShellNavigation navigation;
  final ShellDestination current;

  /// Called for Home, Spaces, Experiences and Settings. Never called with [ShellDestination.control].
  final ValueChanged<ShellDestination> onSelect;
  final VoidCallback onOpenControl;
  final Widget body;

  /// The residence's name, shown in the header everywhere except on Home, where the name is the
  /// composition.
  final String residenceName;

  /// Whether the residence link is up. False shows the fading mark: what is on screen is the last
  /// known state.
  final bool residenceReachable;

  /// The scope-named entry to Control ("Residence control", "Living Room control").
  final String controlLabel;

  /// Lay the page out under the header (a full-bleed page). The page then reads [ShellInsets].
  final bool bodyUnderHeader;

  const SupremeShell({
    super.key,
    required this.navigation,
    required this.current,
    required this.onSelect,
    required this.onOpenControl,
    required this.body,
    this.residenceName = '',
    this.residenceReachable = true,
    this.controlLabel = 'Residence control',
    this.bodyUnderHeader = false,
  });

  @override
  Widget build(BuildContext context) {
    if (!navigation.chromeVisible) {
      return Material(color: SupremeColorScheme.night, child: body);
    }
    final profile = SurfaceScope.of(context);
    final safe = MediaQuery.paddingOf(context);
    final c = _Chrome.of(navigation, profile, safe);
    final pagePad = EdgeInsets.only(top: bodyUnderHeader ? 0 : c.header);

    // The chrome already stands clear of the notch, the home indicator and the side cut-outs, so the
    // page must not clear them a second time (a SafeArea inside it would otherwise double the inset).
    final pageBody = MediaQuery.removePadding(
      context: context,
      removeTop: true,
      removeBottom: navigation.frame == ShellFrame.bottomBar,
      removeLeft: navigation.frame == ShellFrame.rail,
      child: body,
    );

    // The background is the Material's own colour, not a box inside it: Material widgets paint ink
    // on the nearest Material, and an opaque box between the two would hide it (Flutter asserts).
    return Material(
      color: SupremeColorScheme.night,
      child: Stack(
        children: [
          Positioned(
            left: c.rail,
            right: 0,
            top: 0,
            bottom: c.bar,
            child: ShellInsets(
              padding: EdgeInsets.only(top: c.header),
              child: Padding(padding: pagePad, child: pageBody),
            ),
          ),
          Positioned(
            left: c.rail,
            right: 0,
            top: 0,
            height: c.header,
            child: _Header(
              chrome: c,
              navigation: navigation,
              profile: profile,
              current: current,
              onSelect: onSelect,
              onOpenControl: onOpenControl,
              residenceName: residenceName,
              reachable: residenceReachable,
              controlLabel: controlLabel,
              safeTop: safe.top,
            ),
          ),
          if (navigation.frame == ShellFrame.bottomBar)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              height: c.bar,
              child: _BottomBar(
                navigation: navigation,
                current: current,
                onSelect: onSelect,
                onOpenControl: onOpenControl,
                safe: safe,
              ),
            ),
          if (navigation.frame == ShellFrame.rail)
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: c.rail,
              child: _Rail(
                navigation: navigation,
                profile: profile,
                current: current,
                onSelect: onSelect,
                onOpenControl: onOpenControl,
                safe: safe,
              ),
            ),
        ],
      ),
    );
  }
}

/// Chrome metrics — Golden Master geometry, keyed by frame (never by a width).
class _Chrome {
  final double header;
  final double rail;
  final double bar;
  final double gutter;
  final double railItemMin;
  final double railItemMax;
  const _Chrome(this.header, this.rail, this.bar, this.gutter,
      {this.railItemMin = 62, this.railItemMax = double.infinity});

  factory _Chrome.of(ShellNavigation nav, SurfaceProfile p, EdgeInsets safe) {
    switch (nav.frame) {
      case ShellFrame.topBar:
        return const _Chrome(80, 0, 0, 56);
      case ShellFrame.bottomBar:
        return _Chrome(56 + safe.top, 0, 64 + safe.bottom, 24);
      case ShellFrame.rail:
        if (p.skeleton == SurfaceSkeleton.phone) {
          // A phone on its side: the bar moves to a slim side rail; the header shrinks.
          return _Chrome(48 + safe.top, 76 + safe.left, 0, 16,
              railItemMin: 44, railItemMax: 72);
        }
        return p.skeleton == SurfaceSkeleton.tv
            ? const _Chrome(72, 112, 0, 48, railItemMin: 74)
            : const _Chrome(72, 92, 0, 40);
      case ShellFrame.none:
        return const _Chrome(30, 0, 0, 10);
    }
  }
}

/// Tailwind's `black` in the Golden Master's header gradient (`from-black/80 via-black/40`).
const _black = Color(0xFF000000);

TextStyle _sans(double size, Color color,
        {FontWeight weight = FontWeight.w400, double tracking = 0}) =>
    TextStyle(
      fontFamily: SupremeFonts.sans,
      fontFamilyFallback: SupremeFonts.sansFallback,
      package: SupremeFonts.package,
      fontSize: size,
      fontWeight: weight,
      letterSpacing: tracking * size,
      color: color,
      height: 1.2,
    );

String _glyphFor(ShellDestination d) => switch (d) {
      ShellDestination.home => 'home',
      ShellDestination.spaces => 'space',
      ShellDestination.control => 'control',
      ShellDestination.experiences => 'transform',
      ShellDestination.settings => 'calibration',
    };

// ───────────────────────────── header ─────────────────────────────

class _Header extends StatelessWidget {
  final _Chrome chrome;
  final ShellNavigation navigation;
  final SurfaceProfile profile;
  final ShellDestination current;
  final ValueChanged<ShellDestination> onSelect;
  final VoidCallback onOpenControl;
  final String residenceName;
  final bool reachable;
  final String controlLabel;
  final double safeTop;

  const _Header({
    required this.chrome,
    required this.navigation,
    required this.profile,
    required this.current,
    required this.onSelect,
    required this.onOpenControl,
    required this.residenceName,
    required this.reachable,
    required this.controlLabel,
    required this.safeTop,
  });

  @override
  Widget build(BuildContext context) {
    final watch = profile.skeleton == SurfaceSkeleton.watch;
    final phone = profile.skeleton == SurfaceSkeleton.phone;
    final wordSize = watch
        ? 9.0
        : phone
            ? 11.0
            : 12.0;
    final wordTrack = watch
        ? .18
        : phone
            ? .24
            : .32;
    final nameSize = watch ? 11.0 : 14.0;
    final showName =
        current != ShellDestination.home && residenceName.isNotEmpty;
    final topBar = navigation.frame == ShellFrame.topBar;

    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            _black.withValues(alpha: .8),
            _black.withValues(alpha: .4),
            _black.withValues(alpha: 0),
          ],
        ),
        border: const Border(
            bottom: BorderSide(color: SupremeColorScheme.faintRule)),
      ),
      child: Padding(
        padding: EdgeInsets.only(
            left: chrome.gutter, right: chrome.gutter, top: safeTop),
        child: Row(
          children: [
            Expanded(
              child: Row(
                children: [
                  SupremeTappable(
                    key: const ValueKey('shell-wordmark'),
                    onTap: () => onSelect(ShellDestination.home),
                    semanticLabel: 'SupremeOS, go to Home',
                    directionalFocus: navigation.directionalFocus,
                    radius: 4,
                    child: ConstrainedBox(
                      // A real target everywhere but the watch, whose header is 30 px tall.
                      constraints: BoxConstraints(minHeight: watch ? 30 : 44),
                      child: Center(
                        widthFactor: 1,
                        child: Text(
                          'SUPREMEOS',
                          // The wordmark is the one place the Golden Master asks for weight 600;
                          // only 300/400 are bundled, so the platform synthesises it.
                          style: _sans(wordSize, SupremeColorScheme.text,
                              weight: FontWeight.w600, tracking: wordTrack),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(width: watch ? 8 : 16),
                  PresenceMark(
                    key: const ValueKey('shell-presence'),
                    present: reachable,
                    size: watch ? 14 : 22,
                    semanticLabel: reachable
                        ? (residenceName.isEmpty
                            ? 'Residence connected'
                            : '$residenceName is connected')
                        : (residenceName.isEmpty
                            ? 'No residence is connected'
                            : 'Reconnecting to $residenceName'),
                  ),
                  SizedBox(width: watch ? 8 : 12),
                  // Hidden, not removed, on Home: the header must not shift when the page changes.
                  Flexible(
                    child: Visibility(
                      visible: showName,
                      maintainSize: true,
                      maintainState: true,
                      maintainAnimation: true,
                      child: Text(
                        residenceName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: _sans(nameSize,
                            SupremeColorScheme.text.withValues(alpha: .9),
                            weight: FontWeight.w300, tracking: .025),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (topBar) ...[
              _PillGroup(
                navigation: navigation,
                current: current,
                onSelect: onSelect,
              ),
              const SizedBox(width: 16),
              _ControlButton(
                label: controlLabel,
                onTap: onOpenControl,
                directionalFocus: navigation.directionalFocus,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Desktop: the top pill group (Home · Spaces · Experiences · Settings).
class _PillGroup extends StatelessWidget {
  final ShellNavigation navigation;
  final ShellDestination current;
  final ValueChanged<ShellDestination> onSelect;
  const _PillGroup(
      {required this.navigation,
      required this.current,
      required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: SupremeColorScheme.glass,
        border: Border.all(color: SupremeColorScheme.glassEdge),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Padding(
        padding: const EdgeInsets.all(4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final item in navigation.items)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1),
                child: SupremeTappable(
                  key: ValueKey('nav-${item.destination.name}'),
                  onTap: () => onSelect(item.destination),
                  semanticLabel: item.semanticLabel,
                  selected: item.destination == current,
                  radius: 999,
                  directionalFocus: navigation.directionalFocus,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: item.destination == current
                          ? SupremeColorScheme.plate
                          : const Color(0x00000000),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 40),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        child: Center(
                          widthFactor: 1,
                          child: Text(
                            item.label,
                            style: _sans(
                                13,
                                item.destination == current
                                    ? SupremeColorScheme.text
                                    : SupremeColorScheme.textIdle,
                                tracking: .04),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Desktop: the outlined, scope-named entry to Control.
class _ControlButton extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  final bool directionalFocus;
  const _ControlButton(
      {required this.label,
      required this.onTap,
      required this.directionalFocus});

  @override
  Widget build(BuildContext context) {
    return SupremeTappable(
      key: const ValueKey('shell-control-button'),
      onTap: onTap,
      semanticLabel: label,
      radius: 999,
      directionalFocus: directionalFocus,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: SupremeColorScheme.veil,
          border: Border.all(color: SupremeColorScheme.brassEdge),
          borderRadius: BorderRadius.circular(999),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.only(left: 14, right: 18),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SupremeGlyph('control',
                    size: 19, color: SupremeColorScheme.brassLight),
                const SizedBox(width: 10),
                Text(label,
                    style:
                        _sans(13, SupremeColorScheme.champagne, tracking: .04)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── phone: bottom bar ─────────────────────────────

class _BottomBar extends StatelessWidget {
  final ShellNavigation navigation;
  final ShellDestination current;
  final ValueChanged<ShellDestination> onSelect;
  final VoidCallback onOpenControl;
  final EdgeInsets safe;
  const _BottomBar(
      {required this.navigation,
      required this.current,
      required this.onSelect,
      required this.onOpenControl,
      required this.safe});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: SupremeColorScheme.bar,
        border: Border(top: BorderSide(color: SupremeColorScheme.glassEdge)),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
            math.max(6, safe.left), 4, math.max(6, safe.right), safe.bottom),
        child: Row(
          children: [
            for (final item in navigation.items)
              Expanded(
                child: _StackedNavItem(
                  item: item,
                  selected: item.destination == current,
                  onTap: () => item.destination == ShellDestination.control
                      ? onOpenControl()
                      : onSelect(item.destination),
                  directionalFocus: navigation.directionalFocus,
                  labelSize: 10.5,
                  glyphSize: 22,
                  minHeight: 56,
                  radius: 12,
                  plate: false,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ───────────────────────────── tablet / TV / phone on its side: rail ─────────────────────────────

class _Rail extends StatelessWidget {
  final ShellNavigation navigation;
  final SurfaceProfile profile;
  final ShellDestination current;
  final ValueChanged<ShellDestination> onSelect;
  final VoidCallback onOpenControl;
  final EdgeInsets safe;
  const _Rail(
      {required this.navigation,
      required this.profile,
      required this.current,
      required this.onSelect,
      required this.onOpenControl,
      required this.safe});

  @override
  Widget build(BuildContext context) {
    final c = _Chrome.of(navigation, profile, safe);
    final tv = profile.skeleton == SurfaceSkeleton.tv;
    final phone = profile.skeleton == SurfaceSkeleton.phone;
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: SupremeColorScheme.rail,
        border: Border(right: BorderSide(color: SupremeColorScheme.glassEdge)),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(6 + safe.left, phone ? 6 : 12 + safe.top,
            6, phone ? 6 : 12 + safe.bottom),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < navigation.items.length; i++) ...[
              if (i > 0) const SizedBox(height: 4),
              Flexible(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                      minHeight: c.railItemMin, maxHeight: c.railItemMax),
                  child: _StackedNavItem(
                    item: navigation.items[i],
                    selected: navigation.items[i].destination == current,
                    onTap: () => navigation.items[i].destination ==
                            ShellDestination.control
                        ? onOpenControl()
                        : onSelect(navigation.items[i].destination),
                    directionalFocus: navigation.directionalFocus,
                    labelSize: phone
                        ? 10
                        : tv
                            ? 12
                            : 11,
                    glyphSize: phone
                        ? 20
                        : tv
                            ? 26
                            : 22,
                    minHeight: c.railItemMin,
                    radius: 14,
                    plate: true,
                    controlRing: phone,
                    controlBrassGlyph: !phone,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A glyph over a label — the phone bar's and the rail's item.
class _StackedNavItem extends StatelessWidget {
  final ShellNavItem item;
  final bool selected;
  final VoidCallback onTap;
  final bool directionalFocus;
  final double labelSize;
  final double glyphSize;
  final double minHeight;
  final double radius;

  /// A filled plate behind the current item (rail) rather than a colour change only (bar).
  final bool plate;

  /// Control's glyph sits in a brass-ringed pill (phone, in the bar and on its side).
  final bool controlRing;

  /// Control's glyph is brass-light (tablet and TV rails).
  final bool controlBrassGlyph;

  const _StackedNavItem({
    required this.item,
    required this.selected,
    required this.onTap,
    required this.directionalFocus,
    required this.labelSize,
    required this.glyphSize,
    required this.minHeight,
    required this.radius,
    required this.plate,
    this.controlRing = true,
    this.controlBrassGlyph = false,
  });

  @override
  Widget build(BuildContext context) {
    final isControl = item.destination == ShellDestination.control;
    final labelColor = selected || (isControl && controlRing)
        ? SupremeColorScheme.champagne
        : selected
            ? SupremeColorScheme.text
            : SupremeColorScheme.textIdle;
    final glyphColor = selected || (isControl && controlBrassGlyph)
        ? SupremeColorScheme.brassLight
        : isControl && controlRing
            ? SupremeColorScheme.champagne
            : SupremeColorScheme.textIdle;

    Widget glyph = SupremeGlyph(_glyphFor(item.destination),
        size: glyphSize, color: glyphColor);
    if (isControl && controlRing) {
      glyph = Container(
        width: 44,
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(15),
          border: Border.all(
              color: SupremeColorScheme.brassLight.withValues(alpha: .5)),
        ),
        child: SupremeGlyph('control', size: glyphSize - 2, color: glyphColor),
      );
    }

    return SupremeTappable(
      key: ValueKey('nav-${item.destination.name}'),
      onTap: onTap,
      semanticLabel: item.semanticLabel,
      selected: selected,
      radius: radius,
      directionalFocus: directionalFocus,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: plate && selected
              ? SupremeColorScheme.plate
              : const Color(0x00000000),
          borderRadius: BorderRadius.circular(radius),
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: minHeight),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                glyph,
                const SizedBox(height: 3),
                Text(
                  item.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: _sans(labelSize, labelColor, tracking: .02),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
