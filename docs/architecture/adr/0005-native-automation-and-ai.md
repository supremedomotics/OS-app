# ADR 0005 — Native automation engine, AI drafts, and append-only audit

- Status: **Accepted**
- Date: 2026-06-05
- Context: Phase 3 (Intelligence & Scale) — §10, §16.

## Decisions

**1. Automations are an engine-agnostic DSL with a native executor.**
The visual Builder edits a typed Supreme DSL (`triggers` / `conditions` /
`actions`), never HA YAML. A native `AutomationEngine` executes `engine="supreme"`
automations on the hub — driven by SIL state deltas and a once-a-minute clock —
with side effects flowing through injected executors (SIL, scenes, notifications).
`compileToHa()` covers the `engine="ha"` path. This is the SIL migration guarantee
(ADR 0001) applied to automations: same DSL, swappable executor.

**2. The AI assistant proposes drafts; it never acts unilaterally.**
`@supreme/ai` turns natural language + home context into a *draft* (commands /
scene / automation) the user confirms (§10). It ships a deterministic, offline
planner so the assistant works with no model weights and no cloud; a local LLM
(the `services/ai-py` host) drops in behind the same interface, with the Node
service falling back to the planner if the model is unavailable.

**3. Audit is append-only and tamper-evident.**
`@supreme/audit` hash-chains entries (`entryHash = SHA-256(prevHash || entry)`),
so altering or deleting history breaks every subsequent hash and is caught by
`verify()`. Per-home chains are serialized to stay consistent. Security events
(commands, automation runs, arm/disarm) are recorded here.

## Consequences

- The engine is deterministic and unit-testable (no wall-clock timers internally;
  the gateway drives `tick()`), which is why the whole intelligence layer is
  covered by automated tests including a PGlite-backed gateway e2e.
- Analytics, audit, and license/automation persistence all ride the same `SqlDb`
  seam (ADR 0003), so they run on the hub's Postgres and on embedded Postgres in
  tests with no second code path.
- Fleet management is explicitly cloud-side and optional; a hub never depends on it.
