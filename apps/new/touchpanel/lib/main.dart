import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'data/prefs_panel_config_store.dart';
import 'provisioning/provisioning_flow.dart';
import 'provisioning/assigned_screen.dart';

void main() {
  runApp(const SupremeTouchPanelApp());
}

class SupremeTouchPanelApp extends StatelessWidget {
  const SupremeTouchPanelApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SupremeOS Touch Panel',
      debugShowCheckedModeBanner: false,
      theme: buildSupremeTheme(),
      home: const AdaptiveScope(child: PanelBoot()),
    );
  }
}

/// Boot sequence (§6, §40): restore a stored assignment if one exists;
/// otherwise enter first-boot provisioning. This is the ONLY branch point —
/// a provisioned panel must never see the provisioning UI again.
class PanelBoot extends StatefulWidget {
  const PanelBoot({super.key});
  @override
  State<PanelBoot> createState() => _PanelBootState();
}

/// Hub-authoritative area list, mocked until gateway wiring lands (§43) —
/// shared by provisioning (§6) and Floor/Whole Home scope navigation
/// (§Phase8-18), never duplicated or hardcoded per screen.
Future<List<AreaSummary>> _fetchAreas() async => const [
      AreaSummary(id: 'living-room', name: 'Living Room', floorId: 'ground'),
      AreaSummary(id: 'dining', name: 'Dining', floorId: 'ground'),
      AreaSummary(id: 'kitchen', name: 'Kitchen', floorId: 'ground'),
      AreaSummary(
          id: 'master-bedroom', name: 'Master Bedroom', floorId: 'first'),
    ];

class _PanelBootState extends State<PanelBoot> {
  late final ProvisioningController _controller = ProvisioningController(
    store: PrefsPanelConfigStore(),
    fetchAreas: _fetchAreas,
    confirmWithHub: (assignment) async => PanelConfig(
      identity: const PanelIdentity(
          panelId: 'panel-demo-1', deviceIdentity: 'cert:panel-demo-1'),
      provisioningState: ProvisioningState.provisioned,
      assignment: assignment,
    ),
  );

  // NOT `late final` with a lazy initializer: `dispose()` unconditionally
  // references this field, and a lazy `late` initializer would then
  // construct-and-start a fresh ConnectionManager for the first time
  // *during teardown* whenever the panel never left the provisioning
  // screen (which never reads `_connection`) — creating a timer the test
  // binding immediately flags as leaked past disposal. Created eagerly in
  // initState instead, so it always has a real lifecycle to dispose.
  late final ConnectionManager _connection;

  PanelConfig? _config;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _connection = ConnectionManager(
      discovery: const MockHubDiscovery(),
      makeLanTransport: (_) => MockHubTransport(),
    )..start();
    _restore();
  }

  Future<void> _restore() async {
    final config = await _controller.restoreOrStartProvisioning();
    setState(() {
      _config = config;
      _loading = false;
    });
    // The cached config is already usable UI at this point (above) — this
    // is the "revalidate once connected" half of the flow (§Phase9-9), run
    // AFTER the UI is already showing, never blocking boot on it.
    if (config != null && config.isLocked) {
      unawaited(_revalidate(config));
    }
  }

  /// Mock Hub-authoritative source until real gateway wiring lands (§43) —
  /// echoes the panel's own cached assignment back, signed, since there is
  /// no real Hub here to disagree with it. The point of this wiring is the
  /// VERIFY-THEN-ADOPT flow itself (§Phase9-9), not simulating a specific
  /// reassignment — `applyHubPushedReassignment`'s existing test coverage
  /// already proves the "Hub changed something" half.
  Future<SignedPanelConfig> _mockFetchAuthoritativeConfig(
      PanelConfig cached) async {
    await Future.delayed(const Duration(milliseconds: 200));
    return SignedPanelConfig(
      assignment: cached.assignment!,
      provisioningState: cached.provisioningState,
      configurationVersion: cached.assignment!.configurationVersion,
      signature: 'test-hub-signature-v1',
    );
  }

  Future<void> _revalidate(PanelConfig cached) async {
    final outcome = await _controller.revalidateAgainstHub(
      fetchAuthoritativeConfig: () => _mockFetchAuthoritativeConfig(cached),
      verifier: const DeterministicHmacConfigVerifier(),
    );
    if (outcome.result == ConfigVerificationResult.verified &&
        outcome.config != null &&
        mounted) {
      setState(() => _config = outcome.config);
    }
    // A rejected outcome intentionally does nothing further here — the
    // cache (already showing) remains authoritative until a genuinely
    // verified update arrives; see revalidateAgainstHub's own doc.
  }

  @override
  void dispose() {
    _connection.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        backgroundColor: SupremeColorScheme.voidBg,
        body: Center(
            child:
                CircularProgressIndicator(color: SupremeColorScheme.gold500)),
      );
    }
    if (_config != null && _config!.isLocked) {
      return AssignedScreen(
        config: _config!,
        fetchAreas: _fetchAreas,
        connection: _connection,
      );
    }
    return ProvisioningFlow(
      controller: _controller,
      onProvisioned: (config) => setState(() => _config = config),
    );
  }
}
