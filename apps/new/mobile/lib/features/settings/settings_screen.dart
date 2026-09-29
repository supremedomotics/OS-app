import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import 'home_settings_screen.dart';
import 'paired_home_controller.dart';

/// Settings — how SupremeOS behaves for me (Golden Master `settings.js`; homeowner only —
/// commissioning lives in SupremeOS Pro). Sections in the Golden Master's two-column rhythm; a
/// sub-page opens in place with a quiet back chip.
///
/// Every row here is real. What the prototype lists that production cannot back is not drawn:
/// Automations and "Your experiences" (no homeowner contract; authoring is undecided, D5), Room
/// photographs (no asset contract — see ADR 0102), Notifications (nothing consumes them yet, and
/// "doors and movement" has no signal), Transparency (no blurred surface exists), Updates/Backup
/// and "Clear what this device remembers" (no such behaviour). Preferences hold only this device's
/// own choices, never residence or device state.
class SettingsScreen extends ConsumerStatefulWidget {
  final PairedHomeController homeController;
  final PairingCodeHandler onPairHome;
  final ConnectionManager? activeConnectionManager;

  /// Kept for callers that push Settings on its own; the page itself is identical.
  final bool embedded;

  const SettingsScreen({
    super.key,
    required this.homeController,
    required this.onPairHome,
    this.activeConnectionManager,
    this.embedded = false,
  });

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  // Presentation state only: which sub-page is open.
  bool _hubs = false;

  String _link(ResidenceView? view, HubConnectionState? c) {
    final off = view == null
        ? 0
        : view.snapshot.devices.values.where((d) => !d.isOnline).length;
    final simulated = ref.read(simulatedResidenceProvider) != null;
    if (simulated || (c?.isConnected ?? false)) {
      return off > 0 ? 'Connected · $off not responding' : 'Connected';
    }
    return view?.snapshot.loaded == true
        ? 'Reconnecting — you are seeing the last known state'
        : 'Not connected';
  }

  @override
  Widget build(BuildContext context) {
    if (_hubs) {
      return HomeSettingsScreen(
        controller: widget.homeController,
        onPair: widget.onPairHome,
        activeConnectionManager: widget.activeConnectionManager,
        onBack: () => setState(() => _hubs = false),
      );
    }
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final hour = ref.watch(residenceHourProvider);
    final motion = ref.watch(motionPrefProvider);
    final snap = view?.snapshot;
    final loaded = snap != null && snap.loaded;
    final paired = widget.homeController.homes.length;

    final name = (snap?.name.isNotEmpty ?? false)
        ? snap!.name
        : widget.homeController.activeHome?.displayName ?? '';
    final lede = loaded
        ? (describeHome(snap, hour: hour, commands: view!.inFlight).note ??
            'Everything is in order.')
        : null;
    final floors = loaded ? {for (final s in snap.spaces) s.floorId}.length : 0;

    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    return StreamBuilder<HubConnectionState>(
      stream: widget.activeConnectionManager?.state,
      initialData: widget.activeConnectionManager?.current,
      builder: (context, conn) => SupremePage(
        key: const ValueKey('settings-page'),
        children: [
          SupremePageHead(kicker: name, title: 'Settings'),
          if (lede != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 30),
              child: Text(lede,
                  key: const ValueKey('settings-lede'),
                  style: text.body.copyWith(
                      fontSize: 17,
                      fontWeight: FontWeight.w300,
                      color: SupremeColorScheme.text2)),
            ),
          SettingsSection(title: 'Home', children: [
            if (name.isNotEmpty) SettingsFact('Residence', name),
            if (loaded)
              SettingsFact('Spaces',
                  '${snap.spaces.length} ${snap.spaces.length == 1 ? 'space' : 'spaces'}'
                  '${floors > 0 ? ' on $floors ${floors == 1 ? 'level' : 'levels'}' : ''}'),
          ]),
          SettingsSection(title: 'Hubs', children: [
            SettingsLink(
              label: 'The residence and its Hubs',
              summary: paired == 0
                  ? 'No Home paired yet'
                  : '$paired ${paired == 1 ? 'Home' : 'Homes'} paired with this device',
              onTap: () => setState(() => _hubs = true),
            ),
          ]),
          SettingsSection(title: 'Connections', children: [
            SettingsFact('Residence link', _link(view, conn.data)),
            const SettingsFact('Services and systems',
                'Installed and looked after by your integrator'),
          ]),
          SettingsSection(title: 'Appearance and accessibility', children: [
            SettingsChoice<MotionPref>(
              label: 'Motion',
              options: MotionPref.values,
              value: motion,
              name: (m) => m == MotionPref.system ? 'As device' : 'Reduced',
              onChanged: (m) => ref.read(motionPrefProvider.notifier).set(m),
            ),
          ]),
          const SettingsSection(title: 'System', children: [
            SettingsFact('About',
                'SupremeOS for homeowners. Installation and service belong to SupremeOS Pro.'),
          ]),
        ],
      ),
    );
  }
}
