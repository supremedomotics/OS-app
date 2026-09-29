import 'dart:ui' show DisplayFeature, Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// The shell draws whatever `shellNavigationFor(SurfaceProfile)` says. These tests run the real
/// widgets at the surfaces of the responsive matrix and check the Golden Master's geometry, that
/// nothing overflows, that every control is a real target, and that it works from a keyboard and a
/// remote.
class _Probe {
  ShellDestination? selected;
  int control = 0;
  EdgeInsets? insets;
}

const _name = 'Villa Son Vida';

Widget _shell(
  Size size,
  _Probe probe, {
  SurfacePanelBinding? panel,
  bool tv = false,
  SurfacePointer pointer = SurfacePointer.coarse,
  ShellDestination current = ShellDestination.home,
  String? room,
  bool reachable = true,
  List<DisplayFeature> features = const [],
  EdgeInsets padding = EdgeInsets.zero,
  ValueChanged<EdgeInsets>? onBodyPadding,
  bool underHeader = false,
}) {
  return MediaQuery(
    data: MediaQueryData(
        size: size, displayFeatures: features, padding: padding),
    child: MaterialApp(
      theme: buildSupremeTheme(),
      home: SurfaceScope(
        installedPanel: panel,
        pointer: pointer,
        isTelevision: tv,
        child: Builder(builder: (ctx) {
          final nav =
              shellNavigationFor(SurfaceScope.of(ctx), boundSpaceName: room);
          return SupremeShell(
            navigation: nav,
            current: current,
            onSelect: (d) => probe.selected = d,
            onOpenControl: () => probe.control++,
            residenceName: _name,
            residenceReachable: reachable,
            bodyUnderHeader: underHeader,
            body: Builder(builder: (c) {
              probe.insets = ShellInsets.of(c);
              onBodyPadding?.call(MediaQuery.paddingOf(c));
              return const SizedBox.expand(key: ValueKey('page'));
            }),
          );
        }),
      ),
    ),
  );
}

/// Sizes the real test surface (not only `MediaQuery`) so layout runs at the size under test, then
/// pumps the shell.
Future<void> _pump(
  WidgetTester tester,
  Size size,
  _Probe probe, {
  SurfacePanelBinding? panel,
  bool tv = false,
  SurfacePointer pointer = SurfacePointer.coarse,
  ShellDestination current = ShellDestination.home,
  String? room,
  bool reachable = true,
  bool underHeader = false,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(_shell(size, probe,
      underHeader: underHeader,
      panel: panel,
      tv: tv,
      pointer: pointer,
      current: current,
      room: room,
      reachable: reachable));
}

Finder _nav(ShellDestination d) => find.byKey(ValueKey('nav-${d.name}'));
Rect _page(WidgetTester t) => t.getRect(find.byKey(const ValueKey('page')));

const _phone = Size(390, 844);
const _phoneSide = Size(844, 390);
const _tablet = Size(834, 1112);
const _desktop = Size(1440, 900);
const _tvSize = Size(1920, 1080);
const _watch = Size(198, 242);

void main() {
  group('frames — the Golden Master geometry', () {
    testWidgets('phone: a 64 px bar pinned to the bottom, five items, Control in the centre',
        (tester) async {
      await _pump(tester, _phone, _Probe());
      for (final d in ShellDestination.values) {
        expect(_nav(d), findsOneWidget, reason: d.name);
      }
      final home = tester.getRect(_nav(ShellDestination.home));
      final control = tester.getRect(_nav(ShellDestination.control));
      expect(home.bottom, lessThanOrEqualTo(844));
      expect(home.top, greaterThanOrEqualTo(844 - 64));
      expect(control.center.dx, closeTo(195, 1));
      expect(_page(tester).bottom, 844 - 64,
          reason: 'the page ends where the bar begins');
      expect(_page(tester).top, 56, reason: 'and starts under the 56 px header');
    });

    testWidgets('phone on its side: a 76 px rail on the left, a 48 px header', (tester) async {
      await _pump(tester, _phoneSide, _Probe());
      expect(_page(tester).left, 76);
      expect(_page(tester).top, 48);
      expect(_page(tester).bottom, 390);
      final r = tester.getRect(_nav(ShellDestination.home));
      expect(r.right, lessThanOrEqualTo(76));
    });

    testWidgets('tablet: a 92 px rail and a 72 px header', (tester) async {
      await _pump(tester, _tablet, _Probe());
      expect(_page(tester).left, 92);
      expect(_page(tester).top, 72);
      for (final d in ShellDestination.values) {
        expect(_nav(d), findsOneWidget, reason: d.name);
      }
    });

    testWidgets('TV: a 112 px rail', (tester) async {
      await _pump(tester, _tvSize, _Probe(), tv: true, pointer: SurfacePointer.none);
      expect(_page(tester).left, 112);
      expect(_page(tester).top, 72);
    });

    testWidgets('desktop: an 80 px header, four pills, and a separate Control button',
        (tester) async {
      await _pump(tester, _desktop, _Probe(), pointer: SurfacePointer.fine);
      expect(_page(tester).top, 80);
      expect(_page(tester).left, 0);
      expect(_nav(ShellDestination.control), findsNothing,
          reason: 'desktop has no Control nav item');
      expect(find.byKey(const ValueKey('shell-control-button')), findsOneWidget);
      expect(find.text('Residence control'), findsOneWidget);
      for (final d in [
        ShellDestination.home,
        ShellDestination.spaces,
        ShellDestination.experiences,
        ShellDestination.settings
      ]) {
        expect(_nav(d), findsOneWidget, reason: d.name);
      }
    });

    testWidgets('watch: no navigation, a 30 px header with the mark', (tester) async {
      await _pump(tester, _watch, _Probe());
      for (final d in ShellDestination.values) {
        expect(_nav(d), findsNothing, reason: d.name);
      }
      expect(find.byKey(const ValueKey('shell-wordmark')), findsOneWidget);
      expect(find.byKey(const ValueKey('shell-presence')), findsOneWidget);
      expect(_page(tester).top, 30);
    });

    testWidgets('an uncommissioned panel shows no chrome at all', (tester) async {
      await _pump(tester, const Size(1280, 800), _Probe(),
          panel: SurfacePanelBinding.uncommissioned);
      expect(find.byKey(const ValueKey('shell-wordmark')), findsNothing);
      expect(find.byKey(const ValueKey('page')), findsOneWidget);
      expect(_page(tester), const Rect.fromLTWH(0, 0, 1280, 800));
    });
  });

  group('room panel', () {
    testWidgets('no Spaces; Home is labelled with its room and named in full', (tester) async {
      await _pump(tester, const Size(360, 640), _Probe(),
          panel: SurfacePanelBinding.room, room: 'Living Room');
      expect(_nav(ShellDestination.spaces), findsNothing);
      expect(find.text('Living'), findsOneWidget);
      final handle = tester.ensureSemantics();
      expect(find.bySemanticsLabel('Living Room'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('a 3" panel on its side lays out without overflow', (tester) async {
      await _pump(tester, const Size(320, 240), _Probe(),
          panel: SurfacePanelBinding.room, room: 'Kitchen');
      expect(tester.takeException(), isNull);
      expect(_page(tester).left, 76);
    });
  });

  group('the header', () {
    testWidgets('the residence name shows everywhere but Home — and never shifts the layout',
        (tester) async {
      await _pump(tester, _desktop, _Probe(),
          pointer: SurfacePointer.fine, current: ShellDestination.home);
      Visibility visibility() => tester.widget<Visibility>(find.ancestor(
          of: find.text(_name), matching: find.byType(Visibility)));
      expect(visibility().visible, isFalse);
      final homeWordmark = tester.getRect(find.byKey(const ValueKey('shell-wordmark')));
      final homePresence = tester.getRect(find.byKey(const ValueKey('shell-presence')));

      await _pump(tester, _desktop, _Probe(),
          pointer: SurfacePointer.fine, current: ShellDestination.spaces);
      expect(visibility().visible, isTrue);
      expect(tester.getRect(find.byKey(const ValueKey('shell-wordmark'))), homeWordmark);
      expect(tester.getRect(find.byKey(const ValueKey('shell-presence'))), homePresence);
    });

    testWidgets('the presence mark fades while the residence is being reconnected to',
        (tester) async {
      double opacity() => tester
          .widget<AnimatedOpacity>(find.descendant(
              of: find.byKey(const ValueKey('shell-presence')),
              matching: find.byType(AnimatedOpacity)))
          .opacity;
      await _pump(tester, _phone, _Probe(), reachable: true);
      expect(opacity(), 1);
      await _pump(tester, _phone, _Probe(), reachable: false);
      expect(opacity(), .45);
    });

    testWidgets('the presence mark says what state the residence is in', (tester) async {
      final handle = tester.ensureSemantics();
      await _pump(tester, _phone, _Probe(), reachable: true);
      expect(find.bySemanticsLabel('$_name is connected'), findsOneWidget);
      await _pump(tester, _phone, _Probe(), reachable: false);
      expect(find.bySemanticsLabel('Reconnecting to $_name'), findsOneWidget);
      handle.dispose();
    });

    test('the mark is the five rings the residence lands on, in order', () {
      final r = presenceRingRadii();
      expect(r.length, 5);
      expect([...r]..sort(), r);
      expect(r.first, closeTo(26.8, .1));
      expect(r.last, closeTo(95.76, .1));
    });
  });

  group('safe areas', () {
    testWidgets('the chrome clears the notch and home indicator once; the page is not inset again',
        (tester) async {
      EdgeInsets? bodyPadding;
      await tester.binding.setSurfaceSize(_phone);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(_shell(_phone, _Probe(),
          padding: const EdgeInsets.only(top: 47, bottom: 34),
          onBodyPadding: (p) => bodyPadding = p));
      expect(_page(tester).top, 56 + 47, reason: 'header = 56 plus the notch');
      expect(_page(tester).bottom, 844 - (64 + 34),
          reason: 'bar = 64 plus the home indicator');
      expect(bodyPadding!.top, 0);
      expect(bodyPadding!.bottom, 0);
    });
  });

  group('insets for full-bleed pages', () {
    testWidgets('a page that runs under the header can read the space it takes', (tester) async {
      final probe = _Probe();
      await _pump(tester, _desktop, probe, pointer: SurfacePointer.fine, underHeader: true);
      expect(probe.insets!.top, 80);
      await _pump(tester, _phone, probe, underHeader: true);
      expect(probe.insets!.top, 56);
      await _pump(tester, _tablet, probe, underHeader: true);
      expect(probe.insets!.top, 72);
    });

    testWidgets('a page that starts below the header has nothing to clear', (tester) async {
      final probe = _Probe();
      await _pump(tester, _phone, probe);
      expect(probe.insets!.top, 0);
    });
  });

  group('selection and activation', () {
    testWidgets('tapping a destination selects it; Control opens its layer instead of selecting',
        (tester) async {
      final probe = _Probe();
      await _pump(tester, _phone, probe);
      await tester.tap(_nav(ShellDestination.spaces));
      expect(probe.selected, ShellDestination.spaces);
      probe.selected = null;
      await tester.tap(_nav(ShellDestination.control));
      expect(probe.control, 1);
      expect(probe.selected, isNull, reason: 'Control is a layer, never a destination');
    });

    testWidgets('desktop: the header button opens Control; the wordmark goes Home',
        (tester) async {
      final probe = _Probe();
      await _pump(tester, _desktop, probe, pointer: SurfacePointer.fine);
      await tester.tap(find.byKey(const ValueKey('shell-control-button')));
      expect(probe.control, 1);
      await tester.tap(find.byKey(const ValueKey('shell-wordmark')));
      expect(probe.selected, ShellDestination.home);
    });

    testWidgets('the current destination is announced as selected', (tester) async {
      final handle = tester.ensureSemantics();
      await _pump(tester, _phone, _Probe(), current: ShellDestination.experiences);
      // Compare the whole set: exactly one item is selected — the current one.
      final selected = [
        for (final d in ShellDestination.values)
          if (tester.getSemantics(_nav(d)).flagsCollection.isSelected ==
              Tristate.isTrue)
            d
      ];
      expect(selected, [ShellDestination.experiences]);
      handle.dispose();
    });

    testWidgets('a keyboard reaches every item and Enter activates it', (tester) async {
      final probe = _Probe();
      await _pump(tester, _phone, probe);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab); // wordmark
      await tester.sendKeyEvent(LogicalKeyboardKey.tab); // Home
      await tester.sendKeyEvent(LogicalKeyboardKey.tab); // Spaces
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(probe.selected, ShellDestination.spaces);
    });

    testWidgets('a remote\'s Select key activates the focused item (TV)', (tester) async {
      final probe = _Probe();
      await _pump(tester, _tvSize, probe, tv: true, pointer: SurfacePointer.none);
      // Focus is on the first focusable in reading order; walk to Settings.
      var guard = 0;
      while (probe.selected != ShellDestination.settings && guard++ < 12) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.sendKeyEvent(LogicalKeyboardKey.select);
      }
      expect(probe.selected, ShellDestination.settings);
    });
  });

  group('targets and overflow', () {
    testWidgets('every navigation target is at least as large as its surface calls for',
        (tester) async {
      Future<void> check(Size s, double minH, double minW,
          {SurfacePointer p = SurfacePointer.coarse, bool tv = false}) async {
        await _pump(tester, s, _Probe(), pointer: p, tv: tv);
        final nav = shellNavigationFor(surfaceProfileOf(SurfaceInputs(
            widthDp: s.width,
            heightDp: s.height,
            pointer: p,
            isTelevision: tv)));
        for (final i in nav.items) {
          final size = tester.getSize(_nav(i.destination));
          expect(size.height, greaterThanOrEqualTo(minH),
              reason: '${i.label} at $s');
          expect(size.width, greaterThanOrEqualTo(minW),
              reason: '${i.label} at $s');
        }
      }

      await check(_phone, 56, 44);
      await check(_tablet, 62, 44);
      await check(_tvSize, 74, 44, p: SurfacePointer.none, tv: true);
      await check(_desktop, 40, 44, p: SurfacePointer.fine);
      await check(_phoneSide, 44, 44);
    });

    testWidgets('the Control button and the wordmark are real targets on desktop', (tester) async {
      await _pump(tester, _desktop, _Probe(), pointer: SurfacePointer.fine);
      expect(tester.getSize(find.byKey(const ValueKey('shell-control-button'))).height,
          greaterThanOrEqualTo(44));
      expect(tester.getSize(find.byKey(const ValueKey('shell-wordmark'))).height,
          greaterThanOrEqualTo(44));
    });

    testWidgets('no surface in the matrix overflows or throws', (tester) async {
      final cases = <(Size, SurfacePanelBinding?, bool, SurfacePointer)>[
        (_watch, null, false, SurfacePointer.coarse),
        (const Size(320, 240), SurfacePanelBinding.room, false, SurfacePointer.coarse),
        (const Size(480, 480), SurfacePanelBinding.room, false, SurfacePointer.coarse),
        (const Size(360, 640), null, false, SurfacePointer.coarse),
        (_phone, null, false, SurfacePointer.coarse),
        (_phoneSide, null, false, SurfacePointer.coarse),
        (const Size(280, 653), null, false, SurfacePointer.coarse),
        (const Size(1024, 600), SurfacePanelBinding.room, false, SurfacePointer.coarse),
        (_tablet, null, false, SurfacePointer.coarse),
        (const Size(1280, 800), SurfacePanelBinding.room, false, SurfacePointer.coarse),
        (const Size(1024, 1366), null, false, SurfacePointer.coarse),
        (_desktop, null, false, SurfacePointer.fine),
        (const Size(1920, 1080), SurfacePanelBinding.residence, false, SurfacePointer.coarse),
        (const Size(2560, 1440), SurfacePanelBinding.residence, false, SurfacePointer.coarse),
        (_tvSize, null, true, SurfacePointer.none),
      ];
      for (final (size, panel, tv, pointer) in cases) {
        await _pump(tester, size, _Probe(),
            panel: panel,
            tv: tv,
            pointer: pointer,
            room: panel == SurfacePanelBinding.room ? 'Living Room' : null);
        await tester.pump();
        expect(tester.takeException(), isNull, reason: '$size $panel');
      }
    });
  });

  group('the layer host', () {
    Future<Rect> open(
      WidgetTester tester,
      Size size,
      ControlLayerPresentation presentation, {
      SurfaceFold? fold,
      bool still = false,
      bool settle = true,
    }) async {
      await tester.binding.setSurfaceSize(size);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MediaQuery(
        data: MediaQueryData(size: size, disableAnimations: still),
        child: MaterialApp(
          home: Builder(
            builder: (context) => Center(
              child: GestureDetector(
                key: const ValueKey('open'),
                behavior: HitTestBehavior.opaque,
                onTap: () => showSupremeLayer<void>(context,
                    presentation: presentation,
                    fold: fold,
                    builder: (_) =>
                        const SizedBox.expand(key: ValueKey('layer-body'))),
                child: const SizedBox(width: 20, height: 20),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump(); // the route is pushed
      await tester.pump(const Duration(milliseconds: 1)); // its page is built, transition begins
      if (settle) await tester.pumpAndSettle();
      return tester.getRect(find.byKey(const ValueKey('layer-body')));
    }

    testWidgets('drawer: 520 wide at the right edge, full height', (tester) async {
      final r = await open(tester, _desktop, ControlLayerPresentation.drawer);
      expect(r.right, 1440);
      expect(r.width, 520);
      expect(r.height, 900);
    });

    testWidgets('a drawer never exceeds the screen', (tester) async {
      final r = await open(tester, const Size(400, 800), ControlLayerPresentation.drawer);
      expect(r.width, 400);
    });

    testWidgets('sheet: 88 % high, full width, from the bottom edge, with a grab handle',
        (tester) async {
      final r = await open(tester, _phone, ControlLayerPresentation.sheet);
      expect(r.width, 390);
      expect(r.bottom, 844);
      // 88 % of the height, less the 18 px the grab handle takes.
      expect(r.height, closeTo(844 * .88 - 18, .5));
    });

    testWidgets('unfolded across a vertical hinge: nothing crosses it', (tester) async {
      const fold = SurfaceFold(axis: SurfaceFoldAxis.vertical, start: 430, end: 454);
      final r = await open(tester, const Size(884, 1104),
          ControlLayerPresentation.secondSegment,
          fold: fold);
      expect(r.left, greaterThanOrEqualTo(fold.end));
      expect(r.left, 454);
      expect(r.right, 884);
    });

    testWidgets('unfolded across a horizontal hinge: docked on the lower segment', (tester) async {
      const fold = SurfaceFold(axis: SurfaceFoldAxis.horizontal, start: 430, end: 454);
      final r = await open(tester, const Size(1104, 884),
          ControlLayerPresentation.lowerSegment,
          fold: fold);
      expect(r.top, greaterThanOrEqualTo(fold.end));
      expect(r.top, 454);
      expect(r.left, 0);
      expect(r.right, 1104);
    });

    testWidgets('it slides in (off screen first) and settles', (tester) async {
      final first = await open(tester, _desktop, ControlLayerPresentation.drawer,
          settle: false);
      expect(first.left, greaterThanOrEqualTo(1439),
          reason: 'at time zero it is still off the right edge');
      await tester.pumpAndSettle();
      expect(tester.getRect(find.byKey(const ValueKey('layer-body'))).right, 1440);
    });

    testWidgets('reduced motion: it is simply there', (tester) async {
      final r = await open(tester, _desktop, ControlLayerPresentation.drawer,
          still: true, settle: false);
      expect(r.right, 1440);
    });

    testWidgets('tapping outside closes it', (tester) async {
      await open(tester, _desktop, ControlLayerPresentation.drawer);
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('layer-body')), findsNothing);
    });
  });
}
