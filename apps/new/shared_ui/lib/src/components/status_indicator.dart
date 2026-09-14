import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../theme/supreme_colors.dart';

/// A colored dot ALWAYS paired with a text label (§29 — color is never the
/// only status signal) and a `Semantics` label for screen readers.
class StatusIndicator extends StatelessWidget {
  final Color color;
  final String label;
  const StatusIndicator({super.key, required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      excludeSemantics: true,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 8),
        Text(label,
            style: const TextStyle(color: SupremeColorScheme.textSecondary)),
      ]),
    );
  }
}

/// Renders a [ConnectionStatus] from `supreme_os_core` as a [StatusIndicator]
/// — the one place that enum maps to color/label, reused by every screen
/// that shows connection health (§10, §Phase7-13).
class ConnectionStateIndicator extends StatelessWidget {
  final ConnectionStatus status;
  const ConnectionStateIndicator({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      ConnectionStatus.connectedLocal => (
          'Connected',
          SupremeColorScheme.statusGood
        ),
      ConnectionStatus.connectedRemote => (
          'Connected remotely',
          SupremeColorScheme.statusGood
        ),
      ConnectionStatus.discoveringLan ||
      ConnectionStatus.connectingLocal ||
      ConnectionStatus.connectingRemote ||
      ConnectionStatus.authenticating =>
        ('Connecting…', SupremeColorScheme.statusWarning),
      ConnectionStatus.reconnecting => (
          'Reconnecting…',
          SupremeColorScheme.statusWarning
        ),
      ConnectionStatus.authenticationFailed => (
          'Authentication failed',
          SupremeColorScheme.statusCritical
        ),
      ConnectionStatus.offline => (
          'Offline',
          SupremeColorScheme.statusCritical
        ),
    };
    return StatusIndicator(color: color, label: label);
  }
}

/// Renders a Touch Panel's [PanelConnectionState] (§10-11) the same way.
class PanelConnectionIndicator extends StatelessWidget {
  final PanelConnectionState state;
  const PanelConnectionIndicator({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return switch (state) {
      PanelConnectionState.connected => const StatusIndicator(
          color: SupremeColorScheme.statusGood, label: 'Connected'),
      PanelConnectionState.disconnected => const StatusIndicator(
          color: SupremeColorScheme.statusCritical, label: 'Disconnected'),
    };
  }
}
