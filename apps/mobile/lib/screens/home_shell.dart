import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'alerts_screen.dart';
import 'assistant_screen.dart';
import 'dashboard.dart';
import 'intelligence_screen.dart';
import 'room_view.dart';
import 'scenes_screen.dart';
import 'security_screen.dart';
import 'settings_screen.dart';

/// Post-login shell with the homeowner's primary destinations. Room-first, with a
/// dashboard, scenes, security, and alerts a tap away, plus a one-tap AI assistant
/// (§11.3, §16).
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
    IntelligenceScreen(),
    SecurityScreen(),
    AlertsScreen(),
    SettingsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _pages[_index],
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const AssistantScreen()),
        ),
        child: const Icon(Icons.auto_awesome),
      ),
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
              icon: Icon(Icons.insights_outlined), label: 'Smart'),
          NavigationDestination(
              icon: Icon(Icons.shield_outlined), label: 'Security'),
          NavigationDestination(
              icon: Icon(Icons.notifications_outlined), label: 'Alerts'),
          NavigationDestination(
              icon: Icon(Icons.settings_outlined), label: 'Settings'),
        ],
      ),
    );
  }
}
