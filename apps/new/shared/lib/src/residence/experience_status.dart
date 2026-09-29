/// An Experience is a desired state of the environment (§16). Whether it is currently in effect
/// is DERIVED from real device state against the Experience's authored steps — there is no
/// stored "active" flag anywhere, and no client-side "running" memory.
///
/// Steps are the Hub's `SceneStep`s; `values` is a command, so a step's target is the state that
/// command produces (`expectationOf`). A step whose capability has no verifiable counterpart is
/// left out of the comparison and reported via [ExperienceStatus.unverifiable]; an Experience
/// with no verifiable step at all is [ExperiencePhase.indeterminate] — never guessed Active.
library;

import '../experiences.dart';
import 'command_tracker.dart';
import 'residence_state.dart';
import 'state_expectation.dart';

enum ExperiencePhase {
  /// Every verifiable step matches what the devices report.
  active,

  /// A command toward one of its steps is in flight and the residence does not match yet.
  becoming,

  /// Some, not all, steps match.
  partial,

  /// None of its steps match.
  inactive,

  /// Its devices cannot be reached, so it can neither be reported nor reached.
  unavailable,

  /// The Hub authored no step that device state can prove.
  indeterminate,
}

class ExperienceStatus {
  final ExperiencePhase phase;
  final int matched;
  final int verifiable;
  final int unverifiable;
  final int unreachable;
  const ExperienceStatus(this.phase,
      {this.matched = 0,
      this.verifiable = 0,
      this.unverifiable = 0,
      this.unreachable = 0});
}

ExperienceStatus experienceStatus(
  Experience e,
  ResidenceSnapshot s, {
  Iterable<CommandRecord> commands = const [],
}) {
  var verifiable = 0, matched = 0, unverifiable = 0, unreachable = 0;
  var reachableVerifiable = 0;
  var moving = false;

  for (final step in e.steps) {
    final expectation = expectationOf(step.capability, step.values);
    if (expectation == null) {
      unverifiable++;
      continue;
    }
    verifiable++;
    final device = s.devices[step.deviceId];
    if (device == null || !device.isOnline) {
      unreachable++;
      continue;
    }
    reachableVerifiable++;
    final now = device.state[step.capability];
    if (now != null && expectation.matches(now)) {
      matched++;
    } else if (commands.any((c) =>
        c.inFlight &&
        c.deviceId == step.deviceId &&
        c.capability == step.capability)) {
      moving = true;
    }
  }

  ExperienceStatus of(ExperiencePhase p) => ExperienceStatus(p,
      matched: matched,
      verifiable: verifiable,
      unverifiable: unverifiable,
      unreachable: unreachable);

  if (verifiable == 0) return of(ExperiencePhase.indeterminate);
  if (reachableVerifiable == 0) return of(ExperiencePhase.unavailable);
  if (matched == verifiable) return of(ExperiencePhase.active);
  if (moving) return of(ExperiencePhase.becoming);
  if (matched > 0) return of(ExperiencePhase.partial);
  // Reachable steps all match but some device is unreachable: partially in effect.
  if (matched == reachableVerifiable) return of(ExperiencePhase.partial);
  return of(ExperiencePhase.inactive);
}
