/// An Experience is a desired state of the environment (§16) — homeowners see
/// "Relax", never a list of device commands. Kept strictly separate from
/// Automations, which answer "when should this happen" (§17) and are not
/// modeled here — Automations live in Professional Mode / backend contracts.
class Experience {
  final String id;
  final String name;
  final List<String> spaceIds;
  final String? iconName;

  const Experience({
    required this.id,
    required this.name,
    required this.spaceIds,
    this.iconName,
  });
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
