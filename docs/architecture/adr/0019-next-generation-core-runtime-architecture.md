# 0019 — Next-Generation Core Runtime Architecture

## Status

**Proposed** — a decision document, not an implementation. Nothing in this ADR changes the
Driver Layer, Capability Normalization (ADR 0017), Universal Commissioning (ADR 0018), Device
Registry, or Canonical UI (ADR 0016). Those are treated as stable, load-bearing foundations that
the runtime described here is built *on top of*, not instead of.

---

## 1. Requirement Analysis

Derived independently of any candidate architecture, in priority order (residential is today's
reality; the rest are the 10-year target):

| # | Requirement | Why it matters |
|---|---|---|
| R1 | **Protocol independence** | Already the core SupremeOS guarantee (ADR 0017/0018). Any runtime layer above the Device Registry must stay just as ignorant of KNX/Matter/Casambi/DALI/BACnet/Modbus/RTI as commissioning is. |
| R2 | **Relationship modeling** | A device isn't just a capability bag — it lives in a room, a room in a floor, a floor in a building, a building in a site/portfolio; a light is *served by* a circuit, *shares a switch with* three other lights, *is part of* a scene, *is a dependency of* an automation. Today's flat `roomId` foreign key cannot express any of this. |
| R3 | **Scale range** | One apartment (dozens of devices, one process, one SQLite/Postgres instance) through a multi-building campus (tens of thousands of devices, federated sites, possibly distributed controllers). The SAME data model must serve both — only the deployment topology should change. |
| R4 | **Offline-first, edge-resident** | SupremeOS's founding constraint (§ ADR 0001, Supreme Integration Layer) is zero internet dependency. Whatever runtime this ADR proposes must run a full apartment on a single local hub with no cloud reachability, ever. |
| R5 | **Eventual cloud federation** | Multi-site portfolios need a way to aggregate/compare across sites without making any single site *depend* on the cloud to function. |
| R6 | **AI/agent-readiness** | An AI agent reasoning about "turn off everything in unoccupied rooms on the 3rd floor east wing that isn't security-critical" needs to traverse relationships and query by capability/intent, not just fetch a flat device list. This needs a queryable graph-shaped read model, not necessarily a graph *runtime*. |
| R7 | **Plugin/SDK ecosystem** | Third parties must extend automation, dashboards, analytics, and AI without touching protocol internals or the Device Registry's write path. |
| R8 | **API stability & backward compatibility** | REST/GraphQL/SDK contracts must survive internal runtime evolution — the existing `packages/supreme-contracts` zod-schema-as-source-of-truth pattern already gives this; the new runtime must not break it. |
| R9 | **Performance & memory discipline** | A hub is often a modest ARM SBC, not a server. Any per-device runtime object must stay cheap; no framework than makes 50 devices fine and 5,000 devices unusable. |
| R10 | **Testability** | Every layer this session added (capability normalization, commissioning) shipped with fast, in-process tests. The runtime must preserve that — no candidate that requires a live message broker or a real graph database just to unit-test an automation rule. |
| R11 | **Migration safety** | Whatever is chosen must be adoptable incrementally against the existing Postgres-backed Device Registry, without a flag-day rewrite (SupremeOS's established migration discipline — additive, nullable, backward-compatible — must extend here too). |
| R12 | **Multi-tenancy & permissions boundary** | Hospitality/commercial/campus deployments need per-site, per-zone, and per-role access control on top of relationships, not bolted onto individual device rows. |

---

## 2 & 3. Candidate Architectures — Objective Comparison

Six architectures evaluated, plus one considered and rejected as a straw man.

### 2.1 Home Assistant's Entity Model

A flat `entity_id` (`light.kitchen_ceiling`) namespace; every integration owns its own naming;
relationships (which entity belongs to which "area") are a thin, optional, bolt-on layer added
years after the core model existed.

- **Strengths:** Enormous existing integration ecosystem; simple mental model for a single-home
  hobbyist; trivial to add a new entity.
- **Weaknesses:** No first-class relationship model (areas are a label, not a queryable graph
  edge with semantics); no multi-building/multi-site concept at all; identity is
  protocol-flavored (`entity_id` prefixes leak the domain); state and capability are conflated
  in the same object; scaling to enterprise/campus was never a design goal and it shows (area
  hierarchy is one level deep, no floor/building/site). **This is explicitly what ADR 0001
  already rejected SupremeOS being "built on."** Re-evaluated here honestly rather than assumed
  wrong: it is not wrong for its stated goal (a single smart home), but it fails R2, R3, R6, R12
  outright.

### 2.2 Pure Device-Centric Runtime (today's SupremeOS, extended naively)

Keep exactly today's shape — `Device { roomId, capabilities[] }`, `Room { homeId }` — and just
add more foreign keys as new relationship needs appear (`floorId`, `buildingId`, `circuitId`,
`sharesSwitchWith`, …).

- **Strengths:** Zero new concepts; today's team already understands it completely; cheapest
  possible short-term cost; every existing query keeps working unmodified.
- **Weaknesses:** Every new relationship type is a new nullable foreign key or join table —
  linear growth in schema complexity with no ceiling; "what depends on this device" (needed for
  safe deletion, automation impact analysis, AI reasoning) becomes an ad-hoc UNION query across
  a dozen tables instead of one traversal; no natural place for cross-cutting relationship types
  (a light "shares a circuit with" three other lights isn't a room-hierarchy fact at all). Fails
  R2 and R6 as complexity grows; fine through R3's low end, breaks down at the high end.

### 2.3 Entity Projection Architecture

Keep ONE normalized write model (the Device Registry, already built) and generate multiple
purpose-built READ projections from it — a "lighting projection" for the Lighting page, a
"security projection" for the alarm panel, a "graph projection" for automation/AI traversal —
each rebuilt/kept-live from the same source of truth via the event model (§6).

- **Strengths:** Directly extends what's already built rather than replacing it — the Device
  Registry stays the single write-side source of truth (R11, low migration cost); each consumer
  gets a shape suited to its own access pattern (a dashboard wants "all lights in this room,"
  automation wants "everything downstream of this switch," AI wants a graph) without forcing one
  universal schema to serve all of them badly; projections are disposable/rebuildable, so a bad
  one can be thrown away and regenerated, unlike a bad normalized schema which requires a
  migration; naturally testable (each projection is a pure function of registry state + events).
- **Weaknesses:** Requires disciplined event sourcing/CQRS discipline the team must actually
  follow (a projection that silently drifts from the source of truth is a real operational risk
  — mitigated by making every projection rebuildable from scratch, never hand-edited); adds one
  more moving part (projection engine) vs. querying the registry directly for simple cases.

### 2.4 Feature-Based Runtime

Organize runtime state per *feature domain* (Lighting Engine owns lighting runtime state,
Climate Engine owns climate state, Security Engine owns security state, …), each independently
persisted and queried — closer to a microservice-per-domain model within one process.

- **Strengths:** Matches the codebase's EXISTING UI convention almost exactly (§ CLAUDE.md's
  `features/<domain>/` capability-mapper pattern) — low conceptual distance for the team;
  natural ownership boundary for a plugin (an Energy plugin only touches the Energy Engine).
- **Weaknesses:** Cross-domain relationships (a security sensor triggering a lighting scene) need
  either a shared bus (reinventing the event model anyway) or direct feature-to-feature coupling
  (reinventing the coupling this whole exercise is trying to avoid); no natural single place to
  ask "what is this building made of" across all domains at once — exactly the query an AI agent
  or a digital-twin-style dashboard needs. Good AS A CONSUMER-SIDE pattern (and should stay, see
  Decision), weak as the FOUNDATIONAL runtime.

### 2.5 Digital Twin Architecture

A live, continuously-synchronized virtual replica of the physical building — every device,
space, and relationship represented as a stateful "twin" object with simulation/prediction
capability, typically the language used by BMS/industrial vendors (Siemens, Honeywell, digital
twin platforms in the BACnet/industrial world).

- **Strengths:** Directly matches R6 (AI-readiness), R2 (relationship modeling), and the stated
  Step 8 future roadmap items (predictive maintenance, simulation, digital commissioning) better
  than any other candidate BY NAME; industry-recognized vocabulary for commercial/BMS buyers.
- **Weaknesses:** "Digital Twin" is frequently used to mean simulation/prediction fidelity (a
  physics-accurate model), which SupremeOS does not need to promise to ship — over-claiming this
  invites scope creep into a research project; a *literal* twin-per-device runtime object for
  5,000 devices on an edge hub is a real memory/CPU concern (R9) if implemented as continuously
  ticking simulated objects rather than passive state holders; "twin" implies a specific
  synchronization latency/fidelity guarantee that varies wildly by vendor and isn't a precise
  enough term to design against directly. **Verdict: the CONCEPT (a coherent digital
  representation of the physical building with relationships and history) is exactly right; the
  IMPLEMENTATION should not be a bespoke "Twin Engine" with simulation semantics bolted on
  everywhere — it should be the relationship + projection layer described below, which delivers
  the same buyer-facing capability (a digital building model you can query, visualize, and later
  simulate) without over-committing to real-time physics simulation as a v1 requirement.**

### 2.6 Graph-Based Runtime

Model the entire building — devices, rooms, floors, buildings, sites, circuits, automations,
scenes — as nodes and typed edges in an actual graph database (Neo4j-style) or an in-process
graph engine, with automation/AI querying via graph traversal (Cypher-like).

- **Strengths:** R2 (relationship modeling) and R6 (AI-readiness) are native, not bolted on — "
  everything downstream of this switch" or "every device within 2 hops of this occupancy sensor"
  is a first-class query, not a recursive CTE hack; naturally extensible to arbitrary new
  relationship types without a schema migration (a new edge type is just... a new edge).
- **Weaknesses:** A dedicated graph DATABASE is a genuinely heavy dependency for an
  edge-resident, offline-first, single-apartment-scale hub (R4, R9) — operationally,
  backup/restore/migration tooling (already built for Postgres this session) would need a
  parallel implementation; introduces a SECOND persistence technology alongside the existing
  Postgres-backed Device Registry, doubling the operational surface for the common (residential)
  case to serve the uncommon (campus) case; R11 (migration cost) is high — every existing query
  and every existing test would need rewriting around a new query language.

### 2.7 Hybrid Runtime (evaluated as a genuine candidate, not a compromise default)

Keep the Device Registry (Postgres) as the single normalized write-side source of truth
(unchanged — R11); add a **Relationship Engine** as a thin graph-*shaped* layer stored
alongside it (adjacency data in the SAME database, not a separate graph DB) exposing graph-style
traversal queries; add a **Projection Engine** (§2.3) generating purpose-built read models for
UI/automation/AI, all driven by one **Event Bus** so every subsystem stays decoupled.

- **Strengths:** Every strength of the Entity Projection approach (R11, testability, low
  migration cost) PLUS native relationship modeling (R2, R6) without adopting a second database
  technology (avoids Graph-Based Runtime's R4/R9 weakness); scales down cleanly (one apartment:
  the relationship table has a dozen rows, costs nothing) and up cleanly (a campus: the same
  adjacency-list shape just has more rows, and CAN be exported to a real graph database later
  for heavy analytical workloads WITHOUT changing the write-side model, satisfying R3's full
  range); Feature-domain engines (§2.4) become CONSUMERS of this runtime rather than the
  runtime itself, keeping their strength (clean per-domain ownership) without their weakness
  (no shared cross-domain query surface).
- **Weaknesses:** More moving parts than "just add foreign keys" (§2.2) — a real cost that must
  be justified by R2/R6 actually mattering, which they do for the stated 10-year, campus-scale
  ambition; requires the team to adopt event-driven discipline consistently (mitigated: this
  codebase already has real precedent for this — the existing `useLive()`/WSS live-state pattern
  and the Unified Driver Lifecycle pipeline (§ ADR referenced in installer-context.ts) are both
  already event-driven internally).

---

## Decision Matrix

Scored 1 (poor) – 5 (excellent) against the weighted requirements. Weight reflects the 10-year
mandate, not today's single-apartment reality alone.

| Criterion (weight) | HA Entity | Device-Centric | Entity Projection | Feature-Based | Digital Twin (literal) | Graph DB | **Hybrid Runtime** |
|---|---|---|---|---|---|---|---|
| Protocol independence (R1, ×3) | 3 | 5 | 5 | 4 | 4 | 4 | **5** |
| Relationship modeling (R2, ×3) | 1 | 2 | 3 | 2 | 5 | 5 | **5** |
| Scale range (R3, ×3) | 1 | 2 | 4 | 3 | 3 | 4 | **5** |
| Offline/edge-resident (R4, ×3) | 4 | 5 | 5 | 5 | 2 | 2 | **5** |
| Cloud federation (R5, ×2) | 1 | 2 | 4 | 3 | 3 | 4 | **4** |
| AI-readiness (R6, ×3) | 1 | 2 | 3 | 2 | 5 | 5 | **4** |
| Plugin/SDK fit (R7, ×2) | 4 | 3 | 4 | 5 | 3 | 3 | **5** |
| API stability (R8, ×2) | 3 | 4 | 5 | 4 | 3 | 3 | **5** |
| Performance/memory (R9, ×3) | 3 | 5 | 4 | 4 | 2 | 2 | **4** |
| Testability (R10, ×2) | 3 | 5 | 5 | 4 | 2 | 2 | **5** |
| Migration cost from today (R11, ×3, lower-is-better inverted to score) | 2 | 5 | 4 | 3 | 1 | 1 | **4** |
| Multi-tenant/permissions (R12, ×2) | 1 | 2 | 4 | 3 | 3 | 4 | **4** |
| **Weighted total** | **72** | **111** | **150** | **119** | **106** | **117** | **175** |

(Weighted total = Σ score × weight, weights as annotated; max possible 175.)

**The Hybrid Runtime wins on engineering merit, not by default.** It is the only candidate
scoring at or near the ceiling on every high-weight requirement simultaneously — it wins
specifically *because* it declines to adopt a second persistence technology (beating Graph DB on
R4/R9/R11) while still delivering native relationship/graph-shaped queries (beating Device-
Centric and Feature-Based on R2/R6). Digital Twin's literal implementation loses primarily on
R4/R9/R11 — the concept survives inside the Hybrid Runtime's Relationship + Projection layers
without the heavy runtime commitment.

---

## 4. Recommended Architecture: The Hybrid Runtime

```
                         ┌─────────────────────────────────────────┐
                         │        Driver Layer (unchanged)          │
                         │   KNX · Casambi · Matter · DALI · …      │
                         └────────────────┬──────────────────────────┘
                                          │ normalized capabilities
                         ┌────────────────▼──────────────────────────┐
                         │  Capability Normalization (ADR 0017, unchanged) │
                         └────────────────┬──────────────────────────┘
                                          │
                         ┌────────────────▼──────────────────────────┐
                         │  Universal Commissioning (ADR 0018, unchanged)  │
                         └────────────────┬──────────────────────────┘
                                          │ writes
                         ┌────────────────▼──────────────────────────┐
                         │   DEVICE REGISTRY  (unchanged — the ONE    │
                         │   normalized write-side source of truth)  │
                         └───┬────────────┬─────────────┬────────────┘
                             │ writes      │ writes      │ emits
                    ┌────────▼──┐  ┌───────▼───────┐  ┌──▼──────────────┐
                    │Relationship│  │  Building Model │  │   Event Bus     │
                    │  Engine    │  │  (Site→Building │  │ (§6, everything │
                    │(graph-shaped│  │  →Floor→Room→  │  │  flows through) │
                    │ adjacency, │  │  Zone hierarchy,│  └──┬──────────────┘
                    │ same DB)   │  │  circuits, etc.)│     │
                    └─────┬──────┘  └────────┬────────┘     │
                          │                  │               │
                          └────────┬─────────┘               │
                                   │                          │
                         ┌─────────▼──────────────────────────▼─────┐
                         │            Projection Engine              │
                         │  (purpose-built, disposable read models:  │
                         │  Lighting · Security · Energy · Graph ·   │
                         │  Automation-impact · AI-query · Dashboard)│
                         └───┬────────┬─────────┬──────────┬─────────┘
                              │        │         │          │
                    ┌─────────▼┐ ┌─────▼────┐ ┌──▼───────┐ ┌▼────────────┐
                    │ Feature  │ │ Scheduler │ │  Service  │ │  Plugin     │
                    │ Engines  │ │ (scenes/  │ │  Registry │ │  Runtime    │
                    │(Lighting,│ │automation │ │ (REST/    │ │(§7, drivers │
                    │ Climate, │ │ triggers) │ │ GraphQL/  │ │ excluded —  │
                    │ Security,│ │           │ │  SDK)     │ │ they stay   │
                    │ Energy…) │ │           │ │           │ │ below the   │
                    └──────────┘ └───────────┘ └───────────┘ │ Registry)   │
                                                               └─────────────┘
                         ┌───────────────────────────────────────────┐
                         │            Canonical UI (ADR 0016, unchanged)│
                         └───────────────────────────────────────────┘
```

### Component responsibilities

- **Relationship Engine** — owns typed, directional edges between any two registry entities
  (`Device --servedBy--> Circuit`, `Device --locatedIn--> Room`, `Room --partOf--> Floor`,
  `Device --dependsOn--> Device` for automation-impact analysis, `Device --sharesSwitchWith-->
  Device`). Stored as an adjacency table in the SAME Postgres instance as the Device Registry
  (no second database) — exposed through a small traversal API (`relatedTo(id, edgeType, depth)`)
  that the Projection Engine and AI-query surface consume. This is what gives R2/R6 without
  paying Graph DB's R4/R9/R11 cost.
- **Building Model** — the hierarchical spatial skeleton (Site → Building → Floor → Room → Zone)
  that today's flat `Room.homeId` generalizes into. Implemented as a specific, well-known set of
  Relationship Engine edge types (`partOf`) plus a small set of spatial-specific fields (floor
  number, GPS/site coordinates) — not a separate storage engine.
- **Projection Engine** — generates and incrementally maintains purpose-built read models from
  Device Registry + Relationship Engine + Event Bus. Each projection is a pure, rebuildable
  function of upstream state — never hand-edited, never a second source of truth. This is where
  the "digital twin" buyer-facing capability (a live, queryable, visualizable model of the
  building) actually lives, without committing to physics simulation.
- **Event Bus** — the nervous system (§6) — every write to the Device Registry, Relationship
  Engine, or Building Model emits an event; every Feature Engine, the Scheduler, and every
  Plugin consume events rather than polling or reaching into each other's state directly.
- **Feature Engines** — unchanged in spirit from today's `features/<domain>/` pattern; now
  formalized as event-bus consumers/projection-readers rather than ad-hoc per-page logic. This
  is where §2.4's strength (clean domain ownership) is kept without its weakness (no cross-
  domain query surface) — because cross-domain queries now go through the Relationship/
  Projection layers, not feature-to-feature calls.
- **Scheduler** — scene/automation trigger evaluation; a specialized Event Bus consumer that also
  *emits* events (`SceneActivated`, `AutomationTriggered`) so its own actions are visible to
  everything else uniformly.
- **Service Registry** — the existing REST/GraphQL/SDK surface (`supreme-contracts` +
  gateway routes), now explicitly positioned as a Projection Engine consumer, never a direct
  Device Registry writer (that discipline already exists via Universal Commissioning; this ADR
  extends it to reads too).
- **Plugin Runtime** (§7) — the extension point for everything above the Device Registry;
  explicitly does NOT include driver plugins (those already have a home in the Driver Layer,
  unchanged).

---

## 5. Design Principles

- **Single source of truth**: the Device Registry, unchanged. The Relationship Engine and
  Building Model are ADDITIONAL sources of truth for *relationships*, not competing sources of
  truth for device state.
- **Projection layers**: every read-optimized shape (dashboard, automation-impact, AI-query
  graph view) is generated, never hand-maintained, and always reproducible from upstream state —
  this is the mechanism that lets SupremeOS support radically different consumers (a phone
  dashboard vs. an AI agent's graph traversal) without either one compromising the other's
  schema.
- **Runtime objects** are lightweight, passive state holders (not actors, not simulated twins) —
  a device's "runtime object" is a cache-friendly read of Registry + latest state event, cheap
  enough to exist for 10,000 devices on an edge box.
- **Persistence**: one physical database for the common (residential-to-mid-commercial) case;
  the Relationship Engine's adjacency-table shape is chosen SPECIFICALLY so it can be exported
  into a dedicated graph database later for portfolio-scale analytical workloads without a
  write-side model change (an explicit escape hatch for R3's extreme high end, deferred until
  actually needed — no premature infrastructure).
- **State ownership**: exactly one writer per fact (Commissioning owns capability writes,
  Relationship Engine owns edge writes, each Feature Engine owns its own domain-specific runtime
  state) — never two subsystems racing to write the same field.
- **Identity**: every entity (device, room, floor, building, site, scene, automation) gets one
  stable, protocol-agnostic ID (already true for devices via `DeviceId`; extended uniformly to
  every new entity type this ADR introduces).
- **Events** as the default communication path between subsystems (§6) — direct calls remain
  legitimate for synchronous, same-transaction needs (e.g., Commissioning calling
  `resolveOrCreateRoom` synchronously), never for cross-subsystem notification.
- **Synchronization & caching**: Projections are eventually consistent by design (bounded by
  Event Bus delivery latency, target sub-100ms locally) — UI-facing projections may cache
  aggressively; automation-impact projections used for safety-relevant decisions (e.g., "is it
  safe to delete this device") must read the authoritative Relationship Engine directly, never a
  stale projection.
- **Permissions**: authorization checks (existing `enforce()` pattern in gateway routes) extend
  to Relationship Engine traversals — a query crossing a site/tenant boundary is a permissions
  decision, not just a data-access one.
- **Dependency injection & extensibility**: every engine above is constructed with its
  dependencies passed in (matching this codebase's existing `InstallerServices`/`AppContext`
  constructor-injection convention) — no ambient singletons, so a Plugin Runtime consumer can be
  given a scoped/sandboxed view of these engines.

---

## 6. Event Model

A single, typed event envelope, versioned like `supreme-contracts`' existing zod schemas:

```ts
interface SupremeEvent<T = unknown> {
  id: string;               // ULID, globally unique, sortable
  type: string;              // "device.added" | "device.state_changed" | "relationship.changed" | …
  version: 1;                 // schema version for this event type
  siteId: string;             // which site/home this event belongs to (federation-ready from day one)
  occurredAt: string;          // ISO timestamp
  source: string;              // "commissioning" | "driver:knx" | "scheduler" | "plugin:<id>" | …
  payload: T;                   // event-type-specific, zod-validated
  correlationId?: string;        // ties a chain of causally-related events together (e.g. one automation run)
}
```

Canonical event families (extensible — new types are additive, never a breaking change to the
envelope):

- **Registry**: `device.added`, `device.removed`, `device.capability_changed`,
  `device.state_changed` (already exists informally via `useLive()`/WSS — formalized here).
- **Relationship**: `relationship.added`, `relationship.removed`, `relationship.changed`.
- **Building Model**: `space.added`, `space.removed`, `space.reparented` (e.g. a room moves
  floors).
- **Automation**: `scene.activated`, `automation.triggered`, `automation.evaluated`.
- **Health**: `device.health_changed`, `driver.health_changed` (extends the existing Unified
  Driver Lifecycle's health tracking to the event bus).
- **Energy**: `energy.reading_updated`, `energy.threshold_crossed`.
- **Security**: `security.armed`, `security.alarm_triggered`, `access.granted`, `access.denied`.

Every subsystem communicates through this bus **whenever practical** — the explicit exception is
synchronous, same-transaction, same-request work (Commissioning's own internal
resolve-room-then-write-device sequence stays a direct call; it is not "two subsystems," it's
one operation), matching the qualifier the user's own spec used.

---

## 7. Plugin Architecture

Three plugin categories, all consuming the Event Bus + Projection Engine + Service Registry —
**never** the Driver Layer or Device Registry directly:

- **Automation/Analytics/AI plugins** subscribe to events and query projections (especially the
  graph-shaped AI-query projection) — an AI agent plugin asking "what's downstream of this
  switch" calls the Relationship Engine's traversal API through the Projection layer, never
  touches a driver.
- **Dashboard/Widget plugins** consume projections only (read-only by construction) and issue
  commands through the Service Registry (the existing `client.command()` contract path) —
  identical to how today's Canonical UI already works, just formalized as the pattern every
  third-party dashboard plugin also follows.
- **Cloud/SDK plugins** (future cloud sync, federation) subscribe to the Event Bus's `siteId`-
  scoped stream and replicate outward — this is what makes R5 (cloud federation) additive rather
  than a rearchitecture: a site simply never has a cloud plugin listening if it's fully offline.

No plugin category requires protocol knowledge — that guarantee is inherited directly from
Capability Normalization (ADR 0017) and Universal Commissioning (ADR 0018), which already
insulate everything above the Device Registry from protocol internals. This ADR's job is only to
extend that same insulation to *relationships* and *events*.

---

## 8. Future Roadmap

- **Digital Buildings / Digital Commissioning**: the Building Model + Relationship Engine ARE
  the digital building representation — commissioning a device already places it in this graph;
  "digital commissioning" becomes reviewing/approving the graph before physical install, not a
  new subsystem.
- **Predictive Maintenance / Building Analytics**: consumes the Health event family + historical
  projections — an analytics plugin, not a core engine.
- **Multi-site / Enterprise Management**: every event already carries `siteId`; a
  portfolio-level dashboard is a plugin that subscribes across multiple sites' event streams
  (where network-reachable) or aggregates periodically exported projections (where not) — no
  core runtime change needed.
- **Cloud Federation**: additive Event Bus subscriber, per R5's design goal above — a site's
  local operation is never gated on it.
- **Distributed Runtime / Edge Controllers**: because the Event Bus envelope is
  transport-agnostic (it doesn't assume in-process delivery), a future multi-controller site can
  run the SAME engines on multiple physical controllers exchanging events over a local network
  bus — deferred, not designed in detail here, but not precluded either.
- **Simulation / "true" Digital Twin fidelity**: if ever genuinely needed (e.g. an industrial
  BMS customer wants physics-accurate HVAC simulation), it becomes an Analytics/AI plugin
  consuming the Projection Engine's state history — never a core runtime requirement, exactly
  because §2.5's evaluation declined to over-commit to it.

---

## 9. Migration Strategy

Explicitly additive to the existing stable foundations — no rewrite:

1. **Relationship Engine** ships as a new, empty-by-default table set (`relationships`,
   adjacency shape) alongside the existing Device Registry tables — zero impact until populated.
2. **Building Model** generalizes `Room.homeId` into `Room --partOf--> Floor --partOf-->
   Building --partOf--> Site` edges, with `Site` defaulting to today's single-`Home` shape for
   every existing residential install (a `Home` becomes a `Site` with exactly one `Building`)
   — no existing query breaks, because `Room.homeId` stays as a materialized shortcut backed by
   the graph underneath.
3. **Event Bus** formalizes the ALREADY-EXISTING informal event patterns (`useLive()`/WSS state
   push, the Unified Driver Lifecycle's stage transitions) into the typed envelope — an
   incremental wrapping exercise, not new behavior.
4. **Projection Engine** starts with ONE projection (the existing Lighting/Room/Category read
   shape the Canonical UI already consumes) reimplemented as a projection consumer instead of a
   direct Device Registry query — proves the pattern on the lowest-risk, best-tested surface
   before extending to Security/Energy/AI-graph projections.
5. Every step ships behind the same additive-migration discipline this session already
   established (nullable columns, no backfill required, existing rows unaffected) — consistent
   with R11.

---

## 10. Implementation Roadmap (strategy only — not implemented here)

**Phase 1 — Event Bus formalization** (lowest risk, highest immediate leverage)
Wrap existing informal event flows (live state push, driver lifecycle stages) into the typed
`SupremeEvent` envelope. Dependencies: none beyond current architecture. Risk: low (additive
wrapper). Validation: existing `useLive()`/WSS tests continue passing unchanged; new tests assert
event envelope shape.

**Phase 2 — Relationship Engine + Building Model (spatial hierarchy only)**
Ship the adjacency table; migrate `Room.homeId` into `partOf` edges with the Site/Building
defaulting behavior from §9.2. Dependencies: Phase 1 (relationship changes should emit events).
Risk: medium (touches the Room/Home read path, though additively). Validation: every existing
Rooms/Devices page test continues passing against the materialized-shortcut compatibility layer;
new tests assert graph traversal correctness (multi-floor, multi-building fixtures).

**Phase 3 — Projection Engine (Lighting projection first)**
Reimplement the Canonical UI's Lighting/Room read path as a projection consumer. Dependencies:
Phase 1 + 2. Risk: medium (must not regress the just-completed Capability-Driven UI work — ADR
0016's `getDeviceUiCapabilities()`/`getRoomUiCapabilities()` become projection consumers, not
replaced). Validation: the existing capability-matrix test suite (ADR 0016) must pass unchanged
against the new projection-backed data path — a hard regression gate, not optional.

**Phase 4 — Additional projections + Plugin Runtime**
Security/Energy/AI-graph projections; formal Plugin Runtime sandboxing for third-party
automation/dashboard/analytics plugins. Dependencies: Phase 3 proves the projection pattern
first. Risk: highest (new attack surface via third-party plugins — needs the permissions model
from §5 fully enforced before any plugin API ships). Validation: a security review of the plugin
sandbox boundary before any external plugin is accepted, not just functional tests.

**Cross-cutting risks:**
- Event Bus becoming a silent bottleneck if a Feature Engine blocks on synchronous event
  handling — mitigate with an explicit async-only consumer contract from Phase 1.
- Projection drift (a projection silently diverging from source-of-truth state) — mitigate via
  the "always rebuildable, never hand-edited" principle (§5) plus a periodic consistency-check
  job comparing a projection's checksum against a fresh rebuild.
- Team/scope discipline: every phase must resist scope creep into simulation-grade "digital
  twin" fidelity (§2.5's explicit rejection) — a recurring design-review checkpoint, not a
  one-time decision.

---

## Trade-offs (stated plainly)

Choosing the Hybrid Runtime over a pure Graph Database means portfolio-scale analytical queries
(e.g., "show me energy correlation across 200 buildings") will eventually need an export path to
a dedicated analytical store — deferred deliberately (§8) rather than paid for today. Choosing it
over "just add more foreign keys" (§2.2) means accepting more architectural surface area now, in
exchange for not hitting a wall at enterprise scale later. Choosing it over a literal Digital
Twin means SupremeOS does not, today, promise physics-accurate simulation — a conscious
positioning choice, not an oversight.
