/// What an Experience WOULD do, read-only: the Hub's authored steps that can act now (device
/// reachable, effect verifiable), optionally within one space. Used to preview and to decide
/// whether "Set" is offered. It is never sent: the Hub owns orchestration (D8) — see
/// `ExperienceActivations`, which asks the Hub and follows its run.
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
