import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// Asks the Hub to set an Experience. The Hub resolves, sequences and sends the steps; nothing is
/// remembered as "active" here — confirmation is whatever the devices report, derived by
/// `experienceStatus` (ADR 0102, D8). A space's share is the same route with `spaceIds`.
void activateExperience(WidgetRef ref, ResidenceView view, Experience e,
    {String? spaceId}) {
  if (experiencePlan(e, view.snapshot, spaceId: spaceId).isEmpty) return;
  view.activations.activate(e, spaceIds: [if (spaceId != null) spaceId]);
}
