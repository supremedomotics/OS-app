import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'home_settings_screen.dart';
import 'paired_home_controller.dart';

/// Settings root (§3) — "Home" is the paired-Hub management entry point. Mobile/Tablet only;
/// never reachable from Touch Panel (§20).
class SettingsScreen extends StatelessWidget {
  final PairedHomeController homeController;
  final PairingCodeHandler onPairHome;
  final ConnectionManager? activeConnectionManager;

  /// Inside the SupremeOS shell Settings is a page like any other: no app bar of its own (the
  /// shell is the chrome). Pushed on its own it keeps the standalone Scaffold.
  final bool embedded;

  const SettingsScreen({
    super.key,
    required this.homeController,
    required this.onPairHome,
    this.activeConnectionManager,
    this.embedded = false,
  });

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    final home = ListTile(
      title: Text('Home', style: text.body),
      subtitle: const Text('Manage your paired Homes'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => HomeSettingsScreen(
          controller: homeController,
          onPair: onPairHome,
          activeConnectionManager: activeConnectionManager,
        ),
      )),
    );
    if (embedded) {
      return ListView(
        key: const ValueKey('settings-page'),
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        children: [
          Text('Settings', style: text.title),
          const SizedBox(height: 16),
          home,
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(children: [home]),
    );
  }
}
