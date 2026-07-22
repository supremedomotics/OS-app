# 0020 — Runtime Object & Projection Contract

## Status

**Proposed** — formalizes the contract layer sitting on top of the accepted architecture from
ADR 0016 (Capability-Driven UI), ADR 0017 (Capability Normalization), ADR 0018 (Universal
Commissioning), and ADR 0019 (Hybrid Runtime: Device Registry → Relationship Engine → Projection
Engine). Nothing here changes any of those four — this ADR defines the shape of the thing the
Projection Engine (§4 of ADR 0019) actually emits, and the rules every future consumer obeys when
reading it.

---

## 1. Runtime Object Specification

The **Runtime Object** is the one shape every subsystem above the Driver Layer ever sees. It is
deliberately NOT a mirror of the Device Registry row — the registry optimizes for correct,
normalized *writes* (one row, one set of capabilities, one room foreign key); the Runtime Object
optimizes for what a *consumer* — a dashboard, an AI agent, a voice assistant, a third-party
plugin — actually needs to act without ever touching a protocol or a raw table.

```ts
interface RuntimeObject {
  // ── Identity ──────────────────────────────────────────────────────────────
  id: RuntimeObjectId;          // stable, protocol-agnostic, never reused even after deletion
  kind: "device" | "space" | "scene" | "automation" | "zone" | "virtual" | string; // extensible
  version: number;               // monotonic per-object revision (§7 API stability, §5 events)

  // ── Classification ───────────────────────────────────────────────────────
  type: string;                  // Supreme device/entity type (e.g. "color_light", "thermostat") — NEVER a protocol name
  feature: string;                // the feature domain that owns its UI/automation surface (e.g. "lighting", "climate", "security")
  tags: string[];                 // installer- or AI-assigned free-form labels ("critical", "guest-visible", …) — never protocol-derived

  // ── Naming & presentation ────────────────────────────────────────────────
  name: string;
  icon: string;                    // canonical icon identifier (§ Aureon Icon.tsx PATHS convention) — never a protocol glyph

  // ── Capabilities & state (§ ADR 0016/0017, read-only here) ──────────────
  capabilities: RuntimeCapability[];  // structural — "what can this do" (ADR 0017's normalized shape, verbatim)
  state: Record<string, unknown>;      // current values only — "what is it doing right now"

  // ── Relationships (§4 below) ─────────────────────────────────────────────
  relationships: RuntimeRelationship[];

  // ── Health & availability ────────────────────────────────────────────────
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  availability: { online: boolean; lastSeen: string | null };

  // ── Provenance — visible ONLY to installer/diagnostic-tier consumers ─────
  origin: {
    driverKind: string;             // e.g. "casambi" — NEVER surfaced to homeowner-facing consumers (§9 guardrail)
    driverInstanceId: string;
    commissionedAt: string;
  };

  // ── Permissions ──────────────────────────────────────────────────────────
  permissions: { view: boolean; control: boolean; configure: boolean }; // resolved for the REQUESTING principal, never a raw ACL dump

  // ── Navigation ────────────────────────────────────────────────────────────
  links: { self: string; detail: string; parent?: string };  // canonical-router-resolvable references, never ad-hoc URLs

  // ── Actions ───────────────────────────────────────────────────────────────
  actions: RuntimeAction[];         // the SAME capability-gated action set ADR 0016's getDeviceUiCapabilities() derives — expressed as data here, not a UI-only concept

  // ── Diagnostics / statistics — optional, tier-gated ──────────────────────
  diagnostics?: { errorRate?: number; lastError?: string | null };
  statistics?: { uptimePercent?: number; commandCount24h?: number };

  // ── Metadata bag — installer-entered, capability-independent facts ──────
  metadata: Record<string, unknown>;   // e.g. HVAC brand/unit-type (§ CLAUDE.md's device.metadata.<domain>.kind pattern) — unchanged, just formalized as a field here
}

interface RuntimeCapability { kind: string; config: Record<string, unknown> } // = ADR 0017's DeviceCapability, unchanged shape
interface RuntimeRelationship { type: string; targetId: RuntimeObjectId; direction: "outgoing" | "incoming" }
interface RuntimeAction { id: string; label: string; available: boolean; reason?: string } // reason mirrors capabilityAvailability()'s three honest outcomes
```

**What was deliberately excluded** (and why): raw protocol payloads, driver internals, bus
addresses, DPTs, group addresses — none of it belongs above the Driver Layer, ever (this is the
literal enforcement mechanism for ADR 0017/0018's protocol-independence guarantee). `origin` is
the ONE field that even names a protocol, and it is explicitly gated to installer/diagnostic
tiers — a homeowner-facing, AI, or third-party plugin consumer never sees it (§9, §10).

---

## 2. Projection Contract

A **Projection** is a named, purpose-built read model — a query surface over one or more
Runtime Objects, shaped for exactly one consumer family's access pattern. Every Projection:

1. **Receives Runtime Events** (§3) as its only input besides an initial full rebuild query
   against the Device Registry + Relationship Engine.
2. **Owns no data** — a Projection's storage (if it has any, e.g. a materialized cache table) is
   a disposable cache, never a system of record. Deleting it and rebuilding from events + the
   Device Registry must always be possible and must always converge to the same result.
3. **Derives, never originates** — every field on every Runtime Object a Projection emits must be
   traceable to the Device Registry, the Relationship Engine, or a deterministic computation over
   them (e.g. `health` derived from recent `HealthChanged` events). A Projection inventing a fact
   with no upstream source is a contract violation.
4. **Is disposable and rebuildable** — a Projection crashing, being redeployed, or having a bug
   fixed and needing a full recompute must never cause data loss, because it never held the only
   copy of anything.
5. **Never becomes the source of truth** — even for its own specialized shape. If a Security
   Projection needs a fact no other consumer needs (e.g. "armed since" timestamp), that fact is
   still derived from an event stream the Device Registry or Relationship Engine authoritatively
   emitted — the Projection may be the only thing that COMPUTES it, but it is never the only
   thing that COULD reconstruct it.

### Named projections (illustrative, not exhaustive — new ones are additive)

| Projection | Consumer(s) | Shape emphasis |
|---|---|---|
| Lighting | Lighting page, Room→Lighting aggregate | `RuntimeObject[]` filtered to `feature: "lighting"`, capability-derived `showRGB`/`showCCT`/etc. (ADR 0016's flags, computed here once, consumed everywhere) |
| Climate | Climate console, schedules | adds setpoint/mode history windowing |
| Security | Alarm panel, access log | adds `armed`/`triggered` derived state, tighter permission gating |
| Media | Media tab, AVR console | adds now-playing/queue projection |
| Energy | Energy dashboard, tariff engine | adds time-series rollups, never raw meter ticks |
| Occupancy | Automation triggers, presence-based scenes | derived purely from sensor Runtime Objects + Relationship Engine's spatial edges |
| Environment | Climate/ventilation automation | temperature/humidity/air-quality aggregation per space |
| Maintenance | Predictive-maintenance plugins (ADR 0019 §8) | health/diagnostics history, firmware version drift |
| Installer | Extension Center, commissioning UI | the ONLY projection tier where `origin.driverKind` is visible |
| AI | AI agents, voice assistants | graph-traversal-shaped, includes full `relationships[]`, intent-oriented action list |
| Relationship | Digital building views, dependency analysis | pure graph shape — nodes + typed edges, minimal per-node payload |

---

## 3. Runtime Event Contract

Yes — **a single canonical event envelope is required**, extending ADR 0019 §6's
`SupremeEvent<T>` with the specific payload types every Projection must agree on:

```ts
type RuntimeEventType =
  | "device.added" | "device.removed"
  | "state.changed" | "capability.changed"
  | "relationship.changed"
  | "metadata.changed"
  | "health.changed"
  | "room.changed"              // a subtype of relationship.changed for the common spatial-reparent case
  | "firmware.updated"
  | "configuration.changed"
  | "permission.changed";

interface RuntimeEvent<T = unknown> extends SupremeEvent<T> {
  type: RuntimeEventType;
  objectId: RuntimeObjectId;      // the Runtime Object this event concerns — every Projection indexes on this
  objectVersion: number;           // matches RuntimeObject.version AFTER this event applies — lets a Projection detect a missed/out-of-order event
}
```

Every Projection subscribes to the full event stream and filters to the event types it cares
about — no Projection receives a bespoke, pre-filtered stream (that would silently create N
different event contracts instead of one). `objectVersion` is the mechanism a Projection uses to
detect it has fallen behind (a gap in version numbers) and must resync from the Device Registry
rather than silently serve stale data — this is the concrete, testable expression of "eventually
consistent by design" from ADR 0019 §5.

---

## 4. Relationship Contract

Runtime Objects participate in relationships through the SAME typed-edge shape ADR 0019's
Relationship Engine already defines — this ADR fixes the canonical vocabulary so every
Projection and every plugin agrees on relationship *meaning*, not just mechanism:

**Spatial (hierarchical, `partOf` edge family):** `Building → Floor → Zone → Room → Runtime
Object`. A Runtime Object's `feature` classification (lighting, climate, …) sits BELOW this
hierarchy, not beside it — `Runtime Object → Feature` is a classification, not a spatial edge.

**Functional (cross-cutting, non-hierarchical):**
- `controls` — a switch controls a light; an automation controls a scene.
- `consumesEnergyFrom` — a device's circuit/meter relationship, feeding the Energy Projection.
- `dependsOn` — automation-impact analysis: "what breaks if this is removed."
- `mirrors` — a virtual device (§ below) mirroring a physical one's state.
- `belongsTo` — ownership/grouping that isn't spatial (e.g. device belongs to a scene's action
  list).

**Structural (composition):**
- `parent` / `child` — generic hierarchy for cases that aren't spatial or functional (a
  multi-gang KNX device's individual channels as children of one physical unit, for instance).
- `virtual` — marks a Runtime Object as having no direct driver-backed device (a scene, a
  computed "average temperature of floor 2" object) — `origin.driverKind` is absent, not
  fabricated, for these.
- `derived` — a Runtime Object computed entirely from other Runtime Objects (an aggregate,
  matching ADR 0019's Building Model generalization).
- `composite` — a Runtime Object that IS several underlying devices presented as one (a
  multi-driver AVR zone, e.g.) — `relationships` lists every constituent; consumers never need
  to know it's a composite unless they specifically ask.

Every relationship type here is a label on a generic typed edge — no new storage mechanism, no
protocol dependency, consistent with ADR 0019's explicit rejection of a dedicated graph database
for the common case.

---

## 5. Projection Lifecycle

```
  Cold Start / Rebuild                    Steady State
 ┌─────────────────────┐        ┌────────────────────────────────┐
 │ 1. Query Device      │        │ 4. Consume RuntimeEvent stream  │
 │    Registry +        │        │    (filtered to relevant types) │
 │    Relationship       │        │                                  │
 │    Engine for full    │───────▶│ 5. Apply incremental update to   │
 │    current state      │        │    in-memory/cached read model   │
 │                       │        │                                  │
 │ 2. Derive initial     │        │ 6. Detect version gap → if found,│
 │    Runtime Objects    │        │    discard local state, GOTO 1   │
 │                       │        │                                  │
 │ 3. Mark projection    │        │ 7. Serve consumer queries from   │
 │    "ready"            │        │    current derived state          │
 └─────────────────────┘        └────────────────────────────────┘
                                              │
                                              ▼
                                  8. On deploy/crash/bug-fix: discard
                                     ALL local state, return to step 1.
                                     No data is ever lost, because none
                                     was ever owned here (§2 rule 2).
```

A Projection is "ready" only after step 3; consumers querying an unready Projection get an
explicit "not ready" response — never partial or fabricated data (consistent with the project's
existing "never fabricate" rule, extended here to the runtime layer).

---

## 6. Write Once, Project Everywhere — Formal Statement

**Rule:** the Device Registry (via Universal Commissioning, ADR 0018) is the only permitted
writer of device identity, capability, and room-assignment facts. The Relationship Engine is the
only permitted writer of relationship edges. No other subsystem — no Projection, no Feature
Engine, no plugin — ever writes to either.

**Why duplicate ownership is forbidden:** two writers of the same fact is exactly the class of
bug this entire session's work eliminated at the commissioning layer (ADR 0018 found and closed
three independent "commission a device" implementations that could drift). Allowing Projections
to also persist state reintroduces that exact failure mode one layer up — a Lighting Projection
that caches a device's room assignment and a Security Projection that caches its own copy WILL
eventually disagree after a room move, and nothing in the architecture would catch it.

**Why every subsystem should project rather than persist:** a Projection with no persisted
opinion of its own is trivially safe to delete, redeploy, or roll back — it cannot lose data it
never owned, and it cannot serve inconsistent data once rebuilt, because rebuilding always
re-derives from the same single upstream truth. This is what makes it safe to ship a new
Projection (AI, Occupancy, Maintenance) without a data-migration plan — there is nothing to
migrate, only a rebuild to run once.

**Why this scales:** adding the 50th consumer (a new SDK, a new plugin category, a new protocol
a decade from now) costs exactly one new Projection or one new consumer of an existing
Projection — never a new write path, never a new migration, never a new place a bug could
introduce data drift. The cost of a new consumer is O(1) regardless of how large the existing
system has grown, which is the specific scaling property ADR 0019's Hybrid Runtime was chosen to
provide.

---

## 7. API Stability Guidelines

The Runtime Object (§1) is the permanent public contract — REST, GraphQL, the SDK, the
Automation Engine, the Scene Engine, Voice, and every AI agent consume it, never Device Registry
internals or a protocol-specific shape.

- **Additive evolution only**: new fields on `RuntimeObject`, new `RuntimeEventType` values, new
  relationship-type strings, and new Projections are always backward-compatible additions — this
  mirrors the exact discipline `supreme-contracts`' zod schemas already enforce for the REST/SDK
  layer (optional fields, `.default()`, never a required-field addition).
- **`version` is the compatibility signal**: a consumer pinned to an older Runtime Object shape
  can detect drift via `version` and request a specific schema revision, the same way
  `supreme-contracts` already versions wire types.
- **No consumer-specific escape hatches**: if the AI Projection needs a field no other consumer
  has, it goes on the canonical `RuntimeObject` (possibly as an optional field), never as a
  parallel "AI-only object shape" — one canonical object, many Projections filtering/shaping it,
  never many objects.
- **Deprecation, not deletion**: a field that becomes obsolete is marked deprecated and kept
  populated (even if derived from a fallback) for a defined support window — matching this
  project's existing "backward compatibility by default" rule (CLAUDE.md).

---

## 8. Architectural Guardrails

Non-negotiable rules for every future contributor and every future plugin:

1. **Never bypass Capability Normalization** (ADR 0017) — a Runtime Object's `capabilities` field
   is always populated via the normalized shape; no consumer ever reads a raw protocol capability
   string.
2. **Never bypass Universal Commissioning** (ADR 0018) — no code path outside Commissioning ever
   creates a Device Registry row.
3. **Never mutate Runtime Objects** — every `RuntimeObject` a consumer receives is immutable data;
   a "write" is always a command issued through the Service Registry, never a direct field
   mutation on a returned object.
4. **Never persist Projection state as a system of record** — caches are permitted; sources of
   truth are not (§2, §6).
5. **Never duplicate ownership** — exactly one writer per fact, always (§6).
6. **Never expose protocol-specific objects outside the Driver Layer** — `origin.driverKind` is
   the one narrow, tier-gated exception (§1); nothing else protocol-shaped crosses the boundary.
7. **Never couple a consumer to Device Registry internals** — every consumer, including
   first-party UI, goes through a Projection; direct Device Registry queries are permitted ONLY
   inside Commissioning and the Projection Engine's own rebuild path (§5 step 1).
8. **Never fabricate a Runtime Object field** — every value must trace to an upstream fact or a
   deterministic derivation (§2 rule 3); this extends the project's existing "never fabricate
   capabilities" rule to the entire runtime layer, not just the UI.
9. **Never let a plugin see a tier it isn't permissioned for** — `origin`, `diagnostics`, and
   `statistics` are gated per §1; a third-party dashboard plugin's Projection view omits them by
   default.
10. **Never introduce a second event envelope** — every subsystem, first-party or plugin, speaks
    `RuntimeEvent` (§3); a bespoke internal event shape that never crosses the Event Bus is
    permitted only strictly inside one subsystem's own implementation detail, never as an
    inter-subsystem contract.

---

## 9. Plugin Contract

Every plugin category from ADR 0019 §7 (Dashboard, Automation, Analytics, Energy, Cloud, AI,
Voice, SDK Extension) receives Runtime Objects and Runtime Events exclusively:

```ts
interface SupremePlugin {
  id: string;
  onRuntimeEvent?(event: RuntimeEvent): void;         // subscribe to the SAME event stream every Projection consumes
  queryProjection?(name: string, filter?: unknown): Promise<RuntimeObject[]>;  // read-only
  issueCommand?(objectId: RuntimeObjectId, action: string, params?: unknown): Promise<void>; // through Service Registry, never direct
}
```

A plugin manifest declares which Projections it needs (`"lighting"`, `"ai"`, …) and at which
permission tier — the plugin runtime resolves this at load time and hands back a scoped view; a
plugin never receives a capability to query the Device Registry, Relationship Engine, or a
driver directly. This is the enforcement mechanism for the Final Requirement: a plugin author
building a new automation or analytics capability a decade from now never needs to know DALI or
BACnet exists.

---

## 10. Future Extension Strategy

- **New protocol, ten years from now**: ships a driver + a Capability Normalization mapping
  (ADR 0017) + uses Universal Commissioning (ADR 0018) unmodified — the Runtime Object contract
  in this ADR requires zero changes, because it was never protocol-aware to begin with.
- **New consumer category** (a hologram interface, a new AI modality, whatever): consumes an
  existing Projection or requests a new one — never touches anything below the Projection Engine.
- **New relationship type**: an additive label on the existing typed-edge mechanism (§4) — no
  schema migration, consistent with ADR 0019's adjacency-table design.
- **New Runtime Object field**: additive per §7 — old consumers ignore fields they don't know
  about (standard JSON-forward-compatibility discipline), new consumers opt in.

This ADR's success criterion, ten years out: a new contributor can ship an entirely new
capability (automation rule type, analytics dashboard, AI reasoning mode) having read only this
document and the Runtime Object shape — never a protocol spec, never a driver implementation,
never a Device Registry schema.
