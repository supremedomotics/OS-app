import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

Widget _wrap(Size size, Widget child) {
  return MediaQuery(
    data: MediaQueryData(size: size),
    child: MaterialApp(home: Material(child: AdaptiveScope(child: child))),
  );
}

void main() {
  group('AdaptivePanel composition changes with viewport (§Phase7-14,17)', () {
    testWidgets(
        'micro (3-4in) shows a single dominant action, no list/grid chrome',
        (tester) async {
      await tester.pumpWidget(_wrap(
        const Size(240, 320),
        AdaptivePanel(
            children: [PrimaryAction(label: 'Relax', onPressed: () {})]),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(PrimaryAction), findsOneWidget);
      expect(find.byType(GridView), findsNothing);
      expect(find.byType(ListView), findsNothing);
    });

    testWidgets('compact (5-7in) stacks controls in a ListView',
        (tester) async {
      await tester.pumpWidget(_wrap(
        const Size(360, 640),
        const AdaptivePanel(
            children: [SizedBox(height: 40), SizedBox(height: 40)]),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(ListView), findsOneWidget);
    });

    testWidgets('10in landscape uses a grid, 10in portrait stacks (§Phase7-6)',
        (tester) async {
      await tester.pumpWidget(_wrap(
        const Size(1280, 800),
        const AdaptivePanel(
            children: [SizedBox(height: 40), SizedBox(height: 40)]),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(GridView), findsOneWidget);

      await tester.pumpWidget(_wrap(
        const Size(800, 1280),
        const AdaptivePanel(
            children: [SizedBox(height: 40), SizedBox(height: 40)]),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(ListView), findsOneWidget);
    });

    testWidgets('30in uses side-by-side panels, not a scrolling list',
        (tester) async {
      await tester.pumpWidget(_wrap(
        const Size(2400, 1500),
        const AdaptivePanel(
            children: [SizedBox(width: 40), SizedBox(width: 40)]),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(Row), findsWidgets);
      expect(find.byType(ListView), findsNothing);
      expect(find.byType(GridView), findsNothing);
    });
  });

  group('touch target + semantic label verification (§Phase7-14)', () {
    testWidgets('PrimaryAction meets the micro-profile minimum touch target',
        (tester) async {
      await tester.pumpWidget(_wrap(
        const Size(240, 320),
        PrimaryAction(label: 'Relax', onPressed: () {}),
      ));
      await tester.pumpAndSettle();

      final size = tester.getSize(find.byType(PrimaryAction));
      expect(size.height, greaterThanOrEqualTo(72));
    });

    testWidgets(
        'StatusIndicator exposes a semantic label, not color-only status',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_wrap(
        const Size(800, 1280),
        const ConnectionStateIndicator(status: ConnectionStatus.connectedLocal),
      ));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('Connected'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('ExperienceControl exposes an actionable semantic label',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_wrap(
        const Size(800, 1280),
        ExperienceControl(name: 'Relax', onActivate: () {}),
      ));
      await tester.pumpAndSettle();

      expect(
          find.bySemanticsLabel('Activate Relax experience'), findsOneWidget);
      handle.dispose();
    });
  });
}
