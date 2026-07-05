import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'assistant_screen.dart';
import 'automations_screen.dart';
import 'dashboard.dart';
import 'developer_screen.dart';
import 'device_manager_screen.dart';
import 'discover_devices_screen.dart';
import 'driver_manager_screen.dart';
import 'energy_screen.dart';
import 'room_view.dart';
import 'scenes_screen.dart';
import 'security_screen.dart';
import 'settings_screen.dart';

/// Post-login shell (§ Navigation). The everyday five live on the floating pill; the platform's
/// management destinations (Discover Devices, Devices, Extension Center, Automations, Energy, and —
/// in Developer Mode — Developer) are one tap away behind "More", so nothing is hidden. A one-tap AI
/// assistant floats above (§11.3, §16).
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

  void _open(Widget screen) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

  void _showMore() {
    final devMode = ref.read(devModeProvider).valueOrNull ?? false;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          for (final (icon, label, screen) in <(IconData, String, Widget)>[
            (Icons.travel_explore_outlined, 'Discover Devices', const DiscoverDevicesScreen()),
            (Icons.devices_other_outlined, 'Devices', const DeviceManagerScreen()),
            (Icons.extension_outlined, 'Extension Center', const ExtensionCenterScreen()),
            (Icons.account_tree_outlined, 'Automations', const AutomationsScreen()),
            (Icons.bolt_outlined, 'Energy', const EnergyScreen()),
            if (devMode) (Icons.code, 'Developer', const DeveloperScreen()),
          ])
            ListTile(
              leading: Icon(icon),
              title: Text(label),
              trailing: const Icon(Icons.chevron_right),
              onTap: () { Navigator.pop(sheet); _open(screen); },
            ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBody: true,
      body: _pages[_index],
      floatingActionButton: FloatingActionButton(
        onPressed: () => _open(const AssistantScreen()),
        child: const Icon(Icons.auto_awesome),
      ),
      bottomNavigationBar: _FloatingNavBar(
        index: _index,
        items: _items,
        onTap: (i) => setState(() => _index = i),
        onMore: _showMore,
      ),
    );
  }
}

/// A floating, centred, icon-only pill (Ovio) — the active tab is a filled circle. Content scrolls
/// behind it (extendBody).
class _FloatingNavBar extends StatelessWidget {
  const _FloatingNavBar({required this.index, required this.items, required this.onTap, required this.onMore});
  final int index;
  final List<(IconData, IconData)> items;
  final ValueChanged<int> onTap;
  final VoidCallback onMore;

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
                  // "More" — the platform's management destinations (nothing hidden).
                  GestureDetector(
                    onTap: onMore,
                    behavior: HitTestBehavior.opaque,
                    child: Container(
                      width: 48,
                      height: 48,
                      margin: const EdgeInsets.symmetric(horizontal: 2),
                      child: Icon(Icons.more_horiz, size: 22, color: scheme.onSurfaceVariant),
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
