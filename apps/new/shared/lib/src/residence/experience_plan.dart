/// What activating an Experience means as device commands: the Hub's authored steps, filtered to
/// those that can act (device reachable, effect verifiable), optionally to one space.
///
/// Whole-residence activation goes through the Hub's own route (`POST /v1/scenes/:id/activate`);
/// a single space's share of a home-scoped Experience has no Hub route (flagged: D8 / backend gap
/// "space-scoped activation"), so the same steps are sent as tracked device commands.
library;

import '../experiences.dart';
import 'room_controls.dart';
import 'residence_state.dart';
import 'state_expectation.dart';

List<DeviceCommand> experiencePlan(Experience e, ResidenceSnapshot s,
    {String? spaceId}) {
  return [
    for (final st in e.steps)
      if (expectationOf(st.capability, st.values) != null &&
          (s.devices[st.deviceId]?.isOnline ?? false) &&
          (spaceId == null || s.devices[st.deviceId]?.roomId == spaceId))
        DeviceCommand(st.deviceId, {'capability': st.capability, ...st.values})
  ];
}
