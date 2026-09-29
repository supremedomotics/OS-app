
import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../residence/panel_residence.dart';

/// One Experience, set for this panel's space (ADR 0102, D8). The Hub orchestrates it; the tile
/// only asks and reports what the devices then say — "Applying…" while the Hub is carrying it out,
/// the Experience's name once the devices' own reports satisfy it, and a plain sentence when it
/// did not finish. Nothing here confirms from the tap or from a timer.
class ExperienceActivation extends StatelessWidget {
  final Experience experience;
  final String spaceId;
  final PanelResidence residence;
  final bool enabled;

  const ExperienceActivation({
    super.key,
    required this.experience,
    required this.spaceId,
    required this.residence,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final acts = residence.activations;
    final mine = acts.latestFor(experience.id, spaceIds: [spaceId]);
    final st = experienceStatus(experience, residence.snapshot,
        commands: residence.tracker.inFlight,
        activations: acts.inFlight,
        spaceId: spaceId);
    final failed = mine?.phase == ActivationPhase.failed;
    final label = failed
        ? "${experience.name} didn't finish"
        : st.phase == ExperiencePhase.becoming
            ? 'Applying…'
            : st.phase == ExperiencePhase.active
                ? '${experience.name} · Active'
                : experience.name;
    return ExperienceControl(
      key: ValueKey('panel-exp-${experience.id}'),
      name: label,
      onActivate: () {
        if (!enabled) return;
        acts.activate(experience, spaceIds: [spaceId]);
      },
    );
  }
}
