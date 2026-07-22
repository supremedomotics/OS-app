# 0021 — Architectural Governance & Evolution Policy

## Status

**Proposed** — the constitutional document for all SupremeOS development following ADR 0016
(Capability-Driven UI), ADR 0017 (Capability Normalization), ADR 0018 (Universal Commissioning),
ADR 0019 (Hybrid Runtime), and ADR 0020 (Runtime Object & Projection Contract). This ADR
introduces no new layer, no new runtime concept, and redesigns nothing — it defines how the five
accepted ADRs stay true over ten years of contributions from engineers, AI agents, plugin
authors, and enterprise customization.

---

## 1. Architectural Governance Policy

The accepted architecture is:

```
Driver Layer → Capability Normalization → Universal Commissioning → Device Registry
   → Relationship Engine → Projection Engine → Runtime Objects → Event Bus → Consumers
```

**Governing statement:** every layer above has exactly one job and exactly one authoritative
owner (§3). A feature request is a request to extend a layer's data or add a new consumer — it
is never license to add a second implementation of a layer that already exists. This document is
the standing test every change is measured against, not a one-time checklist filed away after
launch.

**Enforcement mechanism:** this policy has no teeth without a gate. The Architectural Review
Checklist (§2) is that gate — any change that answers YES to any of its questions requires
explicit review before merge, regardless of who or what authored it (human, AI agent, or plugin
submission).

---

## 2. Architectural Review Checklist

Mandatory for every significant change — "significant" means anything that adds a new data
shape, a new persistence location, a new cross-subsystem call path, or a new public contract.

| # | Question | If YES |
|---|---|---|
| 1 | Does this introduce another source of truth for a fact the Device Registry, Relationship Engine, or Projection Engine already owns? | **Requires review** — almost certainly forbidden (§ Principle 2). |
| 2 | Does this bypass Capability Normalization (ADR 0017) — i.e., does any code above the Driver Layer read a raw protocol capability string? | **Requires review** — forbidden without exception. |
| 3 | Does this bypass Universal Commissioning (ADR 0018) — does anything outside Commissioning write a Device Registry row? | **Requires review** — forbidden without exception. |
| 4 | Does this bypass Runtime Objects (ADR 0020) — does a consumer read a Projection's internals or the Device Registry directly instead of a `RuntimeObject`? | **Requires review** — permitted ONLY inside Commissioning and a Projection's own rebuild path. |
| 5 | Does this expose a protocol-specific object (a KNX group address, a Casambi unit id, a Matter cluster) outside the Driver Layer? | **Requires review** — the one narrow exception is `RuntimeObject.origin.driverKind`, tier-gated (ADR 0020 §1). |
| 6 | Does this duplicate ownership of a fact across two subsystems? | **Requires review** — forbidden (§ Principle 2). |
| 7 | Does this persist Projection state as anything other than a disposable, rebuildable cache? | **Requires review** — forbidden (ADR 0020 §2 rule 2). |
| 8 | Does this bypass the Event Bus for a cross-subsystem notification without a stated, reviewed justification (same-transaction synchronous work is the only accepted justification — ADR 0019 §6)? | **Requires review.** |
| 9 | Does this create protocol-specific UI (a control, a page, a widget that only makes sense for one protocol)? | **Requires review** — violates ADR 0016's capability-driven rule. |
| 10 | Does this leak driver internals (a config shape, an error type, a connection object) into a Runtime Object, a Projection, or a plugin-facing API? | **Requires review.** |

A reviewer answering any question YES does not automatically reject the change — it means the
change must be justified in writing against this document (as ADR 0018 did for
`approveKnxDevice()`'s deliberately-local rollback loop) and recorded, not silently merged.

---

## 3. Ownership Matrix

| Fact | Sole authoritative owner | Everyone else's access |
|---|---|---|
| Device identity, capabilities, room assignment | Device Registry (written only via Universal Commissioning) | Read-only, via Runtime Objects |
| Structural capability metadata (RGB/CCT, kelvin range, …) | Capability Normalization (per-driver codec) | Read-only, surfaced inside `RuntimeCapability.config` |
| Relationships/edges (spatial, functional, structural) | Relationship Engine | Read-only, via `RuntimeObject.relationships` |
| Derived read shapes (Lighting, Security, AI, …) | The owning Projection, for that shape ONLY | Consumers query, never write; no other Projection reaches into another's cache |
| Live/current state values | Driver → Event Bus → Projection's derived cache | Read-only, via `RuntimeObject.state` |
| Automation/scene definitions | Scheduler (a Feature Engine, ADR 0019) | Read-only elsewhere; execution emits events, doesn't mutate the registry directly |
| Permissions/ACLs | Identity/permissions service (existing `enforce()` pattern) | Resolved per-request into `RuntimeObject.permissions` — never a raw ACL exposed to consumers |
| Plugin-declared config | The plugin's own sandboxed storage | Never the Device Registry, never a Projection's cache |

**Rule of the matrix:** if a fact doesn't have a row here, it doesn't have an owner yet — adding
a new persistent fact type requires adding a row to this table as part of the same change, not
after the fact.

---

## 4. Evolution Policy

Every category of future work maps to exactly one extension point — never a new layer:

| New requirement | Correct extension | Forbidden shortcut |
|---|---|---|
| New protocol (Matter, DALI, BACnet, RTI, one not yet invented) | New Driver + Capability Mapping (ADR 0017), consumed by the EXISTING Universal Commissioning | A new/parallel commissioning path; a new runtime |
| New dashboard/visualization | New Projection (ADR 0020 §2), or a new consumer of an existing one | A new persistence model; a bespoke query path around the Projection Engine |
| New automation capability | Consumes Runtime Objects + Runtime Events | Direct driver API access; a protocol-aware automation node |
| New relationship type | An additive label on the existing typed-edge mechanism (ADR 0020 §4) | A new relationship storage engine |
| New Runtime Object field | Additive, optional field on the canonical shape (ADR 0020 §7) | A parallel, consumer-specific object shape |
| New plugin category | Consumes Runtime Objects/Events under the existing Plugin Contract (ADR 0020 §9) | A plugin given driver or Device Registry access |
| Enterprise/commercial feature (multi-site, hospitality, industrial) | Composed from existing Building Model + Relationship Engine + Projections (ADR 0019 §8) | A separate "enterprise edition" data model |

**The test for any proposed change:** state which row of this table it belongs to. If it belongs
to no row, it is either a genuinely new extension-point CATEGORY (rare, requires this ADR to be
amended — see §10) or it is proposing a parallel architecture (forbidden).

---

## 5. Compatibility Policy

Applies to every public contract: Runtime Objects, Runtime Events, the SDK, REST API, GraphQL,
and Plugin Interfaces.

- **Additive-by-default**: new optional fields, new enum values, new event types, new relationship
  types are always non-breaking and require no special process (this is already
  `supreme-contracts`' zod-schema convention — this policy makes it universal, not just a REST
  convention).
- **`version` fields are mandatory** on `RuntimeObject` and `RuntimeEvent` (ADR 0020 §1, §3) —
  every consumer capable of pinning to a schema revision must be able to detect drift.
- **Breaking changes require all four, before merge, not after:**
  1. **Migration strategy** — how existing data/consumers move to the new shape.
  2. **Compatibility layer** — old consumers keep working during the deprecation window (a
     materialized-shortcut field, a translation shim — matching ADR 0019 §9's `Room.homeId`
     precedent).
  3. **Versioning policy** — which major/minor version introduces the break, stated explicitly.
  4. **Deprecation timeline** — a stated, published window (minimum: one full minor release
     cycle) before the old shape is removed, never silently.
- **No silent breaking changes, ever** — including from AI-generated code (§7) and plugin
  submissions (§6). A PR that breaks a public contract without all four items above fails review
  automatically, regardless of author.

---

## 6. Plugin Governance

Plugins (ADR 0020 §9) are architecturally isolated by construction, not by convention alone:

- Consume `RuntimeObject`/`RuntimeEvent` exclusively — enforced by the plugin runtime's own
  scoped handle (a plugin is never handed a reference capable of reaching the Device Registry,
  Relationship Engine, or a driver).
- Declare required Projections and permission tier in a manifest, resolved at load time — a
  plugin cannot request access it didn't declare, and an installer/admin can audit exactly what
  every installed plugin can see before enabling it.
- Never mutate the Device Registry directly — a plugin's only write path is `issueCommand()`
  through the Service Registry (ADR 0020 §9), which itself routes through the same permission and
  Universal Commissioning-adjacent checks any first-party consumer goes through.
- Never bypass architectural layers "just this once" — a plugin requesting driver-level access is
  a signal the Driver Layer or a Projection is missing a capability it should have, and the fix
  is extending that layer (§4), never granting the exception.
- A misbehaving plugin (attempting an out-of-scope query, exceeding its declared permission tier)
  is a containment/observability event, not a silent failure — surfaced through the same Event
  Bus as everything else (`permission.changed`-adjacent audit events).

---

## 7. AI Contribution Guidelines

AI-generated code — whether from an autonomous agent, a coding assistant, or an AI-authored
plugin — follows every rule in this document with zero exception. Specific guidance, because AI
contributors are prone to specific failure modes human reviewers should watch for:

- **Never create a new source of truth "to make this feature easier."** An AI agent under
  deadline pressure to ship a feature will often reach for a new table/cache/local variable that
  duplicates an existing fact rather than tracing back to the correct owner (§3). This is
  EXACTLY the failure this whole ADR series was written to prevent (see ADR 0018's real,
  discovered three-way commissioning duplication — a human wrote that, and an AI would make the
  same mistake faster and at higher volume without this guidance).
- **Never bypass Runtime Objects "to save a hop."** Reaching directly into the Device Registry or
  a Projection's internals because it's fewer lines of code is a Principle-2 violation regardless
  of how small the shortcut looks.
- **Never duplicate ownership by "caching for performance" without checking the Ownership
  Matrix (§3) first.** A cache is fine; a cache that becomes the only place a fact lives is not.
- **Never expose a protocol-specific model reflexively when a task mentions a specific protocol
  by name.** A task like "add DALI support" means: write a driver + capability mapping (§4's
  first row) — it does not license a DALI-specific object anywhere above the Driver Layer.
- **Always search for an existing extension point before introducing a new abstraction** — this
  mirrors the codebase's own long-standing "Reuse over rebuild" / "Extend, don't fork" rules
  (CLAUDE.md), now explicitly extended to architectural layers, not just component reuse.
  Concretely: before adding a new table, a new engine, or a new top-level concept, an AI
  contributor must check §4's Evolution Policy table and the Ownership Matrix (§3) and cite which
  row the change extends.
- **Treat the Architectural Review Checklist (§2) as a mandatory self-check**, run and stated
  explicitly (not silently assumed clean) before proposing any change that touches a fact with an
  owner in §3.

---

## 8. Extension Policy

Restates §4 as a direct lookup for "where does X belong":

- **New protocol support** → Drivers + Capability Mappings.
- **New way to derive/read data** → Projections.
- **New fact type that needs to flow between subsystems** → a new, additive Runtime Event type.
- **New way two entities relate** → Relationships (additive edge type).
- **New first-party UI surface** → Widgets/Dashboard Components consuming existing Projections.
- **New automation capability** → Automation Nodes consuming Runtime Objects/Events.
- **New third-party integration** → SDK Extensions / Plugins.
- **New cloud capability (federation, backup, remote access)** → Cloud Services, additive Event
  Bus subscriber (ADR 0019 §7), never a required dependency for local operation.

**No feature, regardless of size or commercial pressure, creates a parallel architecture.** If a
feature genuinely cannot be expressed through this list, that is itself the signal for an ADR
amendment (§10), not a workaround.

---

## 9. Architectural Fitness Metrics

Measurable, not aspirational — each maps to a concrete, checkable property:

| Attribute | How it's measured |
|---|---|
| **Single ownership** | Every fact has exactly one row in the Ownership Matrix (§3) with exactly one writer; a code-search audit (as performed for ADR 0018) for a second writer of any owned fact returns zero results. |
| **Loose coupling** | No Feature Engine calls another Feature Engine directly for cross-domain notification — all cross-domain communication is Event Bus traffic, auditable by grepping for direct feature-to-feature imports. |
| **High cohesion** | Each Projection's derived fields all trace to the SAME consumer family's actual needs (ADR 0020 §2) — a Projection accumulating fields no consumer of its name actually reads is a cohesion violation. |
| **Protocol independence** | Zero occurrences of a protocol name (`knx`, `casambi`, `matter`, …) above the Driver Layer, except the single tier-gated `origin.driverKind` field — grep-auditable, exactly as this session's capability-visibility audits already were. |
| **Deterministic runtime** | A Projection rebuilt from the same Device Registry + Relationship Engine + event history always produces byte-identical Runtime Objects (ADR 0020 §5) — testable directly. |
| **Offline-first** | Every core layer (Driver → Commissioning → Registry → Relationship → Projection → Runtime Object) functions with zero cloud reachability; only Cloud Services plugins require it. |
| **Event-driven** | Cross-subsystem notification volume flowing through the Event Bus vs. direct calls — direct calls should only appear for same-transaction, synchronous work (§2 question 8). |
| **Composable** | A new consumer can be added by writing only a Projection consumer or plugin, with zero changes to any existing layer — verified by the "new feature" acceptance test: can it be built without touching Commissioning, the Registry, or the Relationship Engine's core code? |
| **Testable** | Every layer ships fast, in-process tests with no live external dependency (matching this session's own precedent — Pglite-backed e2e tests, no real Postgres/broker/graph-DB required to test). |
| **Observable** | Every state-owning layer emits Runtime Events for its own changes — a layer with no corresponding event type in ADR 0020 §3 is an observability gap. |
| **Extensible** | Every entry in §4's Evolution Policy table has a real, exercised example in the codebase (Driver+Mapping: Casambi/KNX; Projection: Lighting; Relationship: `partOf`) proving the extension point actually works, not just documented in theory. |

These are the metrics a periodic (recommended: per-major-release) architectural fitness review
checks against — not one-time launch criteria.

---

## 10. Long-Term Evolution

The architecture absorbs each of the following WITHOUT a rewrite, because each maps to an
existing, already-designed extension point:

- **New protocols** — Drivers + Capability Mappings (§4), unlimited, additive.
- **Cloud federation** — additive Event Bus subscriber scoped by `siteId` (ADR 0019 §5, §8);
  never a required dependency.
- **Distributed controllers / edge scale-out** — the `RuntimeEvent` envelope is transport-agnostic
  by design (ADR 0019 §8) — multiple physical controllers exchanging events is a deployment
  topology change, not an architecture change.
- **AI orchestration** — the AI Projection (ADR 0020 §2) and the Plugin Contract (§6) already
  give an AI agent a complete, protocol-independent view; deeper AI orchestration (multi-agent
  coordination, planning) is additional plugin logic consuming the same contract, not a new
  layer.
- **Multi-site / enterprise management** — the Building Model's `Site → Building → Floor → Zone
  → Room` hierarchy (ADR 0019 §4, ADR 0020 §4) already generalizes to portfolios; a
  portfolio-level view is a Projection spanning multiple sites' event streams.
- **Digital building services** (predictive maintenance, analytics, digital commissioning) — each
  is a Projection + plugin combination already named explicitly in ADR 0019 §8 and ADR 0020 §2.
- **Future runtime technologies** (a new database engine, a new message bus implementation) — as
  long as the new technology can still emit/consume `RuntimeEvent` and serve `RuntimeObject`
  reads, it is an implementation swap BEHIND an existing layer's contract, invisible to every
  layer above it. This is the entire point of §7's Runtime Object being the permanent public
  language: the layers below it are free to evolve exactly because the contract above them
  doesn't have to.

**If a genuinely new architectural layer or concept becomes necessary** (not anticipated, but not
precluded): it requires a new ADR, explicit review against every principle in this document, and
an explicit statement of which existing layer's responsibility is being split or extended — never
a silent addition. This is the one deliberate escape hatch in an otherwise closed system, and
using it is itself governed by this document.
