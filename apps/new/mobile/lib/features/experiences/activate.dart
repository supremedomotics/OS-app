import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../control/control_blocks.dart';

/// Sets an Experience. Nothing is remembered as "active": the result is whatever the devices
/// report, derived by `experienceStatus`, and every step goes through the command lifecycle.
///
/// * Whole residence → the Hub's own scene route (one call), with each step tracked against its
///   device's report.
/// * One space's share → the same authored steps sent as tracked device commands (the Hub has no
///   space-scoped activation route — flagged; owner decision D8 on who orchestrates).
void activateExperience(WidgetRef ref, ResidenceView view, Experience e,
    {String? spaceId}) {
  final plan = experiencePlan(e, view.snapshot, spaceId: spaceId);
  if (plan.isEmpty) return;
  if (spaceId != null) {
    runCommands(view, plan);
    return;
  }
  final send = ref.read(hubSendProvider);
  view.tracker.submitGroup(
    [for (final c in plan) (deviceId: c.deviceId, command: c.command)],
    () => send('v1/scenes/${e.id}/activate', const {}),
  );
}
