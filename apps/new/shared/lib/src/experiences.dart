/// An Experience is a desired state of the environment (§16) — homeowners see
/// "Relax", never a list of device commands. Kept strictly separate from
/// Automations, which answer "when should this happen" (§17) and are not
/// modeled here — Automations live in Professional Mode / backend contracts.
class Experience {
  final String id;
  final String name;
  final List<String> spaceIds;
  final String? iconName;

  /// The Hub's authored targets for this Experience (`Scene.steps`). Empty when the Hub sent
  /// none — an Experience with no steps can never be reported Active (see `experienceStatus`).
  final List<ExperienceStep> steps;

  const Experience({
    required this.id,
    required this.name,
    required this.spaceIds,
    this.iconName,
    this.steps = const [],
  });
}

/// One authored target of an Experience — the Hub's `SceneStep`, unchanged: [values] is the
/// command the Hub dispatches for [capability] on [deviceId] (e.g. `{action: "set", level: 20}`),
/// not an observed state.
class ExperienceStep {
  final String deviceId;
  final String capability;
  final Map<String, dynamic> values;
  const ExperienceStep(
      {required this.deviceId, required this.capability, required this.values});
}

/// Canonical starter set (§16). The Hub is authoritative — this is only the
/// fallback shown before the Hub's real experience list loads, and the shape
/// mock repositories should produce.
const builtInExperienceNames = <String>[
  'Welcome',
  'Relax',
  'Entertain',
  'Dinner',
  'Movie',
  'Morning',
  'Focus',
  'Good Night',
  'Away',
];
