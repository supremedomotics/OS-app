import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'dashboard.dart';
import 'room_view.dart';
import 'scenes_screen.dart';
import 'alerts_screen.dart';

/// Post-login shell with the homeowner's primary destinations. Room-first, but
/// with a dashboard, scenes, and alerts a tap away (§11.3).
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
    AlertsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _pages[_index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.dashboard_outlined), label: 'Home'),
          NavigationDestination(
              icon: Icon(Icons.meeting_room_outlined), label: 'Rooms'),
          NavigationDestination(
              icon: Icon(Icons.auto_awesome_outlined), label: 'Scenes'),
          NavigationDestination(
              icon: Icon(Icons.notifications_outlined), label: 'Alerts'),
        ],
      ),
    );
  }
}
