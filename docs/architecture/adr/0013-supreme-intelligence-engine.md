# ADR 0013 — Supreme Intelligence Engine (extensible, local-first intelligence platform)

- Status: **Accepted**
- Date: 2026-06-29
- Context: blueprint §10 (automation/AI), §13 (cloud is optional), §16 (energy); ADR 0001 (SIL),
  ADR 0006 (native migration + local LLM). Invariant **I1**: the hub works fully offline.

## Context

Supreme OS should *proactively* assist — understanding occupancy, presence, energy, comfort and
behaviour — while staying local-first and private. The naïve version ("turn devices off when nobody
is home") is a trap: it is a single reflex with a single presence source, it spams users, and it
cannot grow. We need a **platform** that many intelligence capabilities plug into over time
(Presence, Energy, Comfort, Security, Maintenance, Predictive, Occupancy, Wellness, AI Assistant)
without re-architecting the core, and every automatic action must be explainable and gated on
confidence.

Two hard constraints shape the design:

1. **Local-first / no cloud AI.** Like the rest of the hub, SIE must run and decide entirely on-box
   (invariant I1). Cloud is, at most, an optional offload — never on the decision path.
2. **No single source of truth for presence.** Real homes have many weak, noisy presence signals;
   trusting any one of them is wrong. The architecture must fuse them and must let new sensor classes
   be added later without touching the fuser.

## Decision

Introduce `@supreme/intelligence` — a **pure, deterministic** package (no I/O, no clock, no cloud) —
as the SIE core, wired into the gateway by a minute-tick runner (the same pattern as the energy
runners). Three pillars:

### 1. Module registry (the extensibility seam)

`IntelligenceEngine` holds a set of `IntelligenceModule`s. A module is a pure evaluator:

```
evaluate(input: EngineInput): { observations: Observation[]; suggestions: Suggestion[] }
```

It emits **Observations** (facts it perceived) and **Suggestions** (proposed actions, each carrying a
multi-dimension `Confidence`). The engine runs modules concurrently, **isolates failures** (one
module throwing never breaks the others), and merges output. Adding Comfort/Security/Maintenance/etc.
is `engine.register(new XModule())` with **zero core changes** — that is the architectural guarantee.
The engine never controls devices and never calls the network; the host decides what to do with
suggestions under the user's Auto Pilot mode.

### 2. Multi-dimensional confidence

Every decision carries a breakdown — `presence`, `roomVacancy`, `zoneVacancy`, `ownership`,
`energy`, … — rolled up into a single `decision` score. The default roll-up is the **weakest link**
(`min`): an automatic action is only as trustworthy as its least-certain input. Dimensions are an
open map, so modules add their own without changing the type. Auto Pilot executes only above a
configurable `decision` threshold; below it, it asks. This makes the UI self-explaining ("present
98%, room vacant 91%, ownership 100%").

### 3. Presence fusion + zones

`PresenceSignal` is the single shape every detection method emits: `{ source, userId, roomId?,
present, strength, ts }`. The fuser weights each signal by **source reliability × its own strength ×
freshness**, where freshness decays on a half-life so a stale Wi-Fi association can't keep someone
"present" forever. Output is one `PresenceEstimate` per user (status, 0..1 confidence, best-guess
room). Source reliabilities are a table (`SOURCE_WEIGHTS`): precise room-level sensors (UWB, mmWave,
camera AI) outrank coarse "somewhere on the LAN" signals.

- **Available now:** `wifi_ap`, `app_heartbeat`, `local_network`.
- **Future-ready (no fuser change needed):** `bluetooth`, `ble_beacon`, `esp32_node`, `mmwave`,
  `pir`, `door_sensor`, `camera_ai`, `phone_location`, `uwb`, `smart_watch`, `vehicle`, `voice`.

Rooms roll up into **Zones**; `ZoneOccupancyTracker` folds the estimates into who is in the house,
who is in each zone, who arrived/left this tick, and how long each zone (and the whole house) has
been vacant. Vacancy duration needs cross-tick memory, so the tracker is a thin stateful class over a
pure diff.

## Consequences

- **Grows without churn.** Each new intelligence capability is one module; presence gains new sensor
  classes by emitting the existing signal shape. The core is closed for modification, open for
  extension.
- **Explainable + safe.** Confidence is never one opaque number; Auto Pilot is threshold-gated, so it
  defaults to asking when unsure.
- **Local + private.** The package is pure and offline; the gateway runner feeds it from the hub's own
  home/analytics/presence state and persists learning/history locally (no cloud AI, ever).
- **Testable.** Pure cores mean the fusion, zone math, confidence roll-ups and module isolation are
  all unit-tested deterministically; the energy decision core and Auto Pilot suppression follow the
  same discipline.
- **Trade-off:** the minute tick bounds reaction latency to ~60s, which is correct for energy/comfort
  nudges; anything needing sub-second reaction (security tripwires) stays in the event-driven path,
  not SIE.

## Status of implementation

Landed incrementally behind this ADR: (1) core engine + confidence + presence fusion + zones
(this change); then device-ownership + energy decision core; Auto Pilot modes + smart-notification
suppression; learning/history persistence + gateway routes; reports + the Flutter Intelligence
Dashboard. Each step is independently tested and shipped.
