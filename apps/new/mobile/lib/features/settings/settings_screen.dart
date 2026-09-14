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

  const SettingsScreen({
    super.key,
    required this.homeController,
    required this.onPairHome,
    this.activeConnectionManager,
  });

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          ListTile(
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
          ),
        ],
      ),
    );
  }
}
