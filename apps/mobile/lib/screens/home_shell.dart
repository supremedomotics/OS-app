import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'assistant_screen.dart';
import 'dashboard.dart';
import 'room_view.dart';
import 'scenes_screen.dart';
import 'security_screen.dart';
import 'settings_screen.dart';

/// Post-login shell with the homeowner's primary destinations. Room-first, with a dashboard, scenes,
/// security and settings a tap away, plus a one-tap AI assistant (§11.3, §16). The bottom bar is an
/// Ovio-style floating, icon-only pill — Smart (Intelligence) and Alerts are reached from the
/// dashboard so the bar stays minimal.
class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  int _index = 0;

  static const _pages = <Widget>[
    DashboardScreen(),
    HomePager(),
    ScenesScreen(),
    SecurityScreen(),
    SettingsScreen(),
  ];

  static const _items = <(IconData, IconData)>[
    (Icons.dashboard_outlined, Icons.dashboard),
    (Icons.meeting_room_outlined, Icons.meeting_room),
    (Icons.auto_awesome_outlined, Icons.auto_awesome),
    (Icons.shield_outlined, Icons.shield),
    (Icons.settings_outlined, Icons.settings),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBody: true,
      body: _pages[_index],
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const AssistantScreen()),
        ),
        child: const Icon(Icons.auto_awesome),
      ),
      bottomNavigationBar: _FloatingNavBar(
        index: _index,
        items: _items,
        onTap: (i) => setState(() => _index = i),
      ),
    );
  }
}

/// A floating, centred, icon-only pill (Ovio) — the active tab is a filled circle. Content scrolls
/// behind it (extendBody).
class _FloatingNavBar extends StatelessWidget {
  const _FloatingNavBar({required this.index, required this.items, required this.onTap});
  final int index;
  final List<(IconData, IconData)> items;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // A centred Row sizes to the pill's height (an Align/Center here would expand vertically and
    // swallow the whole screen). mainAxisAlignment.center floats the pill in the middle horizontally.
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12, top: 4),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(7),
              decoration: BoxDecoration(
                color: (Theme.of(context).cardTheme.color ?? scheme.surface).withValues(alpha: 0.86),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
                boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.35), blurRadius: 26, offset: const Offset(0, 10))],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < items.length; i++)
                    GestureDetector(
                      onTap: () => onTap(i),
                      behavior: HitTestBehavior.opaque,
                      child: Container(
                        width: 48,
                        height: 48,
                        margin: const EdgeInsets.symmetric(horizontal: 2),
                        decoration: BoxDecoration(
                          color: index == i ? scheme.primary : Colors.transparent,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          index == i ? items[i].$2 : items[i].$1,
                          size: 22,
                          color: index == i ? scheme.onPrimary : scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
