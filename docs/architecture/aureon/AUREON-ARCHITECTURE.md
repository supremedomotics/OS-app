# Aureon Architecture & Engineering Specification

Status: **Design review — no implementation yet.** This document is the required first
deliverable before any Aureon code is written (per task brief). It is evidence-based: every
claim about existing SupremeOS behavior below was verified against the actual repository, not
inferred from docs or filenames. Absence is stated explicitly wherever something was searched
for and not found.

---

## 0. Correction to the task framing

The brief instructs treating "existing AI/LLM-related code, if any" as an open question and
frames Aureon as if built from zero. That premise is false and must not drive the design:

**A working, non-trivial AI assistant already exists** — `services/ai` (Node) +
`services/ai-py` (Python/FastAPI, `llama-cpp-python`, on-box GGUF model) — exposed at
`POST /v1/ai/assistant` (`services/gateway/src/routes/phase3.ts`). It already implements the
core safety principle this brief asks for ("LLM proposes, SupremeOS decides"):

- `AssistantService` (`services/ai/src/index.ts`) delegates to the Python LLM sidecar when
  configured, with a deterministic rule-based fallback (`planner.ts`) that is always available.
- The Python side (`services/ai-py/app/llm.py`) constrains decoding to JSON and **rejects** any
  model output referencing a device id that doesn't exist or isn't plausibly named in the
  utterance (`_valid()`), before ever returning it.
- Output is a draft only (`AssistantResult.kind ∈ {actions, scene, automation, answer}`) — never
  auto-executed; the gateway route requires the caller to confirm.
- Documented design intent: `docs/architecture/adr/0006-native-migration-and-local-llm.md` —
  local-only, no cloud, no API keys, model weights never committed, LLM augments but never
  replaces the deterministic planner.
- `services/intent-engine` (a separate, non-NL "Universal Intent & Capability Engine",
  ADR-0017) resolves named intents (`toggleLight`) to capability commands — this is the target
  the AI planner's `intent` automation-action already points at.

**Consequence for this design:** Aureon is **not a new system bolted next to SupremeOS**. It is
the next major version of `services/ai` / `services/ai-py`, built by extending this existing
planner/validator/fallback pattern into a full reasoning stack (context, memory, planning,
verification, conversation). Per CLAUDE.md ("extend, don't fork" / "reuse over rebuild"), a
parallel `services/aureon` that duplicates NL→intent parsing would be the wrong call unless a
specific, stated reason requires a clean break. This document treats `services/ai*` as the seed
Aureon grows from, keeping the file layout mostly stable and adding new modules alongside it.

---

## 1. CURRENT SUPREMEOS ARCHITECTURE (verified)

### 1.1 Device model
- `packages/domain-model/src/entities.ts` — `Device { id, homeId, roomId, name, supremeType,
  manufacturer, model, driverId, status, capabilities: DeviceCapability[],
  state: Record<CapabilityKind, CapabilityState>, metadata }`.
- `SupremeDeviceType`: light, dimmer, color_light, thermostat, cover, media_player, lock,
  switch, fan, vacuum, sensor, camera, keypad.
- `DeviceStatus`: online | offline | unavailable.
- IDs (`packages/domain-model/src/ids.ts`): prefixed ULIDs (`dev_...`), monotonic within a
  millisecond — load-bearing for ordering.

### 1.2 Capability vocabulary — closed, 10 members (`packages/domain-model/src/capabilities.ts`)
`onoff, brightness, color, temperature, position, media, lock, fan, vacuum, sensor`. Each has a
paired State/Command schema. `sensor` is read-only, enforced at the SIL boundary. **This is a
hard constraint on Aureon**: it must reason and act only in terms of these 10 kinds — it may
never invent an 11th to make a use case "work," matching CLAUDE.md verbatim.

### 1.3 Driver architecture
No shared base class (deliberate — 22 working drivers, not worth a forced rewrite). Two real
seams instead:
- `INativeProtocolDriver` (`services/integration-layer/src/protocols/driver.ts`) — the uniform
  interface every protocol driver implements: `connect/disconnect/isConnected/bind/manages/
  command/getState/discover/onState`, plus opt-in extras (diagnostics, artwork, AVR inputs,
  keypad framework, raw devMode escape hatch).
- `DriverLifecycleController` (`.../lifecycle.ts`) — a *composed* per-binding 18-state lifecycle
  tracker (created→…→operational→…→destroyed), forward-only with recoverable exceptions.
- Real protocols today: KNX, Casambi (Cloud + Local UDP), CoolMaster HVAC, MQTT, Modbus,
  Zigbee/Matter, HEOS, Yamaha, generic AVR, HomeKit/Matter-bridge, RTI, DALI, DMX, BACnet,
  Lutron. **No Android TV integration exists** — do not assume one.

### 1.4 Device identity across independent networks
Real, solved problem (`services/gateway/src/native-driver-factory.ts`). Wraps a driver in a
`Proxy`; the first/primary installed instance stays unwrapped (`casambi:45`), every additional
instance gets its installed-driver id folded into the address (`casambi:<installedId>:45`).
Only `discover()`/`bind()` are intercepted — `command()`/`getState()` key off Supreme `deviceId`
already. Verified by a real two-network e2e test. **Aureon must never re-derive device identity
itself** — always resolve through SIL/device-id, never through a raw protocol address.

### 1.5 Discovery & binding
`SupremeIntegrationLayer.discoverWithStatus()` → per-driver, failure-isolated discovery →
`InstallerServices.commissionDevice()` (`services/gateway/src/installer-context.ts`): resolves
room → applies installer kind override → creates the `Device` row → binds each capability via
`DriverBindingEngine` (the *only* code path allowed to call driver `bind()/unbind()`) → persists
`ProtocolBinding` only after the live bind succeeds. Device lifecycle state machine
(`DeviceLifecycleState`: DISCOVERED→REGISTERED→BOUND→ONLINE→OFFLINE→ERROR→REMOVED) gates
commandability (`ProviderRouter.assertCommandable()`).

### 1.6 State / event bus
`@supreme/messaging` (`services/messaging/src/event-bus.ts`) — `IEventBus`, `InProcessEventBus`
+ a real NATS-backed implementation for multi-process. Canonical subjects:
`supreme.home.<id>.device.state|notification|keypad.input|driver.state`. SIL republishes every
backend state change onto the bus; WSS (`services/gateway/src/stream.ts`) is the client-facing
consumer, permission-checked per frame, with **per-connection monotonic sequence numbers** for
staleness detection. **No cross-provider "state arbitration"/"revision" engine exists** — don't
assume one; build on the lifecycle state machine + WSS sequencing instead.

### 1.7 Command execution
No hub-wide command queue. `OfflineCommandQueue<TSubject,TCommand>`
(`services/protocols/src/knx/offline-command-queue.ts`) exists but is only instantiated by the
KNX driver today (MERGE/EXPIRE/EXECUTE/CANCEL semantics, 5-min conservative TTL).

### 1.8 Automation engine
`services/automations/src/engine.ts` + `packages/domain-model/src/automations-dsl.ts`. Typed
DSL: `triggers` (device_state | time | interval | keypad_input), `conditions` (device_state |
time_window), `actions` (device_command | scene_activate | notify | delay | **intent** — routes
through the intent engine). Execution: evaluate conditions → run actions in order, stop on first
failure → record into a 100-entry in-memory run-history ring buffer (`AutomationRun`) — this
*is* the automation debugger and the closest thing to a timeline for automations. Supports
`dryRun()` and `runConcurrent()` (used by scenes). `aiGenerated: boolean` field already exists
on `Automation` — **Aureon-authored automations are already representable, no schema change
needed.**

### 1.9 Scenes
`services/scenes/src/scene-service.ts` — explicitly documented as "Supreme-owned specialized
Automations," not a second engine: `activate()` compiles steps into a synthetic `Automation`
(`scene:<id>`) and runs it through the *same* `AutomationEngine.runConcurrent()`. `SceneStep =
{deviceId, capability, values}`. Import provenance fields (`sourceDriverId`, `syncStatus`)
already support scenes discovered from external systems (e.g. KNX ETS) — reusable pattern for
representing "this scene/automation was proposed/owned by Aureon."

### 1.10 Rooms / zones
`Room { id, homeId, name, building, floor: number, area, areaType, parentRoomId, ... }` — a
genuine Building›Floor›Room›Area hierarchy via free-text `building`/`area` + numeric `floor` +
self-referencing `parentRoomId`. **No separate persisted "Zone" entity** — `services/
intelligence/src/zones.ts` defines a computed, config-level zone concept for presence/occupancy
grouping only, not a topology table. `Device.roomId` is the sole device→room link.

### 1.11 Users & permissions
`UserType`: master, admin, homeowner, family, child, guest (time-boundable via `expiresAt`),
staff, installer, service_engineer, developer — already a superset of the brief's requested
role list. RBAC baseline (`services/permissions/src/roles.ts`) over
`ResourceType × Action`, overlaid with ABAC `Grant`s (allow/deny, validity window, weekly
schedule). `PolicyEngine.decide()`: explicit deny → explicit allow → RBAC fallback. **Aureon
must call this same `PolicyEngine`, never re-implement permission logic.**

### 1.12 Persistence
One shared Postgres per plane (hub-local vs. cloud), `PgDb`/`PgliteDb` behind a common `SqlDb`
interface, flat numbered migrations (`services/persistence/migrations/0001..0028`), one
repository file per bounded domain. Aureon's new tables (memory, transactions, conversations)
belong in this same migration sequence, new repositories alongside the existing ones — not a
separate database.

### 1.13 APIs
`packages/supreme-contracts` is the sole wire-shape source of truth; the gateway
(`services/gateway/src/routes/*.ts`, 18 files) is the only client-facing surface — domain
services are never called directly by clients. `phase3.ts` already defines `AiAssistRequest`
and hosts `/v1/ai/assistant`. New Aureon endpoints extend this same file/pattern.

### 1.14 Notifications, audit, scheduling, energy, security — confirmed real
- Notifications: `services/notifications` — real pub-sub + push, `notify` is a first-class
  automation action.
- Audit: `services/audit` — hash-chained, tamper-evident `audit_log`, `/v1/audit(/verify)`.
  This is a compliance log, **not** a general activity timeline.
- Scheduling: no standalone cron service — `time`/`interval` triggers inside the automation
  engine's own `tick()`, reused by circadian/solar/climate-program wrappers.
- Energy: `services/intelligence/src/energy/` (decision engine, REST surface at
  `/v1/energy/*`) — capability/config-driven, no dedicated time-series store found (worth a
  follow-up look at `services/analytics` before Aureon builds energy trend reasoning).
- Security: `SecurityService` — small explicit arm state machine (disarmed/armed_home/
  armed_away/armed_night + triggered), PIN-hashed, persisted, wired to audit+notifications.
  Locks are ordinary capability-driven devices (`lock` capability), not a separate entity.

### 1.15 Confirmed gaps (do not assume these exist)
- No unified cross-domain "home activity timeline" (only the audit log + automation run history).
- No general state-arbitration/conflict-resolution engine across providers.
- No hub-wide command queue.
- No Android TV driver.
- No chat/conversational UI component anywhere in `apps/web-homeowner` or `packages/aureon-web`.
- No cloud LLM integration anywhere in the repo (by design — local-first, ADR-0006).
- No persisted Building/Floor entity — floor is a bare int on Room.

### 1.16 UI architecture
`apps/web-homeowner/src/features/<domain>/` (media, security, infrastructure so far; climate
and generic device sheets still at `src/` root, mid-migration) — pattern is
`capability-mapper.ts` (classify device → UI kind from real capabilities/metadata, never
protocol) → `card.tsx` (Standard Card) → `simple-detail.tsx` / `detail.tsx` (Expanded Sheet /
Premium Detail Page). Shared primitives in `packages/aureon-web` (`Card`, `Button`, `Sheet`,
`CapabilityGate`, `CapabilityGrid`, `Timeline`, `Icon`, density engine via `useAureonDensity()`,
tokens in `aureon.tokens.json`). `capabilityAvailability()` (`features/_shared/
capability-availability.ts`) returns exactly 3 honest outcomes (available / "Not supported by
current driver" / "Driver required") — **Aureon's UI must reuse this gating pattern for any
control it surfaces**, never invent a 4th state. Diagnostics: generic `DriverDiagnosticsTracker`
+ `DiagnosticsSection` (devMode-only), with deeper Casambi UDP telemetry.

---

## 2. AUREON ARCHITECTURE

### 2.1 Placement in the existing system

```
                         ┌─────────────────────────────┐
                         │   apps/web-homeowner          │
                         │   features/aureon/ (NEW)       │
                         │   - conversation UI            │
                         │   - proactive card/inbox       │
                         │   - "why did you do that" sheet │
                         └───────────────┬────────────────┘
                                         │ REST/WSS via gateway (unchanged pattern)
                         ┌───────────────▼────────────────┐
                         │  services/gateway                │
                         │  routes/aureon.ts (NEW, alongside │
                         │  phase3.ts's /v1/ai/assistant)    │
                         └───────────────┬────────────────┘
     ┌────────────────────────────────────┼───────────────────────────────────┐
     │                                    │                                   │
┌────▼─────────┐  ┌────────────┐  ┌───────▼────────┐  ┌───────────┐  ┌────────▼───────┐
│ Context       │  │ Intent      │  │ Planning /      │  │ Policy /   │  │ Action /        │
│ Engine (NEW)  │  │ Engine      │  │ Reasoning        │  │ Permission │  │ Transaction     │
│               │  │ (extends    │  │ Engine (NEW)     │  │ (REUSE     │  │ Engine (NEW)    │
│               │  │ services/ai)│  │                  │  │ existing   │  │                  │
│               │  │             │  │                  │  │ PolicyEngine│ │                  │
└───────┬───────┘  └─────┬──────┘  └────────┬─────────┘  └─────┬─────┘  └────────┬────────┘
        │                │                   │                   │                 │
        │        ┌───────▼────────┐          │                   │        ┌────────▼───────┐
        │        │ Home Graph      │          │                   │        │ Verification    │
        │        │ (NEW, semantic  │◄─────────┘                   │        │ Engine (NEW)     │
        │        │ layer over      │                              │        │                  │
        │        │ domain-model)   │                              │        └────────┬────────┘
        │        └───────┬────────┘                              │                 │
        │                │                                        │                 │
        └────────────────┴────────────────────────────────────────┴─────────────────┘
                                            │
                          ┌─────────────────▼──────────────────┐
                          │  EXISTING SupremeOS core (unchanged) │
                          │  SIL / drivers / automations engine  │
                          │  / scenes / rooms / permissions /    │
                          │  audit / notifications / event bus   │
                          └───────────────────────────────────────┘
```

Every new box is a **reasoning-layer consumer** of existing services, never a replacement.
Aureon calls the SIL, the automation/scene services, the permission engine, and the audit
service exactly as any other domain service would — it gets no special access path.

### 2.2 Component responsibilities and why each belongs in SupremeOS (not bolted outside it)

| Component | Responsibility | Why it belongs here, not as an external bolt-on |
|---|---|---|
| Home Graph | Semantic model: rooms↔devices↔capabilities↔functions↔relationships | Must stay consistent with the live device/room tables; a graph built outside SupremeOS would drift the moment a device is renamed/moved/removed |
| Context Engine | Normalizes time/weather/occupancy/state/energy/security into one versioned, timestamped context object | Every existing intelligence module (`services/intelligence`) already computes fragments of this (presence, energy); Aureon should read from the same live event bus, not poll separately |
| Intent Engine (extended) | NL → structured `AureonIntent`, reusing `services/ai`'s validator pattern | Already exists in nascent form; extending avoids two competing NL pipelines |
| Planning/Reasoning Engine | Intent + context + Home Graph → ordered multi-device plan | Needs the Home Graph and Context Engine's live data — can't be stateless/external |
| Policy Engine | REUSE `services/permissions` `PolicyEngine` unmodified, with new `ResourceType: "intent"` risk tiers | Duplicating permission logic anywhere is the #1 way to create a bypass; brief explicitly forbids this |
| Action Engine | Plan → ordered `CapabilityCommand`s dispatched through SIL, with dependency/rollback semantics | SIL is already the single command path; Action Engine is a *client* of it, same as automations |
| Transaction/Undo Engine | Groups an Aureon session's writes into one reversible unit | Needs real pre/post device state, which only SIL has; must write through the same audit trail |
| Verification Engine | Confirms SIL-reported post-state matches intended state before Aureon claims success | Reuses WSS state feed + device lifecycle status; must never report success SIL didn't confirm |
| Memory System | Structured, permissioned facts (preference/pattern/home-knowledge/temporary/automation) | New Postgres tables in the existing persistence service — same repo pattern, same DB |
| Learning Engine | Proposes automations from observed patterns; never silently edits existing ones | Writes go through the *existing* automation CRUD API with `aiGenerated: true` — no new write path |
| Proactive/Anomaly/Predictive Maintenance | Rule/statistical layer over existing diagnostics + event bus | `DriverDiagnosticsTracker` and Casambi's `health-monitor.ts` already produce the raw signal |
| Conversation Engine | Turns, references, follow-ups, cancellation, undo | New — genuinely absent from the repo today |
| LLM Abstraction | Swap-in-place model interface, local (llama.cpp) or remote | `services/ai-py` already has one working backend; formalize the interface, don't hard-code a 2nd provider directly |
| Tool Layer | The only surface an LLM can call; each tool validates + goes through Policy Engine | New, modeled after existing gateway route validation |

### 2.3 What is explicitly *not* a new source of truth

Aureon Home Graph, Context Engine, and Memory are **derived and cached views**, rebuildable at
any time from: `Device`/`Room`/`Automation`/`Scene` tables, the live event bus, and the audit
log. If SupremeOS's device/room state disagrees with anything Aureon has cached, SupremeOS
wins, unconditionally. No Aureon component may be the last-write-wins source for physical state.

---

## 3. AUREON DATA MODEL

All new tables live in the existing hub Postgres (`services/persistence`), new migrations
appended to the `0001..0028` sequence, one repository per table following the existing pattern.
Types defined as zod schemas in a new `packages/domain-model/src/aureon/` subtree (mirrors how
`automations-dsl.ts` sits beside `entities.ts` today) — not a separate package, to keep
`z.infer` reuse consistent with existing conventions.

### 3.1 Intent schema
```ts
AureonIntent = {
  id: IntentId,
  homeId, userId, conversationId,
  utterance: string,                      // raw NL, retained only per retention policy (§6)
  kind: "control" | "query" | "scene_save" | "automation_create" | "explain" | "undo",
  targetScope: { roomIds?: RoomId[], deviceIds?: DeviceId[], allHome?: boolean },
  goal: string,                            // normalized intent name, e.g. "sleep_comfort"
  parameters: Record<string, unknown>,     // e.g. { temperatureDeltaC: -2 }
  confidence: number,                      // 0-1, from Intent Engine
  ambiguity: { field: string, options: string[] }[] | null, // non-empty => must clarify
  createdAt
}
```

### 3.2 Context schema
```ts
AureonContextSnapshot = {
  id, homeId, capturedAt,
  sources: {
    time: { localTime, sunrise, sunset, dayOfWeek },
    weather: { tempC, condition, source: "provider-id", freshnessSec, confidence } | null,
    occupancy: { homeOccupied, perRoom: Record<RoomId, "occupied"|"vacant"|"unknown"> },
    deviceState: { asOfSeq: number },       // pointer, not a copy — always re-read live via SIL
    energy: { currentLoadW, budgetStatus } | null,
    security: { mode: SecurityMode, triggered },
    activeScene: SceneId | null,
    recentEvents: EventRef[],               // pointers into audit log / automation run history
    householdMode: "normal"|"guests"|"away"|"sleep"|null
  },
  // every leaf carries its own timestamp + confidence; nothing here is assumed fresh globally
}
```
Freshness/invalidation: each source has its own TTL (weather: 15 min, occupancy: live via event
bus so effectively real-time, energy: 1 min). A context field past its TTL is presented to the
Planning Engine as `stale: true`, never silently reused as current.

### 3.3 Home Graph schema (new semantic layer, not a device DB duplicate)
```ts
HomeGraphNode = {
  id, homeId, kind: "home"|"floor"|"room"|"function_zone"|"device",
  refId: RoomId | DeviceId | null,   // null for pure semantic nodes like function_zone
  parentId: HomeGraphNode["id"] | null,
  label: string,
  functions: string[],                // e.g. ["ambient_lighting","climate"] — semantic tags,
                                        // NOT new capability kinds; purely descriptive
  derivedFrom: "domain-model" | "aureon-inference" | "user-declared"
}
HomeGraphEdge = {
  id, homeId, fromNodeId, toNodeId,
  relation: "contributes_to" | "controls_same_area_as" | "depends_on" | "conflicts_with",
  confidence: number, source: "structural" | "learned" | "user-declared"
}
```
`device` nodes are 1:1 mirrors of `Device.id` + `Device.roomId`, refreshed on every device
CRUD event off the bus — never hand-maintained duplicate state. `function_zone` nodes (e.g.
"living-room ambient lighting") are the genuinely new semantic layer: they group devices across
protocols by *function*, which today only exists implicitly (a human reading a room's device
list). This directly answers the brief's "Aureon must understand that these devices collectively
contribute to the living-room environment" requirement without duplicating `Room`/`Device`.

### 3.4 Memory schema
```ts
AureonMemory = {
  id, homeId, userId: UserId | null,     // null = household-level, not user-specific
  category: "preference" | "pattern" | "home_knowledge" | "temporary" | "automation_provenance",
  subject: { roomId?, deviceId?, domain?: string },
  statement: string,                      // human-readable, always explainable
  structured: Record<string, unknown> | null, // e.g. { targetTempC: 24 } for preference
  confidence: number,
  evidenceRefs: string[],                 // audit_log ids / automation run ids this was learned from
  createdAt, expiresAt: Date | null,       // "temporary" category MUST set this
  visibility: "private_to_user" | "household",
  editable: true,                          // always — no memory is silently un-editable
}
```
Every memory: inspectable (`GET /v1/aureon/memory`), editable, deletable by its owning user or an
admin, and requires `evidenceRefs` pointing at real audit/run-history entries — no memory may be
created without a traceable origin.

### 3.5 Action / plan schema
```ts
AureonPlan = {
  id, transactionId, intentId, homeId,
  steps: AureonPlanStep[],
  riskLevel: 0|1|2|3,                      // max of all step risk levels
  requiresConfirmation: boolean            // true whenever riskLevel >= 2, or ambiguity was present
}
AureonPlanStep = {
  id, order, dependsOn: string[],           // step ids
  kind: "device_command" | "scene_activate" | "automation_create" | "delay" | "query",
  deviceId?, capability?, command?: CapabilityCommand,   // reuses EXISTING CapabilityCommand type
  conditions?: AutomationCondition[],       // reuses EXISTING automation DSL condition type
  riskLevel: 0|1|2|3,
  rollback: { kind: "inverse_command"|"restore_prior_state"|"none", priorState?: CapabilityState }
}
```
Deliberately reuses `CapabilityCommand` and `AutomationCondition` from the existing DSL rather
than inventing parallel shapes — a plan step executes through the *same* SIL call an automation
action would.

### 3.6 Transaction / undo schema
```ts
AureonTransaction = {
  id, homeId, userId, conversationId, createdAt,
  planId, status: "executing"|"completed"|"partially_failed"|"failed"|"undone",
  entries: AureonTransactionEntry[]
}
AureonTransactionEntry = {
  deviceId, capability,
  priorState: CapabilityState,             // captured via SIL BEFORE the command, always
  command: CapabilityCommand,
  result: "success"|"failed"|"unverified",
  postState: CapabilityState | null,       // captured via SIL AFTER, only if verification ran
}
```
Undo replays `priorState` as a new command per entry (never "guesses an inverse") — directly
satisfying the brief's requirement to revert the actual transaction, not synthesize opposite
commands. A transaction with any `"unverified"` entries surfaces that honestly rather than
claiming a clean undo is possible.

### 3.7 Permission / policy model (risk tiers, layered on existing RBAC/ABAC)
```
LEVEL 0  read-only              → sensor/state queries, explanations
LEVEL 1  low-risk environmental → lighting, blinds/curtains, non-critical HVAC nudges
LEVEL 2  consequential          → scene/automation creation or edit, larger HVAC setpoint changes,
                                   multi-room bulk actions
LEVEL 3  high-risk/security     → locks, alarm arm/disarm, gates, garage doors
```
Mapping is a static table keyed by `(CapabilityKind, command.action, deviceMetadata)` —
e.g. `lock.unlock` and `onoff` on a device tagged `metadata.security.isGate` are always LEVEL 3
regardless of context. New `ResourceType: "aureon_intent"` added to the existing
`services/permissions` enum; `PolicyEngine.decide()` is called unmodified — Aureon adds data
(risk tier as an attribute checked by grants), not new logic paths. LEVEL 2/3 actions always set
`requiresConfirmation`; LEVEL 3 additionally re-checks the acting user's role is not `guest`,
`child`, or an expired grant, even if a plan was pre-approved.

### 3.8 Conversation schema
```ts
AureonConversation = { id, homeId, userId, startedAt, lastTurnAt, activeRoomContext: RoomId|null }
AureonTurn = {
  id, conversationId, order, role: "user"|"aureon",
  utterance: string | null, intentId: IntentId | null, transactionId: TransactionId | null,
  references: { pronoun: string, resolvedTo: DeviceId|RoomId|SceneId|TransactionId }[]
}
```
"That"/"this room"/"it" resolution reads the last N turns' `resolvedTo` targets plus
`activeRoomContext` (settable from the UI's currently-open room/device screen) before falling
back to asking.

---

## 4. AUREON EXECUTION FLOW

```
1. SENSE     User utterance (or a proactive trigger from Anomaly/Proactive engine)
2. UNDERSTAND  Intent Engine → AureonIntent (validated against real device/room ids —
               rejects hallucinated targets exactly like services/ai-py's _valid() does today)
3. CONTEXT   Context Engine snapshot pulled fresh (not cached beyond documented TTLs)
4. REASON    Planning Engine + Home Graph → AureonPlan (ordered steps, risk-tagged)
5. VALIDATE  Policy Engine (existing PolicyEngine.decide(), per step) — reject/require-confirm
             any step the user's role/grants don't cover; SIL capability check confirms every
             targeted device+capability genuinely exists and is currently commandable
             (DeviceLifecycleState ∈ {BOUND, ONLINE, OFFLINE-queued})
6. CONFIRM   If requiresConfirmation: present plan in plain language, wait for explicit accept
             (skippable only for LEVEL 0/1 plans within a user's standing preference settings)
7. EXECUTE   Action Engine dispatches each step through SIL exactly as an automation action would;
             AureonTransaction created first, priorState captured per entry before each command
8. VERIFY    Verification Engine re-reads state via SIL (post-command, bounded wait matching
             each capability's normal ack latency) — classifies each entry success/failed/
             unverified; never assumes success from a queued/OK response
9. EXPLAIN   Aureon reports actual outcome ("47 of 49 lights off; 2 unreachable") — sourced only
             from step 8's real results, never from the plan's intended state
10. LEARN    Learning Engine records evidence (accepted/rejected, overridden shortly after) into
             Memory — never mutates an existing automation/scene directly; proposes, logs a
             suggestion in Memory, and only acts through the normal CRUD path if the user accepts
```

Undo re-enters at step 7 using the transaction's `priorState` entries as the new plan, still
passing through steps 5/6/8/9.

---

## 5. SECURITY / PERMISSIONS

- All action dispatch goes through the **existing** `SupremeIntegrationLayer` and **existing**
  `PolicyEngine` — Aureon adds a `ResourceType`/risk-tier attribute, never a parallel check.
- The Tool Layer (LLM-facing) is the only thing an LLM can call, and every tool re-validates
  independently of what the model claims (mirrors `_valid()` in `services/ai-py/app/llm.py`
  today) — e.g. `execute_action` re-fetches the device from SIL and re-runs
  `PolicyEngine.decide()` itself; it never trusts a permission claim embedded in model output.
- LEVEL 3 actions (locks, alarm, gates) additionally require: role check beyond baseline RBAC
  (never `guest`/`child`, even with an explicit grant, unless the household admin explicitly
  raises that grant), and are **never** eligible for "skip confirmation" preferences.
- Every Aureon-initiated write is logged to the existing hash-chained `audit_log` with
  `actorUserId` set to the *human* who initiated the conversation (never a synthetic "Aureon"
  actor with elevated rights) plus `metadata.aureonTransactionId` for traceability.
- Household roles (§1.11, already richer than requested) directly gate what a user may *ask*
  Aureon to do — a `guest` conversation never even reaches planning for a LEVEL 3 intent; it's
  rejected at step 5 with an honest explanation, not a silent no-op.

---

## 6. PRIVACY / LOCAL-FIRST

- Default posture matches ADR-0006: Aureon must remain **fully usable for control/verification/
  explanation with the local llama.cpp planner and zero network egress**. Cloud LLM use (if ever
  enabled) is strictly additive, opt-in per household, and never required for LEVEL 0-2 control.
- Data classification:
  - **Local-only, never leaves the hub**: device/room state, security state, lock state,
    camera-adjacent metadata, memory records tagged `visibility: "private_to_user"`.
  - **Cloud-eligible only with explicit household opt-in**: anonymized utterance text for a
    remote-LLM planning call, when local confidence is too low to plan safely.
- Utterance retention: raw `utterance` text on `AureonIntent`/`AureonTurn` is retained only for
  the conversation's active session plus a short debugging window (default 24h), then purged;
  only the *structured* intent/plan/transaction records persist long-term (matches the "memory
  must be permissioned, not blindly store everything" requirement).
- Memory (`AureonMemory`) is per-category permissioned (§3.4); a user can list, edit, and delete
  their own; household admins can view household-level memory but not another user's
  `private_to_user` entries.
- Cloud failure behavior: if a household has opted into cloud reasoning and the cloud call fails
  or times out, Aureon falls back to the local deterministic planner (same posture as `services/
  ai` today) — a cloud outage degrades sophistication, never availability of basic control.
- Multimodal extension points (cameras/voice/mic) are **not implemented in MVP/V1** but the Tool
  Layer and Context Engine's source-registration pattern (§3.2) are generic enough to add a new
  `sources.vision`/`sources.audio` entry later without a redesign — no architectural blocker,
  no premature build either, per the brief's explicit instruction.

---

## 7. USE-CASE CATALOGUE (representative, capability-honest)

Full 150+ catalogue is maintained as structured data in
`docs/architecture/aureon/aureon-use-cases.md` (companion file, see below) to keep this document
readable. Format per entry: request → context needed → devices/systems → reasoning → actions →
verification → safety level → automatic/proactive/confirm → dependencies → future flag if not
buildable today. Categories mirror the brief's 40 groups (natural-language control through
future autonomous-home capabilities). Every entry was checked against §1's real capability list
(`onoff, brightness, color, temperature, position, media, lock, fan, vacuum, sensor`) — nothing
in the catalogue requires a capability that doesn't exist; anything needing more (e.g. AV
scene "cozy mood" content selection beyond the `media` capability's fields) is explicitly
labeled **[future capability]**.

---

## 8. MVP / V1 / V2 / V3

### MVP — demonstrates genuine whole-home reasoning, smallest possible slice
- Home Graph: read-only, structural only (no learned edges) — mirrors existing Room/Device.
- Context Engine: time + device state + occupancy (from existing presence intelligence) only.
- Intent Engine: extend existing `services/ai` planner with 5-10 hand-designed intents
  ("comfort", "lighting adjust", "away check", "explain state", "undo").
- Planning: single-room, single-protocol-category plans only (e.g. "cozy living room" touches
  lighting + curtains, not cross-room).
- Policy: risk tiers 0-2 only; no LEVEL 3 wiring yet (locks/alarm excluded from MVP).
- Action + Verification: real SIL dispatch + real post-state check, no partial-failure retries.
- Transaction/Undo: single flat transaction, no nested rollback ordering.
- Conversation: single active room context, "it"/"that" resolution only (no multi-turn planning).
- Explainability: "why did that happen" for Aureon's own last transaction only.
- UI: minimal chat surface in `apps/web-homeowner/src/features/aureon/` — text in, plan
  confirmation, plain-language result. No proactive notifications yet.

### V1
- Home Graph: add `function_zone` semantic nodes + learned edges (confidence-scored).
- Context Engine: add weather, energy, security state, active scene.
- Multi-room, multi-protocol plans ("make house ready for guests" across lighting/HVAC/AV).
- LEVEL 3 actions enabled, with the full role/grant hardening from §5.
- Memory: preference + automation_provenance categories; conversational automation creation
  ("every evening around sunset...") with confirm-before-create.
- Proactive Intelligence v1: a small, prioritized set of high-confidence alerts (garage open
  too long, AC running while unoccupied) — reuses existing diagnostics/energy signals.
- Explainability: full timeline query across audit log + automation run history + Aureon's own
  transactions.

### V2
- Anomaly Detection framework (rule/statistical, not ML) across energy/HVAC/lighting/
  reliability domains, with NORMAL/UNUSUAL/WARNING/CRITICAL classification.
- Predictive Maintenance v1 surfaced to both homeowner and installer diagnostics UI, built on
  existing `DriverDiagnosticsTracker`/Casambi health-monitor signal history.
- Learning Engine: pattern detection → proposed automations ("I've noticed..."), never
  auto-applied.
- Household roles fully modeled in conversation behavior (family vs guest vs staff phrasing and
  allowed intents).
- LLM abstraction formalized as a pluggable interface with 2+ real backends (local llama.cpp +
  one optional cloud provider), swappable per task type.

### V3
- Multimodal context sources (camera-derived occupancy/scene understanding, voice) added as new
  Context Engine sources — architecture already supports this per §6, only now implemented.
- Cross-home / multi-property reasoning (if SupremeOS's cloud plane extends to it).
- Deeper predictive maintenance (trend-based, e.g. rising latency forecasting a device failure).
- Full explainability graph UI (visual "why" trace from user request to verified device state).

---

## 9. IMPLEMENTATION PLAN (MVP slice only — later phases re-planned at their own start)

1. **Schemas first**: add `packages/domain-model/src/aureon/*.ts` (intent, context, plan,
   transaction, memory, conversation zod schemas) + wire into `index.ts`. No runtime code yet.
2. **Persistence**: new migration(s) in `services/persistence/migrations/` for
   `aureon_transactions`, `aureon_transaction_entries`, `aureon_memory`, `aureon_conversations`,
   `aureon_turns`; matching repositories under `services/persistence/src/repositories/`.
3. **Home Graph (structural-only) + Context Engine**: new module, likely
   `services/intelligence/src/aureon/home-graph.ts` + `context-engine.ts` — reuses existing
   `services/intelligence` registration pattern (`IntelligenceModule`) rather than a new service
   process, since it's read/derive-only and already lives next to presence/energy/zones.
4. **Extend `services/ai`**: add the Policy/Risk-tier table, Action Engine (thin wrapper calling
   SIL the same way `AutomationEngine.runAutomationAction()` does — reuse that function directly
   where the shapes match), Verification Engine, Transaction/Undo.
5. **Tool Layer**: `services/ai/src/tools/*.ts` — one file per tool (`get-home-state.ts`,
   `execute-action.ts`, etc.), each independently permission-checked.
6. **Gateway**: `services/gateway/src/routes/aureon.ts` — `/v1/aureon/converse`,
   `/v1/aureon/transactions/:id/undo`, `/v1/aureon/memory` — alongside, not replacing,
   `/v1/ai/assistant`.
7. **UI**: `apps/web-homeowner/src/features/aureon/` — conversation panel, plan-confirmation
   sheet, transaction/undo affordance — built from existing `packages/aureon-web` primitives
   only (Sheet, Card, Button, Timeline, CapabilityGate for any inert control it might surface).
8. **Docs**: update `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`, `TODO.md` per CLAUDE.md's
   session-completion checklist, plus a new ADR under `docs/architecture/adr/` for the Aureon
   MVP decision (extends ADR-0006/0017 rather than superseding them).

---

## 10. FILES / MODULES TO CREATE OR MODIFY (MVP)

**Create**
- `packages/domain-model/src/aureon/{intent,context,plan,transaction,memory,conversation}.ts`
- `services/persistence/migrations/00XX_aureon_core.sql`
- `services/persistence/src/repositories/aureon-{transaction,memory,conversation}-repo.ts`
- `services/intelligence/src/aureon/{home-graph,context-engine}.ts`
- `services/ai/src/aureon/{planning-engine,policy-risk-tiers,action-engine,verification-engine,
  transaction-engine}.ts`
- `services/ai/src/tools/*.ts`
- `services/gateway/src/routes/aureon.ts`
- `apps/web-homeowner/src/features/aureon/{capability-mapper.ts,conversation-panel.tsx,
  plan-confirmation-sheet.tsx}.tsx`
- `docs/architecture/adr/00XX-aureon-mvp.md`
- `docs/architecture/aureon/aureon-use-cases.md` (companion catalogue)

**Modify**
- `packages/supreme-contracts/src/phase3.ts` (or a new `aureon.ts` contracts file) — request/
  response shapes for the new endpoints.
- `services/permissions/src/roles.ts` — add `ResourceType: "aureon_intent"` and risk-tier
  attribute plumbing.
- `services/gateway/src/context.ts` — wire new services into the composition root.
- `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`, `TODO.md`.

**Explicitly not modified**: `services/integration-layer`, driver implementations, the
automation/scene engines' own internals, `packages/domain-model/src/capabilities.ts` (the
10-capability enum stays closed).

---

## 11. TEST STRATEGY

- **Unit** (vitest, co-located): Home Graph derivation from a fixture Device/Room set; Context
  Engine TTL/staleness logic; Planning Engine producing correct step ordering/risk tags for
  known intents; Policy risk-tier table coverage (one test per `(capability, action)` pair);
  Verification Engine's success/failed/unverified classification against mocked SIL responses.
- **Integration**: Tool Layer calls against a real (test) SIL + PolicyEngine — confirm a tool
  cannot bypass permission even when given a crafted "the model said this is allowed" input.
- **E2E** (`*.e2e.test.ts`, `services/gateway/src`, matching existing pattern e.g.
  `casambi-network-scoped-addressing.e2e.test.ts`): full conversation → plan → confirm →
  execute → verify → undo round trip against the mock backend, asserting the transaction's
  `priorState` correctly restores on undo.
- **Never-assume-success regression test**: a fixture where SIL reports 2 of 49 devices
  unreachable — assert Aureon's explanation text reflects the honest count, not "done."
- **Playwright** (UI, per CLAUDE.md's requirement for UI changes): conversation panel and
  plan-confirmation sheet verified live at phone/tablet/desktop/ultrawide tiers before any UI
  work is called done.

---

## 12. RISKS / OPEN QUESTIONS

1. **No state-arbitration engine exists today.** If a future multi-provider conflict scenario
   arises (two drivers claiming one device), Aureon's Verification Engine inherits that gap —
   flagged, not solved by this design; out of scope until SupremeOS itself adds it.
2. **Energy time-series depth unknown** — `services/analytics` wasn't inspected in this pass;
   V2 anomaly/predictive-maintenance work should re-verify what history is actually queryable
   before promising trend-based reasoning.
3. **`services/ai-py` roadmap ownership** — extending the existing local-LLM sidecar means
   Aureon's planning quality is bounded by whatever GGUF model is deployed; V1's multi-room
   planning ambitions may need a larger on-box model or the optional cloud path sooner than V2.
4. **Function-zone learning risk** — Home Graph's `derivedFrom: "aureon-inference"` edges must
   never silently become authoritative; needs a clear UI affordance for a homeowner to confirm
   or reject an inferred grouping before it influences planning (open UX question, not yet
   designed).
5. **Conversation memory retention window (24h default, §6)** is a starting assumption — needs
   a product/privacy decision, not just an engineering default.
6. **Where exactly Home Graph/Context Engine physically run** — proposed as a `services/
   intelligence` extension for MVP; if it grows heavy, a dedicated `services/aureon` process may
   be justified later. Do not split prematurely (per CLAUDE.md's no-speculative-abstraction
   rule) — revisit only if `services/intelligence` becomes unwieldy.
