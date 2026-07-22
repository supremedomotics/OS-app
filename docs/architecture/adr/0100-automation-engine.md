# 0100 — Automation Engine

## Status

**Accepted (Final, Revision 3)** — this is the final architecture review before implementation.
Revision 3 evaluates exactly two new proposals (Intent Layer, Automation Dependency Map) and
validates Revision 2's design against the full requirement list one more time. No prior section
is redesigned. See "Revision 3 — Final Master Architecture Review" at the end of this document
for the complete review, the two accept/reject decisions, and the final status of every
deliverable.

**Accepted (Final, Revision 2)** — the original design (Sections 1–14 below, unchanged) is
accepted; this revision adds a critical review and a set of enhancements (Sections 15–29) that
strengthen it without altering the execution architecture. The Event-Triggered Reactive Flow
Graph, the Runtime Object/Event contract, and every mechanism in Sections 1–14 remain exactly as
designed. Nothing in ADR 0016–0021 changes. A product/feature architecture built entirely on top
of the accepted Platform Constitution (ADR 0016–0021). Every design decision here answers to the
Ownership Matrix and Evolution Policy in ADR 0021 §3/§4: the Automation Engine is a **consumer**
of Runtime Objects and Runtime Events (ADR 0020), never a new source of truth, never a bypass of
Commissioning or Capability Normalization. Where this document names a new persistent concept
(automation definitions, run history), it is registered against ADR 0021's Ownership Matrix
explicitly (§6).

**Core philosophy governing this revision:** *Unlimited Power. Effortless Simplicity.* Power
lives inside the engine (Sections 1–14, unchanged); simplicity lives in the interface (§21's
three modes over the SAME engine). Every enhancement below was tested against one question —
"does this make SupremeOS simpler while making it more powerful?" — and rejected if the answer
was no (see §29's rejected-complexity list).

---

## 1. Automation Architecture — Paradigm Comparison & Recommendation

Evaluated against SupremeOS's actual requirements: deterministic, explainable, offline-first,
AI-friendly, professional-integrator-usable, scaling from an apartment to a hospital campus.

| Paradigm | Strengths | Weaknesses for SupremeOS |
|---|---|---|
| **Trigger/Condition/Action (HA, most consumer platforms)** | Simple, matches installer mental model, easy first automation | Collapses under complex logic — branching/looping/parallelism become fragile nested condition blocks; poor explainability once an automation has 20+ conditions; hard to statically analyze for conflicts |
| **Pure event-driven workflows (Node-RED)** | Visually intuitive, flexible, huge plugin ecosystems in the wild | No inherent determinism guarantee — two wires racing into the same node is a known Node-RED footgun; state is implicit in the wiring, not explicit, which fights "explainable" and "testable" directly |
| **State machines** | Excellent determinism, natural fit for a security panel or an HVAC mode controller | Poor fit for *composing* many independent automations — state explosion for anything beyond a single subsystem; not naturally visual/compositional at scale |
| **Directed Acyclic Graphs (DAGs)** | Natural parallelism, clear dependency ordering, matches data/workflow-orchestration platforms (Temporal, Airflow) | A DAG's "acyclic" constraint fights automations that legitimately need to wait/react to their own downstream effects (a thermostat automation reacting to the temperature change it just caused) |
| **Behavior trees** | Strong at prioritized, interruptible, hierarchical decision-making (game AI, robotics) — good explainability (a tree walk IS the explanation) | Unfamiliar vocabulary to building-automation integrators; weaker at the "watch many independent event streams simultaneously" shape most building automation actually is |
| **Rule engines (Drools-style, forward-chaining)** | Excellent for large, declarative rule sets evaluated over shared facts — genuinely BMS/industrial-proven | Forward-chaining's non-obvious evaluation order actively fights explainability and deterministic replay unless heavily constrained; steep learning curve for integrators |
| **Hybrid: Event-Triggered Reactive Flow Graph** *(recommended)* | Combines DAG's explicit dependency/parallelism clarity with event-driven triggering and state-machine-grade determinism per-node — see below | More novel; requires more design rigor up front (this document) |

### Recommendation: an **Event-Triggered Reactive Flow Graph**

Each Automation is a graph: **Triggers** (event subscriptions, §3) feed one or more **Flow
Nodes** (Conditions §4, Actions §5, control-flow nodes — branch/loop/parallel/wait) connected by
explicit edges, executed by a deterministic **Runtime Execution Model** (§6). It is a DAG for a
single *execution* (one trigger firing produces one acyclic run), but the AUTOMATION DEFINITION
itself is a standing, re-triggerable subscription graph — solving the DAG paradigm's "can't react
to my own downstream effects" weakness (a new trigger firing starts a NEW run, never a
same-run cycle) while keeping a DAG's clean parallelism and static analyzability.

**Why not imitate Node-RED/HA directly:** both were studied and rejected as direct models
specifically because SupremeOS's requirement list (deterministic, explainable, testable,
enterprise-scale) is stronger than either was designed for — Node-RED's implicit
race-condition-prone wiring and HA's condition-block fragility are exactly the failure modes this
paradigm is chosen to avoid, not incidental differences.

---

## 2. Execution Model

Every Automation Run is a **deterministic, single-writer state machine over a DAG**:

```
Trigger fires (RuntimeEvent matched, §3)
   │
   ▼
Run created: { runId, automationId, triggerEvent, startedAt, status: "running" }
   │
   ▼
Graph walk: each node evaluated once its inbound edges are satisfied
   │             (Conditions gate; Actions execute; control-flow nodes
   │              fan out/in for parallel/loop/wait — §4, §5)
   ▼
Run completes: status ∈ { "completed", "failed", "cancelled", "timed_out" }
   │
   ▼
RuntimeEvent emitted: "automation.triggered" / "automation.evaluated" (ADR 0019 §6)
```

- **Concurrency**: multiple Runs (of the same or different Automations) execute concurrently by
  default; a single Automation MAY declare a concurrency policy (`allow` | `queue` | `restart` |
  `skip`) for overlapping triggers of itself — matching the well-proven HA/industrial pattern,
  formalized here as an explicit per-automation setting rather than implicit behavior.
- **Threading**: node evaluation within one Run is single-threaded per branch; parallel branches
  (explicit `Parallel` control-flow node, §5) run concurrently, joined deterministically (all
  branches must complete, or first-to-complete, as declared).
- **Queueing**: Action nodes that issue device commands go through the existing Service
  Registry/command path (ADR 0020) — inherits whatever backpressure/queueing that layer already
  provides; the Automation Engine does not reimplement command delivery.
- **Cancellation**: every Run is cancellable mid-flight (installer action, a `Cancel` action from
  another automation, or a declared timeout) — cancellation propagates to in-flight Action nodes,
  which must support a cancellation signal (§5's Compensation).
- **Retry policies**: per-Action, declarative (`maxAttempts`, `backoff`), never silently infinite.
- **Timeouts**: every Run has a default and an overridable maximum duration; a Run exceeding it
  is force-cancelled and reported, never left running silently.
- **Recovery / crash resilience**: Run state is checkpointed at each node boundary (persisted —
  see §6 Ownership) so a hub restart mid-run can resume or cleanly abandon a Run rather than
  leaving inconsistent device state; this is the SAME durability discipline already established
  for Commissioning (ADR 0018) and persistence generally, applied to automation execution.
- **Determinism**: identical `(automation definition, trigger event, Runtime Object states at
  trigger time)` always produces the same Run outcome — the explicit, testable property that
  makes simulation/dry-run (§12) meaningful and that behavior trees/rule engines struggled to
  guarantee (§1).
- **Performance**: node evaluation is O(graph size) per Run; Runtime Object reads are Projection
  reads (ADR 0020, already fast, already cached) — no automation-specific hot path bypasses the
  Projection Engine.

---

## 3. Trigger Model

A Trigger is a declarative **Runtime Event subscription filter** — never a protocol-level
listener. Every trigger type ultimately resolves to one or more `RuntimeEventType` subscriptions
(ADR 0020 §3):

| Trigger category | Resolves to |
|---|---|
| Device state change | `state.changed` filtered by `objectId` and/or capability/feature |
| Relationship change (device moved room, dependency added) | `relationship.changed` |
| Room occupancy | `state.changed` on an Occupancy Projection's derived Runtime Objects (ADR 0020 §2) — never a raw sensor read |
| Schedule / timer / delay | A first-class **Scheduler-emitted** synthetic event (`schedule.fired`) — the Scheduler (ADR 0019's Feature Engine) is itself an Event Bus participant, so schedules are triggers like any other, not a special code path |
| Sunrise/Sunset, astronomical events | Computed by the Scheduler from site location (Building Model, ADR 0019 §4) and emitted as `schedule.fired` with a `reason: "sunset"` payload — no separate astronomical subsystem |
| Energy threshold | `energy.reading_updated` (ADR 0019 §6) with a declared threshold comparison evaluated by the trigger, not the Projection |
| Weather | A Cloud/Plugin-sourced event (ADR 0021 §8: Cloud Services are an additive Event Bus subscriber) — weather is external data, arrives as `metadata.changed` or a plugin-declared custom event, never a core engine concept |
| Presence / geofencing | Plugin- or driver-sourced `state.changed` on a Presence Runtime Object — same mechanism as occupancy, different source |
| AI events | A plugin-declared custom `RuntimeEventType` (ADR 0021 §10 — additive event types are how new categories enter without a core change) |
| Voice commands | Resolves to an Action invocation directly (a voice command IS an intent to run something), OR a custom event a voice plugin emits for other automations to react to |
| System / driver / plugin events | `health.changed`, `firmware.updated`, `configuration.changed`, or a plugin-declared custom type — all first-class `RuntimeEventType` values |
| Custom events | Any plugin may declare a new additive `RuntimeEventType` (ADR 0020 §3, ADR 0021 §10) — the Automation Engine's trigger subscription mechanism is generic over event type from day one, so a "custom event" is not a special case, it's the general case |

**Trigger subscription mechanism**: identical to a Projection's own event consumption pattern
(ADR 0020 §5) — the Automation Engine IS, architecturally, a specialized Projection consumer:
it maintains no state ownership, rebuilds its trigger-index from automation definitions +
the event stream, and every trigger evaluation is a pure filter over `RuntimeEvent` fields. This
is a direct, deliberate reuse of an existing extension point (ADR 0021 §7's "always reuse before
introducing new abstractions"), not a new subscription mechanism.

---

## 4. Condition Model

Conditions are pure, side-effect-free predicates evaluated against Runtime Objects at
trigger-time (and optionally re-evaluated at execution-time for long-running flows — declared
per-condition as `evaluateAt: "trigger" | "execution"`):

```ts
type Condition =
  | { kind: "and" | "or"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "capability"; objectRef: RuntimeObjectRef; capability: string; op: ComparisonOp; value: unknown }
  | { kind: "relationship"; objectRef: RuntimeObjectRef; relationshipType: string; matches: RuntimeObjectQuery }
  | { kind: "state"; objectRef: RuntimeObjectRef; path: string; op: ComparisonOp; value: unknown }
  | { kind: "time"; window: TimeWindow }                       // time-of-day, day-of-week, date range
  | { kind: "permission"; principal: PrincipalRef; action: string } // resolved permission check
  | { kind: "health"; objectRef: RuntimeObjectRef; healthIn: RuntimeObject["health"][] }
  | { kind: "presence"; zoneRef: RuntimeObjectRef; occupied: boolean }
  | { kind: "availability"; objectRef: RuntimeObjectRef; online: boolean }
  | { kind: "expression"; expr: string };                       // the Variable expression language, §7 — escape hatch for arbitrary logic
```

`objectRef`/`RuntimeObjectQuery` resolve through the Relationship Engine (ADR 0019/0020 §4) —
"all lights in this zone that are on" is a relationship-aware query, not a hand-rolled loop,
directly reusing the Relationship Contract rather than reinventing spatial/functional traversal
inside the Automation Engine (ADR 0021 §7).

Nesting (`and`/`or`/`not`) is unlimited depth; the visual editor (§10) renders deep nesting as a
readable tree, not a flat list, specifically to avoid HA's "20-condition wall of text"
explainability failure identified in §1.

---

## 5. Action Model

```ts
type ActionNode =
  | { kind: "command"; objectRef: RuntimeObjectRef; action: string; params?: Record<string, unknown> } // through Runtime Object's own actions[] (ADR 0020 §1) — never a raw protocol command
  | { kind: "scene"; sceneId: string }
  | { kind: "notify"; channel: "push" | "email" | "sms" | string; template: string; vars?: Record<string, unknown> }
  | { kind: "webhook"; url: string; method: string; body?: unknown }
  | { kind: "api_call"; endpoint: string; params?: unknown }        // first-party REST/GraphQL, same contract external consumers use
  | { kind: "automation"; automationId: string; wait: boolean }      // chaining — always by reference, never inlined duplication
  | { kind: "set_variable"; scope: "local" | "flow" | "global"; name: string; expr: string }
  | { kind: "loop"; over: RuntimeObjectQuery | string; body: ActionNode[] }
  | { kind: "parallel"; branches: ActionNode[][]; join: "all" | "race" }
  | { kind: "delay"; duration: string }
  | { kind: "wait_for"; condition: Condition; timeout: string }
  | { kind: "retry"; body: ActionNode; policy: RetryPolicy }
  | { kind: "compensate"; body: ActionNode; onFailure: ActionNode[] }  // saga-style rollback for multi-step physical actions
  | { kind: "plugin"; pluginId: string; actionId: string; params?: unknown }
  | { kind: "cloud"; serviceId: string; params?: unknown }
  | { kind: "ai"; intent: string; context?: unknown };                 // natural-language or intent-based action, resolved by an AI plugin (§9)
```

**Every device-affecting action goes through `command` → `RuntimeObject.actions[]`** (ADR 0020
§1) — this is the enforcement point guaranteeing the Automation Engine never becomes
protocol-aware: an Action node literally cannot express "send KNX telegram to 1/2/3" because that
vocabulary doesn't exist above the Driver Layer. **Compensation** (saga pattern) exists because
physical-world actions are rarely truly transactional (you can't "roll back" a door that already
opened) — `compensate` declares a best-effort undo/mitigation action, not a guarantee, and this
honesty is stated explicitly in the visual editor (§10) rather than implying false atomicity.

---

## 6. Runtime Lifecycle & Ownership

Registering the Automation Engine's new persistent concepts against ADR 0021 §3's Ownership
Matrix (required by governance, not optional):

| Fact | Owner | Notes |
|---|---|---|
| Automation definitions (trigger/condition/action graph) | **Automation Engine's own store** | New row added to the Ownership Matrix — the Automation Engine is a first-class owner of ITS OWN definitions, same status as the Scheduler owning scene/automation definitions today (ADR 0019) |
| Run history / execution traces | **Automation Engine's own store** (append-only) | Never reconstructed from Runtime Events alone (a completed Run's specific timing/branch choices are themselves the fact) — but every Run emits `automation.triggered`/`automation.evaluated` events so OTHER subsystems (Analytics Projection, AI) never need direct access to this store |
| Variable values (flow/global scope) | **Automation Engine's own store**, scoped per-automation or per-site | Read-only elsewhere via `expression` conditions/variable references, never directly written by another subsystem |

Lifecycle (definition, not just execution):

```
Draft (visual editor, §10) → Validated (§2 determinism + §12 dry-run pass)
   → Published (active, subscribed to its triggers) → Running (0..N concurrent Runs)
   → Paused (subscriptions suspended, definition retained) → Archived/Deleted
```

Every transition emits a `configuration.changed` event (ADR 0020 §3) — an Automation being
published/paused/deleted is visible to Analytics, AI, and Diagnostics Projections uniformly,
never a silent state change.

---

## 7. Variable System

```ts
interface VariableScope {
  local: Record<string, unknown>;    // one Run's lifetime only
  flow: Record<string, unknown>;      // shared across a chained set of automations invoked with `wait: true`
  global: Record<string, unknown>;     // site-scoped, persists across Runs (§6 ownership)
}
```

**Expression language**: a small, sandboxed, side-effect-free expression grammar (arithmetic,
comparison, string ops, and a `ref()` function resolving a `RuntimeObjectRef` + path) — evaluated
by the SAME engine backing `Condition.expression` (§4) and `set_variable` (§5), never a second
implementation. Deliberately NOT a general-purpose scripting language (no arbitrary loops/network
calls inside an expression) — that power belongs to the `loop`/`parallel`/`plugin` Action nodes,
which ARE sandboxed and auditable per-node, keeping the expression language itself trivially
statically analyzable (a requirement for §12's simulation and §9's AI validation).

Runtime Object references and Relationship queries are first-class expression citizens
(`ref("zone:living-room").relationships("controls").state.brightness`) — directly reusing the
Relationship Contract (§4, ADR 0020 §4) rather than a parallel query syntax.

---

## 8. Scene Integration Strategy

**Decision: Scenes are a specialized, restricted Automation — not a fourth concept.**

A Scene is exactly: one or more `command`/`set_variable` Action nodes, no Triggers of its own (it
is invoked, never self-triggering), no Conditions (a Scene applies unconditionally once
activated — conditional scene activation is expressed by wrapping the `scene` Action node in a
Condition at the CALLING automation, not inside the scene itself). This is a genuine engineering
choice, justified against the alternatives the task asked to evaluate:

- **NOT an independent Runtime Object type**: a Scene has no state of its own to project — "is
  this scene active" is really "did the last activation of it complete," which is Run history
  (§6), not a new persistent object category.
- **NOT a specialized Projection**: nothing about a Scene needs a purpose-built read-model shape
  beyond what the Automation Engine's own definition store already provides.
- **A reusable action, AND an automation, simultaneously** — both are true and consistent: a
  Scene IS reusable (referenced by `{kind: "scene"}` from any Automation, §5) BECAUSE it is
  itself a (trigger-less) Automation definition, so it inherits validation, dry-run, versioning,
  and execution tracing for free, with zero duplicated implementation. This directly satisfies
  ADR 0021 §2 (single ownership) — a second "Scene Engine" would duplicate the entire Execution
  Model (§2) for no benefit.

---

## 9. AI Integration Strategy

Every AI capability consumes Runtime Objects/Events exclusively (ADR 0020 §9's Plugin Contract)
— the Automation Engine exposes exactly one privileged surface to AI beyond that: read access to
Automation definitions + Run history (§6) through a dedicated, permissioned query API (never
direct store access).

| AI capability | Mechanism |
|---|---|
| **Automation generation** | AI composes a Trigger/Condition/Action graph (§3–§5) from natural language, submits it as a Draft (§6) — it is validated and dry-run (§12) exactly like a human-authored automation before Publish; AI gets no bypass of validation. |
| **Optimization** | AI reads Run history + the Analytics Projection (ADR 0020 §2) to propose graph simplifications (e.g. merging redundant conditions) — proposals are Drafts requiring the SAME human-or-policy approval as any edit, never silent auto-modification of a Published automation. |
| **Explanation** | Directly enabled by §1's paradigm choice — the graph structure + Run trace (§6, §12) already IS a step-by-step explanation; an AI explanation feature narrates an existing deterministic trace, it does not need to reverse-engineer opaque rule-engine evaluation order (the exact weakness that ruled out forward-chaining rule engines in §1). |
| **Validation** | Static analysis over the graph (cycle detection in control-flow, capability-existence checks against Runtime Objects, permission checks) — the same validation gate every automation passes before Publish, callable standalone by an AI reviewing a Draft. |
| **Simulation** | §12's dry-run engine, callable by an AI agent exactly as by a human integrator through the visual editor — no AI-specific simulation path. |
| **Natural language** | An AI plugin translating intent → a Draft graph (generation) or intent → a direct Action invocation (voice-command trigger resolution, §3) — both paths produce ordinary graph/Action structures, never a special "AI-only" execution mode. |
| **Conflict detection** | Static analysis across ALL published automations for overlapping triggers + contradictory actions on the same Runtime Object — a graph-level query enabled directly by the Relationship Contract's dependency edges (ADR 0020 §4's `dependsOn`). |
| **Recommendation** | Reads Run history + Analytics Projection, proposes new Draft automations — same generation path as above. |

**Guardrail**: no AI capability is granted a write path to the Device Registry, Relationship
Engine, or a Published automation that skips validation — every AI action funnels through
existing gates (ADR 0021 §7's AI Contribution Guidelines apply to the Automation Engine's own
runtime behavior, not just to code contributions).

---

## 10. Visual Editor Architecture

**An original model, informed by but not copying any studied platform**, chosen specifically to
match §1's Event-Triggered Reactive Flow Graph paradigm (a node-and-wire canvas like Node-RED
would misrepresent the model — Node-RED's canvas implies continuous dataflow, not discrete
trigger-fired Runs):

- **Three-lane canvas**: a Trigger lane (left, one or more entry points feeding the graph), a
  Logic lane (center, Conditions + control-flow nodes, rendered as a collapsible nested tree per
  §4's explainability requirement — not a flat wire mess), an Action lane (right, sequenced/
  parallel/looped Action nodes). This spatial layout makes "what starts this, what decides, what
  happens" visually immediate — a deliberate usability choice for professional integrators
  triaging an unfamiliar automation, the exact audience Control4 Composer and RTI Integration
  Designer are built for.
- **Inline explainability**: every node shows its LAST evaluation result (from Run history, §6)
  directly on the canvas when viewing a published automation — closing the loop with §9's
  Explanation capability without a separate "explain" view.
- **Progressive disclosure**: a Trigger/Condition/Action-only view (matching simpler platforms'
  approachability) is the default; `loop`/`parallel`/`compensate`/expression nodes are an
  "advanced" palette tier — serving both the single-apartment homeowner-installer and the
  campus-scale professional integrator from the same tool, addressing the full scalability range
  (§13) directly in the editor's own information architecture.
- **Version-aware**: every save is a new Draft version (§6 lifecycle); the editor can diff two
  versions of the same automation node-for-node.

---

## 11. Plugin Extension Model

Plugins contribute new Trigger types, Condition kinds, Action kinds, Validators, custom editor
node renderers, and custom execution nodes — **without modifying the core engine** — via a
declarative registration contract:

```ts
interface AutomationExtension {
  triggers?: { type: string; schema: JSONSchema; resolveSubscription(config): RuntimeEventFilter }[];
  conditions?: { kind: string; schema: JSONSchema; evaluate(config, ctx: RuntimeObjectContext): boolean }[];
  actions?: { kind: string; schema: JSONSchema; execute(config, ctx: ExecutionContext): Promise<ActionResult> }[];
  validators?: { name: string; validate(graph: AutomationGraph): ValidationResult[] }[];
  editorNodes?: { kind: string; render: EditorNodeRenderer }[];
}
```

This is a direct instance of ADR 0020 §9's Plugin Contract, specialized for the Automation
Engine — a plugin's `execute()`/`evaluate()` functions receive `RuntimeObjectContext`/
`ExecutionContext` (built entirely from Runtime Objects and the Automation Engine's own
Run/variable state), never a driver handle or Device Registry access. The core engine's Execution
Model (§2) treats a plugin-contributed Action node identically to a built-in one — same
concurrency, retry, timeout, and cancellation handling — so a plugin author gets production-grade
execution semantics for free, matching ADR 0021 §6's plugin isolation guarantee exactly.

---

## 12. Testing & Simulation Strategy

Directly enabled by §2's determinism guarantee — none of the following require a live building:

- **Simulation**: run an Automation against a synthetic set of Runtime Object states (not real
  devices) — since Conditions/Actions only ever touch Runtime Objects, a simulation is just
  substituting a mock Projection Engine response, no special-cased "sim mode" logic inside the
  engine itself.
- **Dry-run**: execute the full graph against REAL current Runtime Object state but suppress
  actual `command` Action execution (log "would have called X" instead) — the standard
  pre-Publish validation gate (§6).
- **Replay**: re-execute a historical Run's exact recorded trigger event + Runtime Object
  snapshot (§6 Run history stores enough to do this) — deterministic by §2's guarantee, so replay
  of a past Run must reproduce the identical trace, and a replay that DOESN'T match is itself a
  regression signal.
- **Breakpoints / execution tracing**: the visual editor (§10) can pause a live or simulated Run
  at any node boundary and inspect the full variable/Runtime Object context at that point —
  possible specifically because §2's node-boundary checkpointing already captures this state for
  crash recovery; testing reuses the same mechanism.
- **Performance profiling**: per-node timing captured in Run history by default (low overhead,
  always-on) — no separate profiling build/mode.
- **Dependency analysis**: static graph analysis (§9's conflict detection) doubles as a testing
  tool — "what automations would this change affect" before publishing an edit to a
  widely-referenced Scene or shared variable.

---

## 13. Scalability Strategy

The paradigm and execution model (§1, §2) make no assumption about deployment size — scaling is
entirely a function of the Hybrid Runtime's own scaling story (ADR 0019 §3, §8), inherited rather
than re-solved:

- **Single homes / villas**: dozens of automations, single-process execution, negligible
  resource cost.
- **Hotels**: hundreds of near-identical per-room automations — expressed as ONE automation
  template parameterized by a Relationship query (`objectRef` resolving "this room's lights,"
  §4) rather than hundreds of hand-copied definitions, directly leveraging the Building Model
  hierarchy (ADR 0019 §4) for one-to-many automation authoring.
- **Commercial buildings / hospitals / universities**: thousands of automations, higher
  concurrency — the per-Run concurrency policy (§2) and Event Bus's existing scaling story (ADR
  0019) absorb this without engine changes.
- **Industrial facilities**: `retry`/`compensate`/`wait_for` (§5) plus deterministic replay (§12)
  directly serve the reliability bar industrial BMS rule engines are held to.
- **Multi-site deployments**: every `RuntimeEvent` and Run carries `siteId` (ADR 0019 §6) —
  cross-site automations are a Projection/plugin concern (a portfolio-level automation is
  literally a normal automation whose triggers/Runtime Object queries span multiple sites'
  event streams), not a special engine mode.
- **Distributed execution**: because Action nodes only ever call through the Service Registry
  (never hold a direct driver/network handle), a future multi-controller deployment (ADR 0019
  §8) can run the Automation Engine on any controller that can reach the Event Bus and Projection
  Engine — no engine-internal change required to distribute it.

---

## 14. Risks & Trade-offs

- **Novelty risk**: the Event-Triggered Reactive Flow Graph paradigm is not a copy of a
  battle-tested platform — mitigated by grounding every mechanism (triggers, conditions,
  variables) in the ALREADY-accepted and tested Runtime Object/Event contract (ADR 0020), so the
  automation-specific novelty is confined to graph structure and execution semantics, not the
  data model underneath it.
- **Expression language scope creep**: the temptation to let `expression` (§7) grow into a full
  scripting language is real and explicitly rejected — enforced by keeping side-effecting power
  exclusively in Action nodes, reviewable via ADR 0021 §2's checklist.
- **Compensation is best-effort, not transactional**: physical-world actions cannot be truly
  rolled back; this is stated as an explicit trade-off (§5) rather than a false guarantee.
- **Scene-as-restricted-Automation risk**: if Scene-specific needs emerge later that don't fit
  "Automation with no triggers/conditions," revisit §8 — but no such need is evident today, and
  inventing a fourth concept speculatively would violate ADR 0021 §1 (architecture must not be
  redefined by unconfirmed future needs).
- **AI-generated automation quality**: AI can propose bad or wasteful automations just as a human
  can — mitigated by requiring every AI-authored Draft through the SAME validation/dry-run gate
  as human-authored ones (§9), never a privileged AI-only publish path.

---

## Summary — Deliverables Cross-Reference

| Deliverable | Section |
|---|---|
| Automation Architecture | §1 |
| Execution Model | §2 |
| Trigger Model | §3 |
| Condition Model | §4 |
| Action Model | §5 |
| Runtime Lifecycle | §6 |
| Variable System | §7 |
| Scene Integration Strategy | §8 |
| AI Integration Strategy | §9 |
| Visual Editor Architecture | §10 |
| Plugin Extension Model | §11 |
| Testing & Simulation Strategy | §12 |
| Scalability Strategy | §13 |
| Risks & Trade-offs | §14 |
| ADR 0100 | this document |

---
---

# Revision 2 — Critical Review & Enhancements (Final)

## §15. Critical Review of the Original Design

Reviewed adversarially, section by section, against "does this hold up as the defining
competitive advantage" and "is any of this hidden power actually reachable by the users who need
it."

- **§1's paradigm choice holds up.** The Event-Triggered Reactive Flow Graph is still correct —
  nothing in this review found a reason to touch it. Its weakness is not architectural, it's
  presentational: as originally written, EVERY user faced the graph. That is the single biggest
  gap in the original ADR, and it's a UX gap, not an engine gap (fixed by §21, not by changing
  §1).
- **§3's trigger model is structurally complete but under-enumerated.** The category table
  covered the shapes (state change, relationship change, schedule, …) but not the full breadth
  the follow-up brief asks for by name (lux, CO₂, voltage, BLE, UWB, webhook/REST/MQTT-sourced
  custom triggers). Gap, not a flaw — every one of those already fits an EXISTING row (a lux
  sensor is a `state.changed` on a `sensor` capability; BLE/UWB presence is a `state.changed` on
  a Presence Runtime Object; webhook/REST/MQTT are Cloud/Plugin-sourced custom events) — §22
  closes the gap by enumeration, not by adding a new mechanism.
- **§5's Action Model has a real omission**: it listed `command` as a generic pass-through to
  `RuntimeObject.actions[]` but never stated that this list must be COMPLETE and AUTOMATIC per
  capability (RGB/RGBW/RGB+CCT/HSV/XY/Kelvin/transition/effects for color; open/close/stop/
  position/tilt for covers; the full climate/media vocabularies). This was implied, not
  guaranteed. §23 makes the guarantee explicit and testable.
- **§8's Scene decision (restricted Automation, not a 4th concept) is reconfirmed correct** on
  review — no new information changes that conclusion. Kept as-is.
- **§9's AI Integration Strategy was directionally right but underspecified on SAFETY**: it said
  AI proposals require approval, but didn't define what "inspect for conflicts/duplicates/
  circular logic" concretely means, nor how AI continuously-learned suggestions (a NEW capability
  the follow-up brief adds, not in the original) fit the same approval gate. §24/§25 close this.
- **§10's Visual Editor Architecture is the weakest section on review**: it designed ONE editor
  for "professional integrators," implicitly assuming every user sees the graph. This directly
  contradicts the stated philosophy ("homeowners should never feel overwhelmed") and is the
  clearest case of the review finding a genuine design gap, not just an enumeration gap. §21
  replaces the single-editor assumption with three interfaces over one engine — the highest-value
  change in this revision.
- **Missing entirely from the original**: an Automation Health model (§26), an Explainability
  model as a first-class user-facing feature rather than an implied byproduct of Run history
  (§27), Versioning (§28.3), Templates (§28.4), and Driver-Native Automation Synchronization
  (§28.6 — a genuinely new consideration the original ADR never addressed at all, since Casambi/
  KNX-native scene/timer features were out of scope for a from-scratch engine design).
- **Nothing in the original violates ADR 0016–0021** — the review found gaps and
  under-specification, not architectural violations. No section required a redesign.

## §16. Rejected Complexity (what this review explicitly declined to add)

Per the stated philosophy, every proposed enhancement was tested and several were REJECTED
specifically because they added technical possibility without simplifying or meaningfully
empowering:

- **A fourth "hybrid" mode between Advanced and Expert** — rejected; three modes already cover
  the real skill-level spectrum (§21), a fourth is a distinction without a difference.
- **A separate "AI mode" toggle** — rejected; AI assistance (§24/§25) is available IN every mode,
  not a mode of its own — an AI suggestion presented as a Simple Mode template card looks
  completely different from the same suggestion presented as an annotated Draft graph in Expert
  Mode, but it's the same underlying capability, not a fourth interface.
- **Automation "priority levels" as a standalone concept** — rejected; conflict resolution (§25)
  and concurrency policy (§2, unchanged) already express everything a priority system would,
  without a new cross-cutting concept to learn.
- **A dedicated "simulation mode" UI distinct from dry-run** — rejected; §12's dry-run/replay/
  simulation are already one mechanism with different inputs, and the Visual Editor's existing
  inline-explainability (§10) is the only UI surface simulation needs, not a parallel one.

## §17. AI Automation Strategy (Final)

Natural-language automation generation, end to end:

```
User: "When someone enters after sunset, softly illuminate the hallway."
   │
   ▼
1. Intent parsing → candidate Runtime Object references
   (resolves "someone enters" → a Presence/motion Runtime Object with a `controls`/`locatedIn`
   relationship to "hallway"; "after sunset" → a schedule.fired trigger with reason:"sunset";
   "softly illuminate" → a `command` action on hallway lighting Runtime Objects with a
   transition/low-brightness parameter — ALL resolved via Relationship + Capability queries,
   §4/§5, never invented)
   │
   ▼
2. Draft graph assembled (§6 lifecycle: AI proposals ALWAYS enter as Draft, never Published)
   │
   ▼
3. Validation pass (§9's static analysis, unchanged) + NEW: conflict/duplicate/circular-logic
   scan against ALL existing automations (§25)
   │
   ▼
4. Explanation rendered: plain-language summary + the SAME visual graph a human editor would see
   (§27) + estimated affected devices/side effects (§18)
   │
   ▼
5. Explicit user approval REQUIRED — no exceptions, no "auto-apply if confidence is high"
   escape hatch. This is a hard guardrail, not a default: approval is required even for AI
   proposals scored as low-risk, because "nothing should ever be created automatically" (brief's
   own words) admits no confidence-based exception.
   │
   ▼
6. Only on approval: Draft → Published (§6), identical to a human-authored automation from this
   point forward — no AI-specific runtime path exists after approval.
```

**Estimation** (side effects, affected devices, execution characteristics) is computed via §12's
existing dry-run/simulation engine — AI does not get a bespoke estimation mechanism, it consumes
the same one every integrator's manual test uses, which is also what keeps the estimate honest
(it's the real execution engine, not a heuristic guess).

## §18. Impact Estimation (supporting §17 and §25)

A standing capability (not AI-exclusive — available to any Draft, human- or AI-authored):

- **Affected devices**: every `objectRef` resolved across all Action nodes, expanded through any
  `RuntimeObjectQuery`/relationship traversal (a query like "all lights in this zone" is expanded
  to its actual current member list for the estimate, with a caveat that membership can change).
- **Side effects**: cross-references against `dependsOn` relationship edges (ADR 0020 §4) — e.g.
  flags "this also affects the Energy Projection's threshold automation" if a `dependsOn` edge
  exists.
- **Execution estimate**: derived from §12's dry-run — approximate duration, retry/timeout
  exposure, and concurrency policy interaction with already-published automations sharing
  triggers.

## §19. Automation Intelligence Layer

The standing, always-on background capability referenced by §5 (AI Suggestions) and §12
(Predictive Automation) in the follow-up brief — designed here as ONE coherent layer, not several
overlapping AI features:

```
Run History + Runtime Events (manual command patterns, overrides, energy Projection)
   │
   ▼
Pattern Detection  ──┬── Repeated manual action sequences → Suggest new automation (§17's
                     │   generation pipeline, seeded from the detected pattern instead of NL)
                     ├── Frequently-invoked Scene → Suggest promoting to a scheduled/triggered
                     │   automation
                     ├── Repeated manual override of a Published automation → Suggest the
                     │   automation is miscalibrated (wrong threshold/time), propose a Draft edit
                     ├── "Lights forgotten on" pattern → Suggest an auto-off automation
                     ├── Energy waste signature (Analytics Projection) → Suggest an
                     │   energy-saving automation
                     ├── Redundant automations (two Published automations with equivalent
                     │   trigger+action sets) → Suggest merge/deprecate
                     ├── Conflicting automations (§25) → Suggest resolution
                     └── Unreachable conditions (static analysis: a Condition branch that can
                         provably never be true given current Runtime Object capabilities) →
                         Suggest simplification
   │
   ▼
Every output is a Draft or a Recommendation card — NEVER a Published change. "The AI assists.
The AI never controls" (brief's own words) is the literal behavioral contract, enforced by the
SAME §6 lifecycle gate as every other Draft-origin path.
```

This is explicitly the layer named in the brief as a defining feature — its novelty is
entirely in WHAT it detects (§19's pattern list) and WHERE recommendations surface (§20, §27),
not in a new execution or storage mechanism: every recommendation is generated through §17's
existing Draft pipeline and explained through §27's existing Explainability model.

## §20. AI Recommendation Surfacing (UX)

Recommendations never interrupt — they accumulate as dismissible cards in a single "Suggestions"
surface, visible in Simple Mode as a friendly, templated one-liner ("You've turned off the
Garden Lights manually 6 nights in a row around 11pm — want an automation for that?") and in
Advanced/Expert Mode as the same suggestion with the full Draft graph attached, one click from
review. Declining a suggestion is remembered (never re-suggested identically) — respecting user
intent is part of the trust model, not an afterthought.

## §21. The Three User Experiences (One Engine) — the Central Enhancement of This Revision

**All three modes edit and execute the IDENTICAL Automation definition (§6) through the
IDENTICAL Execution Model (§2).** Mode is a per-user (and per-automation-complexity) INTERFACE
preference, resolved automatically by default and always user-overridable — never a separate
engine, never a separate storage format, never a feature ceiling.

### Simple Mode (default for new/homeowner accounts)

- **Natural language input** (§17's pipeline) is the PRIMARY authoring surface — typing or
  speaking "Turn on Garden Lights at Sunset" produces a Published automation in one approval tap.
- **Templates** (§28.4) presented as named cards with a photo/icon, not a form: "Movie Mode,"
  "Morning Routine," "Vacation Mode," "Good Night" — each pre-wired to auto-map the home's actual
  Runtime Objects (§28.4's mapping engine) with zero manual object selection required in the
  common case.
- **Smart defaults everywhere**: a "Movie Mode" template proposes dimming (not turning off)
  lights it finds already dimmable, closing covers it finds in the media room's Relationship
  graph, and pausing notifications — all inferred from Runtime Object capabilities and
  relationships, never asked as a wizard question when a confident default exists.
- **What Simple Mode users NEVER see, by construction, not by hiding a button**: the graph
  editor, variable references, loop/parallel/compensate nodes, execution policies, expression
  syntax. These aren't grayed out — Simple Mode's UI vocabulary literally has no screen for them,
  because every Simple Mode automation is generated FROM natural language or a template into a
  graph the user never has to open. Opening "Edit" on a Simple Mode automation offers "Edit in
  Advanced Mode" as an explicit, one-way-feeling (but reversible) transition, not an accidental
  door into complexity.
- **Time-to-first-automation target: under two minutes**, addressed directly in §29.

### Advanced Mode (professional integrators, smart-home installers, AV programmers)

- **The full Visual Flow Editor from §10**, unchanged in mechanism, refined in presentation: the
  three-lane canvas (Trigger/Logic/Action), inline last-evaluation-result display, progressive
  disclosure of `loop`/`parallel`/`compensate` as an "advanced palette" tier.
- **Full access to**: Triggers, Conditions, Actions, Variables (§7), Scenes (§8), Debugging,
  Simulation, Execution Tracing (§12), Dependency Viewer (§18's impact estimation, presented as a
  browsable graph), Relationship Browser (direct visual access to the Relationship Engine's
  edges for the objects an automation touches).
- **Explicitly, everything remains visual — no coding required**, per the brief's own
  requirement: the expression language (§7) is entered through a guided builder (pick a Runtime
  Object, pick a relationship/path, pick an operator) with a live-preview of the resulting
  expression string, never a blank code editor as the only input method (a raw-text fallback
  remains available for integrators who prefer typing it directly — optional, never required).

### Expert Mode (enterprise engineers, system architects, large commercial projects)

- **Everything Advanced Mode has**, plus: full graph editing including raw expression/policy
  JSON when desired, distributed execution controls (which controller/site executes a given
  automation, surfaced only when a multi-controller deployment — ADR 0019 §8 — actually exists),
  custom concurrency/retry/timeout policies exposed per-node rather than only per-automation,
  advanced diagnostics (per-node performance profiling, §12, always-captured but only
  SURFACED at this tier by default), and complex orchestration tools (bulk template deployment
  across a Building Model hierarchy — e.g. instantiate a "Hotel Room" template across 200 rooms
  in one operation, §28.4).
- **"Even Expert Mode must remain organized and intuitive"** (brief's own requirement) — achieved
  by keeping the SAME three-lane canvas and node vocabulary as Advanced Mode; Expert Mode adds
  density and bulk operations, it does not introduce a different visual language. An enterprise
  engineer who learned Advanced Mode is never re-trained for Expert Mode, only shown more.

### Automatic mode adaptation

The platform suggests (never forces) a mode transition: a Simple Mode user who edits the same
automation's underlying graph via "Edit in Advanced Mode" three times in a session gets offered
"switch your default to Advanced Mode?" — genuinely adaptive, always reversible, always the
user's explicit choice.

## §22. Universal Trigger Strategy (Final Enumeration)

Confirming: **every** listed trigger category resolves to an existing §3 mechanism — no new
trigger primitive is introduced by this enumeration, closing §15's identified gap by evidence,
not by expanding the model:

| Category | Resolves to (§3 mechanism) |
|---|---|
| Time, Date, Weekday, Weekend, Holiday, Calendar | `schedule.fired` (Scheduler-emitted, calendar/holiday awareness is Scheduler configuration data, not a new event type) |
| Sunrise, Sunset, Astronomical events | `schedule.fired` with `reason` payload (unchanged from original §3) |
| Motion, Presence, Occupancy | `state.changed` on the relevant Presence/Occupancy Projection's Runtime Objects (unchanged) |
| Lux, Temperature, Humidity, CO₂, Voltage, Current, Power, Battery | `state.changed` on the `sensor`/`temperature`/`energy`-family capability of the reporting Runtime Object — every one of these is "a sensor reports a value," architecturally identical, differing only in which capability/unit |
| Weather | Cloud/Plugin-sourced event (unchanged) |
| Energy thresholds | `energy.reading_updated` with threshold comparison (unchanged) |
| Health, Availability | `health.changed` (unchanged) |
| Relationship changes, Capability changes | `relationship.changed`, `capability.changed` (unchanged) |
| Driver events, Plugin events, System events | existing `RuntimeEventType` values or additive plugin-declared types (unchanged) |
| Voice, AI | Action invocation or custom event (unchanged, §3) |
| Security, Camera | `state.changed` on Security/Camera Runtime Objects — Camera specifically noted: motion/person-detection events from a camera are `state.changed` on a `sensor`-capability Runtime Object the camera projects, NEVER a raw video-analysis payload crossing into the Automation Engine |
| BLE, UWB, Geofence | `state.changed` on Presence Runtime Objects sourced by a BLE/UWB/geofencing driver or plugin — identical mechanism to any other presence source, the positioning TECHNOLOGY is invisible above the Driver/Capability Normalization boundary exactly as ADR 0017 requires |
| Webhook, REST, MQTT-sourced | A Cloud/Integration plugin translates the inbound call into a declared custom `RuntimeEventType` (ADR 0020 §3, ADR 0021 §10) — the Automation Engine never parses a webhook payload itself |
| Custom Runtime Events | The general case (§3, unchanged) — everything above is an INSTANCE of this, not an exception to it |

**No protocol-specific trigger logic exists anywhere in this table** — confirmed by construction:
every row bottoms out in `state.changed`/`relationship.changed`/`health.changed`/a
Scheduler-emitted or plugin-declared event, never a protocol name.

## §23. Universal Action Strategy (Final — the Automatic Capability Exposure Guarantee)

**Guarantee, stated explicitly (closing §15's identified gap):** the `command` Action node's
available `action`/`params` options for any `objectRef` are ALWAYS exactly
`RuntimeObject.actions[]` (ADR 0020 §1) for that object's CURRENT capability set — computed live
by the same mechanism the Canonical UI already uses (ADR 0016's `getDeviceUiCapabilities()`),
never a hand-maintained per-capability-type list inside the Automation Engine. This is why the
brief's exhaustive lighting/curtain/climate/media vocabulary requires ZERO new engine code: a
light with `showRGB && showCCT` (ADR 0016) exposes RGB+CCT actions in the Action node picker
automatically, because it exposes them in the Canonical UI automatically, from the identical
capability computation. Adding a new capability sub-mode (say, a future `effects` capability
config) makes it appear in automation Action pickers the instant it appears in the UI — one
change, two surfaces, by construction, never two implementations to keep in sync.

**Absolute vs. relative variants** (absolute dimming vs. relative +10%, absolute position vs.
"open a bit more") are `params` shape variants on the SAME `command` action kind, not separate
Action kinds — the visual editor (§21) presents them as a toggle/mode switch on one Action node,
keeping the node vocabulary small while the parameter space stays rich (directly serving "power
inside the engine, simplicity in the interface").

## §24. Automation Health Model

Every Automation (and, drilled into, every node within it) exposes a health status, computed
continuously from Run history + current Runtime Object state — never a static, manually-set flag:

| Status | Meaning | Derivation |
|---|---|---|
| **Healthy** | Last N runs succeeded, all referenced Runtime Objects available | Run history + `availability` |
| **Waiting** | Published, subscribed, simply hasn't triggered recently | No negative signal present |
| **Disabled** | Explicitly Paused (§6 lifecycle) | Lifecycle state |
| **Warning** | Ran successfully but a referenced object is now `degraded`, or a retry was needed | `health.changed` correlation |
| **Broken** | Last run(s) failed validation or execution with no successful recovery | Run history |
| **Conflict** | Static analysis (§25) finds an overlapping/contradictory automation | Cross-automation analysis |
| **Dependency Missing** | A referenced Runtime Object/relationship no longer exists (e.g. device removed) | `device.removed`/`relationship.changed` correlation |
| **Device Offline** | A referenced Runtime Object's `availability.online` is false | Direct Runtime Object read |
| **Permission Denied** | The automation's acting principal lost a permission a referenced action requires | `permission.changed` correlation |

Every status carries a **human-readable explanation string** generated from the SAME data that
produced the status (e.g. "Broken — the last 3 runs failed at the 'Close Blinds' step: device
Living Room Blinds reports unavailable") — never a bare enum shown to a user. Health is itself a
Runtime Event-driven Projection (ADR 0020 §2 — an "Automation Health Projection"), consistent
with the constitution rather than a bespoke Automation Engine-internal computation.

## §25. Explainability Model

Two symmetric questions, both answered from the SAME Run trace data (§2's node-boundary
checkpointing, §6's Run history) — no separate explanation-generation subsystem:

- **"Why did this execute?"** — the Run's recorded trigger event + the full Condition evaluation
  path (which branches were taken, which were short-circuited) + every Action's actual params and
  result, rendered as a timeline (chronological) AND as a decision-path highlight on the visual
  graph itself (§10/§21 — the SAME canvas, not a separate "explanation view").
- **"Why didn't this execute?"** — for a trigger that fired but produced no visible effect: which
  specific Condition evaluated false, with its actual evaluated value shown inline ("Condition:
  `zone.occupancy == true` — evaluated to `false`, because Living Room reports unoccupied since
  14:32"). For a trigger that never fired at all: confirms the trigger's subscription is active
  (Health, §24) and shows the last N times its underlying event type occurred without matching
  the trigger's filter.

**Conflict detection** (referenced by §19, §24): a standing static analysis comparing every pair
of Published automations for (a) overlapping trigger event types + overlapping target
`objectRef`s with (b) contradictory actions (one sets a light on, the other off, on the same
trigger conditions) — surfaced as a Conflict health status (§24) with both automations named and
linked, never a silent race left for the user to debug manually.

**Duplicate detection**: structural graph comparison (same trigger + equivalent condition tree +
equivalent action set, allowing for `objectRef` differences that resolve to the same actual
Runtime Objects) — surfaced as an Intelligence Layer suggestion (§19), not an error.

**Circular logic detection**: static graph analysis over the `automation` chaining Action kind
(§5) — automation A's action graph invoking automation B invoking automation A is detected at
Draft-validation time (§6, §17 step 3) and BLOCKED from Publish, not merely warned about, because
an actual runtime cycle here would violate §2's determinism guarantee outright.

## §26. Driver-Native Automation Synchronization Strategy

A genuinely new consideration this revision adds (§15) — evaluated per the brief's own framing:

**Discovery**: if a driver's native protocol exposes its own automation primitives (Casambi
timers/scenes/schedules being the concrete example available in this codebase today — see the
existing `casambi-codec.ts` precedent for how driver-native concepts get normalized), the driver
surfaces them through the SAME Capability Normalization pathway (ADR 0017) as any other
structural fact — a NEW, additive capability config shape (`nativeAutomationConfig`), not a
special Automation Engine code path.

**Display**: discovered native automations appear in the SAME automation list as SupremeOS-native
ones, with a clearly visible origin badge ("Casambi Native," tier-gated exactly like
`RuntimeObject.origin.driverKind`, ADR 0020 §1) — "one unified automation experience" per the
brief, achieved by making a native automation project into the identical Automation list/health/
explainability surfaces (§24/§25), not a separate "native automations" tab.

**Editability — decision, with justification:**
- **Read-only by default.** A driver-native scene/timer was authored in a tool SupremeOS doesn't
  control (the Casambi app, an ETS project) — editing it from SupremeOS without round-tripping
  through that tool risks silent divergence, exactly the "duplicate ownership" failure ADR 0021
  §2 forbids. SupremeOS is not positioned to become a second, competing editor for a scene that
  driver's own installer tooling already owns.
- **Import as a first-class option, always available.** "Import" copies the native automation's
  INTENT (its trigger/action shape, translated into a real SupremeOS Automation graph, §1–§5)
  into a genuine, fully-editable SupremeOS Automation — from that point forward it is
  SupremeOS-owned, no longer synchronized with the driver, and the user is told this explicitly
  at import time (no silent fork).
- **Bi-directional sync is explicitly NOT recommended** as a default for any driver: it
  re-introduces dual-writer risk (ADR 0021 §2's single-ownership rule) for marginal benefit — an
  installer who wants a Casambi-authored scene under SupremeOS control has Import; one who wants
  to keep authoring it in Casambi's own app has Read-Only Link. A future driver whose vendor API
  offers a genuinely reliable two-way sync contract MAY be evaluated case-by-case through ADR
  0021 §2's review process, but it is not adopted as a general pattern here.
- **Linked (read-only) display always exists** regardless of import — so an integrator using
  Casambi's own scene tooling still sees a truthful, live-reflected view inside SupremeOS's
  unified automation list, satisfying "the user should see one unified automation experience"
  without SupremeOS pretending to own something it doesn't.

## §27. Predictive Automation Strategy

Positioned explicitly as an EXTENSION of the Intelligence Layer (§19), not a new subsystem:
predicting occupancy/lighting-usage/climate-needs/energy-demand/room-usage/routines is pattern
detection over a LONGER time horizon (weeks/seasons vs. §19's days/repeated-sequences) using the
same Run history + Runtime Event data, surfaced through the SAME Recommendation mechanism (§20)
— "recommend proactive actions," never take one. A predictive suggestion ("Based on your last 3
Mondays, you typically want the office warm by 8am — create an automation?") is, mechanically,
indistinguishable from any other Intelligence Layer suggestion once it reaches the user — the
"predictive" distinction is in the pattern-detection TIME WINDOW, not a new user-facing concept
or engine mechanism. This directly satisfies "enhance the platform without removing user
control" because it never bypasses the §6 Draft→approval gate that governs every other AI
output.

## §28. Additional Enhancements

### §28.1 Automation Versioning

Every Published edit creates a new version (already stated in §6 as "every save is a new Draft
version"); this revision makes the FULL requirement explicit: version comparison (node-for-node
diff, already stated in §10), rollback (republish a prior version — itself a normal Publish
transition, no special rollback code path), and audit attribution — every version records its
author as `{principal: "user:<id>" | "ai:automation-generation" | "installer:<id>"}`, surfaced in
the version history UI so a customer can always see "this automation was last changed by AI
suggestion, approved by [installer name], on [date]."

### §28.2 Automation Templates

A Template is a parameterized Automation Draft (§6) whose `objectRef`s are placeholders resolved
against the target site's actual Building Model + Relationship Engine at instantiation time —
NOT a code-generation mechanism, a data-binding one. "Hotel Room" template instantiated across
200 rooms (§21 Expert Mode's bulk operation) produces 200 real, independently-editable
Automations, each auto-mapped to its own room's lighting/climate/media Runtime Objects via
Relationship queries (ADR 0020 §4) — the exact mechanism §13 (Scalability) already described for
hotel-scale authoring, now named and specified as the Template system the brief asks for.
Template categories named in the brief (Adaptive Lighting, Energy Saving, Cinema, Hotel Room,
Conference Room, Vacation Mode, Morning Routine, Good Night, Security, Emergency) are content —
authored template definitions shipped with SupremeOS — not new mechanism.

### §28.3 Future-Proofing — Cross-reference, not new design

Every item in the brief's Future-Proofing list (enterprise, hospitality, commercial, industrial,
distributed controllers, cloud federation, AI orchestration, cross-building automation, digital
building management) was already addressed structurally in the original §13 (Scalability) and
ADR 0019 §8/§10 — reconfirmed here rather than redesigned, per this ADR's own instruction not to
recommend anything outside the accepted architecture. The one genuinely new item, Driver-Native
Synchronization, is covered in §26.

## §29. User Experience Review

Walking the brief's explicit challenge questions:

- **"Can a homeowner create an automation in under two minutes?"** Yes, by design: natural
  language → Draft → approval (§17, §21 Simple Mode) is a 3-step flow with no required
  intermediate screen; a template card is fewer steps still (name it, confirm auto-mapped
  devices, done). This is a design target this document commits to, not yet empirically measured
  — flagged honestly in §30 as unverified until a real Simple Mode UI is built and timed with
  actual users.
- **"Can a professional engineer create an enterprise workflow without limitations?"** Yes —
  Expert Mode (§21) exposes 100% of §1–§14's engine power; no capability described anywhere in
  this document is Simple/Advanced-Mode-exclusive by engine design, only by interface disclosure.
- **"Can both use the same engine?"** Yes, definitionally — §21 is the enhancement that makes
  this explicit and enforced, not aspirational.
- **"Can complexity remain hidden until needed?"** Yes — progressive disclosure operates at TWO
  levels: across modes (§21) and within Advanced/Expert Mode's own palette tiers (§10's existing
  "advanced palette" for loop/parallel/compensate, unchanged).
- **"Can every workflow become more intuitive?"** The specific, reviewed improvements are: Simple
  Mode's template auto-mapping (removes manual object selection for the common case), inline
  health/explainability on the canvas itself (removes the need for a separate debug view), and
  the Intelligence Layer surfacing suggestions rather than requiring users to notice patterns
  themselves.

## §30. Risks & Trade-offs (Revision 2 additions)

- **The two-minute Simple Mode claim is a design target, not a measured result** — stated
  honestly rather than asserted as proven; validating it requires an actual built UI and user
  testing, out of scope for an architecture document.
- **Driver-native Import creates a one-way fork** (§26) — an installer who imports then later
  edits the original in the driver's own app will NOT see those changes reflected in SupremeOS.
  This is a deliberate trade-off (avoiding dual-writer risk, ADR 0021 §2) stated explicitly, not
  a limitation to silently work around.
- **Automatic mode-adaptation suggestions could feel presumptuous if tuned poorly** — mitigated by
  making the threshold conservative (three manual escapes to Advanced Mode in one session, not
  one) and always dismissible/reversible, but this is a tuning risk that can only really be
  validated with real usage data, not fully resolved on paper.
- **The Automatic Capability Exposure Guarantee (§23) means the Action picker's size scales with
  a device's real capability richness** — a future device with a very large capability surface
  (e.g. a complex AV matrix) could present a long action list in Simple/Advanced Mode; mitigated
  by capability-group collapsing in the picker UI (a UI-layer concern, not an engine change) but
  flagged as a real usability watch-item, not fully solved here.

---

## Summary — Revision 2 Deliverables Cross-Reference

| Deliverable | Section |
|---|---|
| Critical review of ADR 0100 | §15 |
| Recommended enhancements | §16 (rejected complexity) + §17–§28 |
| AI Automation Strategy | §17, §18 |
| Automation Intelligence Layer | §19, §20 |
| Driver-native automation synchronization strategy | §26 |
| Universal Trigger Strategy | §22 |
| Universal Condition Strategy | §4 (unchanged, reconfirmed complete on review — §15) |
| Universal Action Strategy | §23 |
| Automation Health Model | §24 |
| Explainability Model | §25 |
| Predictive Automation Strategy | §27 |
| User Experience Guidelines | §21, §29 |
| Future-proof recommendations | §28.3 |
| Risks & Trade-offs | §30 |
| Updated ADR 0100 (Final) | this document, Revision 2 |

---
---

# Revision 3 — Final Master Architecture Review

No mechanism from Revision 1 or 2 is changed by this revision. This section (a) validates
Sections 1–30 against the final requirement list one more time, with cross-references rather than
re-derivation, and (b) gives full-depth treatment to the two genuinely new proposals this review
was asked to adjudicate: the **Intent Layer** and the **Automation Dependency Map**.

## §31. Validation Pass — Items Already Fully Specified (Revision 2), Reconfirmed

| Item | Status | Where |
|---|---|---|
| Universal Triggers (incl. Camera, BLE, UWB, Webhook/REST/MQTT) | **Reconfirmed complete** — every category resolves to an existing `RuntimeEvent` mechanism, no new primitive needed | §22 |
| Universal Conditions (state, capability, relationship, metadata, health, permission, location, tags, statistics, history, context, nesting, expressions) | **Reconfirmed complete** — §4's condition kinds already cover every listed attribute class; `statistics`/`history` resolve via the `state`/`expression` kinds reading a Runtime Object's `statistics` field (ADR 0020 §1) and Run history respectively — no new Condition kind required | §4, §15 |
| Universal Actions + automatic capability exposure guarantee | **Reconfirmed complete** | §23 |
| AI Automation Generation (conflict/duplicate/circular-logic detection, explanation, visual flow, estimation, mandatory approval) | **Reconfirmed complete** | §17, §18, §25 |
| AI Automation Suggestions (patterns, approval-gated, AI assists/never controls) | **Reconfirmed complete** | §19, §20 |
| Driver-Native Automation Synchronization (discovery, origin badge, read-only default, Import, rejection of default bi-directional sync) | **Reconfirmed complete** | §26 |
| Automation Health (9 states, plain-language explanation) | **Reconfirmed complete** | §24 |
| Explainability (why it ran / why it didn't, timeline, decision path, plain language) | **Reconfirmed complete** | §25 |
| Automation Simulation (dry-run, replay, conflict/dependency/impact analysis, performance estimation) | **Reconfirmed complete** | §12, §18 |
| Automation Versioning (history, diff, rollback, audit, author incl. AI/installer/customer) | **Reconfirmed complete** | §28.1 |
| Automation Templates (named categories, AI auto-mapping, bulk instantiation) | **Reconfirmed complete** | §28.2 |
| Automation Intelligence Layer | **Reconfirmed complete** | §19 |
| Three UI Modes over one engine, Golden UX Principle ("discoverable, not visible") | **Reconfirmed complete AND strengthened** — see §32 | §21, §32 |
| Future-proofing (residential → enterprise, distributed controllers, cloud federation, AI orchestration, cross-building, digital building services) | **Reconfirmed complete** | §28.3, ADR 0019 §8 |

No gaps were found in this pass. The two items below are the only genuinely new material in
Revision 3.

## §32. The Golden UX Principle, Applied Retroactively

This review's brief sharpens Revision 2's progressive disclosure into a precise rule: **hide
complexity, never hide capability — advanced functionality must be discoverable, not
invisible.** Checked against §21's three modes:

- Simple Mode's "Edit in Advanced Mode" escape hatch (§21) already satisfies this — a Simple Mode
  user is never BLOCKED from power, only never confronted with it unprompted. Reconfirmed
  correct, no change needed.
- One sharpening worth naming explicitly: every Simple Mode automation (natural-language- or
  template-authored) must expose a visible, low-friction "Advanced options" affordance on its own
  card (not buried in a settings menu) — the capability is discoverable from the exact place a
  user would look for it, rather than requiring them to already know Advanced Mode exists. This
  is a UI-placement refinement of §21, not a new mechanism.

## §33. Intent Layer — Critical Evaluation

**The question:** should SupremeOS support "keep this outcome true" (e.g. "maintain Living Room
at 22°C while occupied") as a distinct authoring surface from "when X happens, do Y"?

### Architectural analysis

An intent like "maintain 22°C while occupied" is NOT a new execution primitive — worked through
formally, it decomposes into exactly the existing model:

```
Trigger: state.changed on Living Room's temperature sensor, OR schedule.fired (periodic check)
Condition: occupancy == true AND currentTemp outside [21.5, 22.5] (a tolerance band, not a point)
Action: command → climate Runtime Object → set target toward 22°C
```

This is a completely ordinary Automation (§1–§5) with a specific, recognizable SHAPE: a
continuously-re-evaluated trigger, a tolerance-band condition, and a corrective action. Every
example the brief gives (temperature, lux range, security-armed-when-vacant, battery reserve,
conference room comfort, emergency lighting on power loss) decomposes the identical way — a
periodic or state-driven trigger, a "is the outcome currently true" condition, a corrective
action executed only when it's false.

**Verdict: ACCEPT, as an authoring pattern — explicitly REJECT as a second execution engine.**

The brief's own constraint ("no second execution engine, no parallel runtime") is not just
satisfiable, it's the ONLY architecturally sound way to build this — and checking it against
every evaluation question the brief asks:

- **Architecturally valuable?** Yes — it removes a real authoring burden (manually deriving the
  trigger/condition/tolerance-band/action decomposition) without adding a runtime concept.
- **Simplifies automation for users?** Yes, specifically for Simple Mode (§21) — "maintain 22°C
  while occupied" as one sentence is dramatically easier than manually building the 3-node graph
  above, and it fits the Golden UX Principle exactly: the compiled graph is fully DISCOVERABLE
  (an Advanced Mode user opens the same automation and sees the ordinary graph, editable exactly
  like any other) while never being required VIEWING for a Simple Mode user.
- **Remains deterministic?** Yes — because it compiles to §2's ordinary execution model, it
  inherits determinism for free; it adds nothing to reason about beyond an ordinary automation.
- **Fits Runtime Objects/Events?** Yes — no new object type, no new event type; the "keep true"
  semantic is entirely condition-tolerance-band + corrective-action, both existing mechanisms.
- **Violates any Platform Constitution principle?** No — checked explicitly against ADR 0021 §2's
  Architectural Review Checklist: it introduces no second source of truth (the compiled
  Automation IS the automation, stored once, §6 ownership); it doesn't bypass Capability
  Normalization, Commissioning, or Runtime Objects; it doesn't persist Projection state; it
  doesn't create protocol-specific UI.
- **Competitive advantage?** Yes, specifically because most compared platforms (§1 — HA, Node-RED,
  KNX Logic, Control4, Loxone) make outcome-maintenance a manual, multi-block authoring exercise;
  offering it as a first-class Simple Mode sentence while compiling to the SAME auditable,
  explainable graph every other automation uses is a genuine differentiator, not a gimmick.

### Integration — how Intent coexists without duplicate ownership

- **Intent is an AUTHORING MODE, not a stored concept.** There is no `Intent` table, no `Intent`
  Runtime Object type, no `Intent` execution path. An intent phrase is parsed (reusing §17's
  natural-language pipeline exactly) into an ordinary Automation Draft, validated (§6, §9)
  identically to any other Draft, and Published as an ordinary Automation. The ONLY new artifact
  is a `sourceIntent: string` metadata field on the Automation definition (additive, §7's
  Compatibility Policy) — preserved purely for display ("this automation maintains: Living Room
  at 22°C while occupied") and for re-editing the intent phrase itself in Simple Mode without
  losing the friendly framing, never consulted by the execution engine.
- **Re-compilation on edit**: if a user edits the intent phrase in Simple Mode ("change to 21°C"),
  the SAME Automation is re-Drafted (§6 versioning, §28.1) with a new compiled graph — an ordinary
  edit, not a special Intent-update mechanism.
- **Tolerance-band and corrective-action defaults** are template-like content (§28.2's mapping
  engine — resolving "Living Room" to the actual climate Runtime Object, "occupied" to the actual
  Occupancy Projection query) — reusing the Template system's auto-mapping mechanism exactly,
  not a new resolution engine.
- **Advanced/Expert Mode users never see "Intent" as a concept at all** unless they choose Simple
  Mode's phrasing for that one automation — from Advanced Mode, an intent-authored automation is
  indistinguishable from any hand-built one except for the (editable, deletable) `sourceIntent`
  label. This is the concrete enforcement of "no duplicate ownership or architectural confusion"
  the brief asks for: there is exactly one automation, one owner (§6), one way to execute it.

### Evaluation matrix (Intent Layer)

| Criterion | Assessment |
|---|---|
| Architectural purity | High — zero new runtime concepts, purely a Simple Mode authoring pattern + one metadata field |
| User friendliness | High — directly serves the "under two minutes" Simple Mode target for a class of automation that's currently tedious everywhere else in the industry |
| Scalability | Neutral-positive — compiles to ordinary automations, inherits §13's scaling story unchanged |
| AI readiness | High — the natural-language pipeline is the SAME mechanism as §17, no separate AI capability needed |
| Relationship awareness | High — "while occupied," "conference room comfort" are inherently relationship/Projection queries, exercising §4's relationship-aware conditions directly |
| Offline-first | Unaffected — compiled automations run exactly like any other, no cloud dependency introduced |
| Performance | Unaffected — no new evaluation path; a periodic re-check trigger (for "maintain X" outcomes with no natural state-change trigger) is an ordinary `schedule.fired` subscription, not a busy-loop |
| Implementation complexity | Low-medium — the compiler (phrase → tolerance-band graph) is new work, but reuses §17's parsing and §28.2's mapping engine almost entirely |
| Learning curve | Reduces it — this is explicitly a learning-curve-reduction feature |
| Commercial/Residential/Hospitality/Industrial/Enterprise value | Positive across all five — "maintain comfort while booked" (hospitality), "maintain battery reserve" (industrial/energy), "maintain emergency lighting during power loss" (commercial/life-safety-adjacent) are exactly the outcome-oriented asks these markets already phrase requirements as |

**Decision: ACCEPT**, scoped exactly as above — an authoring-time compiler into ordinary
Automations, never a runtime concept.

## §34. Automation Dependency Map — Critical Evaluation

**The question:** should SupremeOS provide a visual relationship explorer showing how devices,
automations, and their effects connect (Motion Sensor → Night Entry Automation → Hallway Light →
Energy Monitor → Notification)?

### Architectural analysis

This is explicitly NOT a new engine, and the review confirms the brief's own framing is
correct: it is a **read-only visualization over data that already exists in full** —

- The nodes (devices, automations, notifications) are Runtime Objects + Automation definitions,
  already owned by the Device Registry (ADR 0018) and the Automation Engine (§6), respectively.
- The edges (Motion Sensor *triggers* Night Entry Automation; Night Entry Automation *controls*
  Hallway Light; Hallway Light *consumesEnergyFrom* a circuit the Energy Monitor watches; the
  automation *sends* a Notification action) are ALREADY the Relationship Engine's typed edges
  (ADR 0020 §4's `dependsOn`/`controls`/`consumesEnergyFrom` vocabulary) PLUS one edge class this
  review confirms is new: **automation-to-trigger-source** and **automation-to-action-target**
  edges — which are not device-to-device relationships, they are automation-graph facts already
  fully present inside every Automation's own definition (§1's Trigger/Action nodes reference
  `objectRef`s directly).

**This is the key architectural finding: the Dependency Map requires ZERO new data ownership.**
Every edge it displays is either (a) an existing Relationship Engine edge, or (b) directly
derivable from parsing an Automation's own Trigger/Condition/Action graph (which `objectRef`s
does it read, which does it write) — a computation, not a stored fact. It is, precisely, a
**Projection** (ADR 0020 §2) — specifically, closest in kind to the "Relationship" and
"AI-query" projections ADR 0020 §2's table already named as illustrative examples, now given a
concrete purpose and a name: the **Automation Dependency Projection**.

- **Should it exist?** Yes — it answers a real, currently-unaddressed need (§25's Explainability
  covers ONE automation's own decision path; this covers the WEB of automations/devices around
  one thing, which Explainability was never designed to show).
- **Generated automatically?** Yes, and must be — a hand-maintained dependency map is exactly the
  "second source of truth via staleness" failure mode ADR 0021 §2 question 1 exists to catch;
  automatic derivation from the Relationship Engine + Automation definitions is the only
  acceptable implementation.
- **Uses Runtime Relationships?** Yes, directly (§4 above).
- **Uses Runtime Events?** Yes for LIVE updates (a `relationship.changed` or automation edit event
  triggers a Dependency Projection recompute — same lifecycle as any Projection, ADR 0020 §5) —
  not for the graph's static structure, which is a query, not an event-sourced accumulation.
- **Part of debugging?** Yes — it is the natural drill-down FROM a Health/Explainability view
  (§24/§25): "this automation is Broken" → "show me its dependency map" → "the Hallway Light it
  controls is offline" is one coherent flow, not two disconnected tools.
- **Impact analysis / "what breaks if I remove this device"?** Yes — this is EXACTLY §18's Impact
  Estimation (already specified in Revision 2) visualized as a graph instead of a text estimate —
  not new capability, a new PRESENTATION of existing capability. Confirming: no redesign of §18
  is implied or needed, only a graph rendering of its existing output.
- **AI explanations?** Yes — an AI narrating a dependency map ("removing this sensor would break
  2 automations and leave the hallway unlit at night") is §25's Explainability model applied to
  a multi-node subgraph instead of one automation's single Run trace — same underlying mechanism.

### Where it belongs

**Decision: belongs inside ADR 0100, NOT deferred to a future Diagnostics subsystem** — reasoning
explicitly against the brief's own posed alternative: a separate "Diagnostics subsystem" would
either (a) duplicate the Relationship Engine query logic this Projection already needs, violating
ADR 0021 §2, or (b) BE this same Projection under a different product label. Since the underlying
mechanism (a Projection reading Relationships + Automation definitions) is entirely automation-
domain data, it is scoped here as the **Automation Dependency Projection**, consumed by:
the Visual Editor (§10/§21, as a "Dependency Viewer" — already NAMED in Revision 2's Advanced
Mode feature list, now fully specified rather than just named), the Health/Explainability
surfaces (§24/§25, as a drill-down), and — genuinely reusable, not automation-exclusive — future
non-automation Diagnostics tooling MAY consume the same Relationship Engine query primitives this
Projection is built from, without needing its own copy of them (the Relationship Engine, ADR
0019/0020, was always meant to be queried by many Projections; this is exactly that pattern,
correctly applied, not a boundary violation).

### Evaluation matrix (Automation Dependency Map)

| Criterion | Assessment |
|---|---|
| Architectural purity | High — a pure Projection, zero new ownership, confirmed by explicit trace of every edge to an existing source |
| User friendliness | High for Advanced/Expert Mode (its actual audience, per the brief's own "help installers" framing) — correctly NOT proposed for Simple Mode, avoiding Golden-UX violation |
| Scalability | Positive at commercial/campus scale specifically — this is where "large automation projects become difficult to understand" (brief's own justification) actually bites; a single-apartment install has little need for it, which is fine, it's Advanced/Expert-tier by design |
| AI readiness | High — direct extension of existing Explainability (§25) and Impact Estimation (§18) |
| Relationship awareness | Maximal — this IS a relationship-awareness feature, definitionally |
| Offline-first | Unaffected — a local Projection, no cloud dependency |
| Performance | Bounded by graph size of the queried subgraph (typically one automation's neighborhood, not the whole site) — no full-site traversal required for the common "what does THIS depend on" query |
| Implementation complexity | Low — genuinely a rendering + query-composition exercise over mechanisms Revision 2 already specified (§4 relationship queries, §18 impact estimation, §20 recommendation surfacing for AI explanations) |
| Learning curve | None added — it's a visualization of things integrators already conceptually track manually today, made explicit |
| Commercial/Hospitality/Industrial/Enterprise value | High — directly named by the brief as solving a real large-project pain point; residential value is low but harmless (simply unused by most homeowners, never forced on them) |

**Decision: ACCEPT**, scoped exactly as above — an Automation Dependency Projection (a specific,
named instance of ADR 0020's existing Projection concept), surfaced in Advanced/Expert Mode's
Dependency Viewer and as a drill-down from Health/Explainability — never a new engine, never a
new stored graph, never Simple-Mode-visible.

## §35. Why No Platform Constitution Principle Is Violated (Both Proposals)

Checked explicitly against every ADR 0021 §2 Architectural Review Checklist question, for both
proposals together:

1. New source of truth? **No** — Intent compiles into the existing Automation store (§6); the
   Dependency Map is a pure Projection with no storage of its own beyond the standard disposable
   cache (ADR 0020 §2).
2. Bypasses Capability Normalization? **No** — both consume Runtime Objects/Capabilities exactly
   as every other automation mechanism does.
3. Bypasses Universal Commissioning? **No** — neither touches the Device Registry.
4. Bypasses Runtime Objects? **No** — both are built entirely FROM Runtime Objects/Relationships.
5. Exposes protocol-specific objects? **No** — neither introduces any protocol awareness.
6. Duplicates ownership? **No** — this was the central question for both, and both were
   specifically designed (§33, §34) to resolve to zero duplicate ownership: Intent owns nothing
   (it's a compiler), the Dependency Map owns nothing (it's a Projection).
7. Persists Projection state as a system of record? **No** — the Dependency Map's cache, if any,
   is rebuildable exactly per ADR 0020 §2's disposability rule.
8. Bypasses the Event Bus unjustified? **No** — both consume events through the standard
   mechanism (Intent's compiled automation subscribes normally; the Dependency Projection
   recomputes on `relationship.changed`/automation-edit events).
9. Creates protocol-specific UI? **No.**
10. Leaks driver internals? **No.**

Both proposals pass the checklist cleanly — the accept decisions in §33/§34 are not close calls.

## §36. Risks & Trade-offs (Revision 3 additions)

- **Intent Layer's tolerance-band defaults require good judgment to not annoy users** (too tight
  a band causes constant micro-adjustment "hunting"; too loose feels unresponsive) — a tuning
  risk in the compiler's default-generation logic, not an architectural risk; mitigated by
  exposing the compiled tolerance band as an editable Advanced Mode parameter (§21's discoverable-
  not-visible principle applies directly: the default is invisible complexity, the override is
  discoverable).
- **Intent phrases are inherently more ambiguous than explicit trigger/action authoring** ("while
  occupied" — occupied by whom, detected how) — mitigated by the SAME conflict/ambiguity
  detection §17 already specifies for AI-generated automations generally; no new safety mechanism
  needed, but flagged as a place where the EXISTING mechanism will be exercised harder than for a
  simple "turn on X at sunset" generation.
- **Dependency Map could become visually overwhelming on a large campus graph** if rendered
  naively (thousands of nodes) — mitigated by scoping every rendered view to a bounded
  neighborhood (one automation + its direct dependencies, expandable on demand) rather than ever
  rendering a whole-site graph by default — a UI-layer safeguard, not an architecture change.
- **Neither proposal was validated against a real user** — both decisions rest on architectural
  and industry-comparison reasoning (§1's paradigm study, competitor feature comparison), not
  usability testing; stated honestly, consistent with §30's precedent of not overclaiming
  unverified UX outcomes.

## §37. Recommendation: Should ADR 0100 Be Amended?

**Yes — amended, not rewritten.** Both proposals are accepted and are formally incorporated as
of this revision:

- **Intent Layer** is added to §5 (Action Model)/§21 (Simple Mode) as a natural-language
  AUTHORING PATTERN that compiles to an ordinary Automation with a `sourceIntent` metadata field
  (§7 Compatibility Policy — additive, non-breaking).
- **Automation Dependency Map**, formally named the **Automation Dependency Projection**, is
  added as a specific named Projection instance, surfaced through the already-named-but-
  previously-unspecified "Dependency Viewer" (§10/§21) and as a Health/Explainability drill-down
  (§24/§25).

No section of Revision 1 or 2 required a rewrite — both proposals slotted into existing extension
points exactly as ADR 0021 §4's Evolution Policy predicts a well-formed feature request should
(§4's table: "new dashboard/visualization → new Projection," "new automation capability →
consumes Runtime Objects," both followed to the letter here). This is itself a validation of the
underlying Platform Constitution's design, not just of these two features.

---

## Summary — Revision 3 Deliverables Cross-Reference

| Deliverable | Section |
|---|---|
| Critical review of ADR 0100 Revision 2 | §31, §32 |
| AI Automation Strategy | §17, §18 (reconfirmed §31) |
| Automation Intelligence Layer | §19, §20 (reconfirmed §31) |
| Universal Trigger validation | §22 (reconfirmed §31) |
| Universal Condition validation | §4 (reconfirmed §31) |
| Universal Action validation | §23 (reconfirmed §31) |
| Driver-native automation synchronization strategy | §26 (reconfirmed §31) |
| Intent Layer evaluation (Accept/Reject) | §33 — **ACCEPT** |
| Automation Dependency Map evaluation (Accept/Reject) | §34 — **ACCEPT** |
| Automation Health model | §24 (reconfirmed §31) |
| Explainability model | §25 (reconfirmed §31) |
| User Experience Guidelines | §21, §29, §32 |
| Future-proof recommendations | §28.3 (reconfirmed §31) |
| Risks & Trade-offs | §36 |
| Updated ADR 0100 Final | this document, Revision 3 — §37's amendment |
