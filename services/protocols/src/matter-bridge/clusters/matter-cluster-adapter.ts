/**
 * Cluster adapter architecture (§ Matter Bridge Phase 1 foundation). A cluster adapter answers
 * "what functionality does this cluster implement," decoupled from any specific Matter Device
 * Type — `matter-device-types.ts` COMPOSES adapters (e.g. Color Temperature Light uses OnOff +
 * LevelControl + ColorControl) rather than any device-type file re-deriving hue/saturation math
 * or level-percent scaling of its own. Reusable across every current and future device type
 * that happens to include the same cluster (§ "no duplicated cluster logic").
 *
 * Phase 1 is bridge-direction only (SupremeOS → Matter): SupremeOS already holds the real state
 * and issues the real command; the adapter's job is pure, two-way VALUE TRANSLATION between a
 * SupremeOS capability's state/command shape and the corresponding Matter cluster's attribute/
 * command shape — e.g. brightness 0-100% ↔ LevelControl's CurrentLevel 1-254, a SupremeOS
 * `position` percent (0=closed) ↔ WindowCovering's LiftPercent100ths (0=open, spec-inverted).
 * Deliberately NOT the `read()/subscribe()/execute()` shape a LIVE binding against a remote
 * endpoint would need — that is Phase 2's controller-side counterpart (Matter → SupremeOS,
 * reading a real remote device's attributes), which will live alongside these same modules and
 * share their `clusterId` constants, but needs a genuinely different interface because it binds
 * to a REMOTE endpoint's live state rather than translating SupremeOS's own state. Building that
 * shape now, with nothing to bind it to, would be dead code (an anti-pattern this Phase's own
 * "no unrequested abstractions" boundary is meant to prevent) — it is deliberately deferred, not
 * omitted by oversight.
 *
 * `real-server.ts` is the only place these adapters are actually invoked — it owns the live
 * `@matter/main` `Endpoint`/behavior objects; these modules never import `@matter/main` at all,
 * which is exactly what keeps them unit-testable without a real Matter runtime.
 */
export interface MatterClusterAdapter {
  readonly clusterId: number;
  readonly clusterName: string;
}
