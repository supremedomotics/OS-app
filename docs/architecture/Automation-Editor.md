# Automation Editor — Architecture & Developer Reference

> Governs: the Automation Builder UI (`apps/web-homeowner/src/automations.tsx`,
> `apps/mobile/lib/screens/automation_editor.dart`), the automation-agnostic DSL
> (`packages/domain-model/src/automations-dsl.ts`), and the native execution engine
> (`services/automations/`, `@supreme/automations`). Formally governed by
> **ADR-0005** ("Native automation engine, AI drafts, and append-only audit") — this
> document is a companion reference, not a replacement for it.
>
> **A note on scope, read this first:** an earlier draft of this task referenced
> ADR-0016 through ADR-0021, ADR-0100, "Runtime Objects," "Runtime Events," and a
> four-level field-resolution pipeline (Driver Command Metadata → Capability
> Structural Configuration → Live-State Inference → Static Capability Table). None
> of these exist in this repository — verified by full-repo search, not assumed.
> This document describes what **actually exists today** (§1–§4) and clearly labels
> everything speculative as a **future proposal** (§5, and the companion doc
> [Automation-Editor-Future-Driver-SDK-Roadmap.md](./Automation-Editor-Future-Driver-SDK-Roadmap.md)),
> never as documentation of current behavior.

## 1. What the Automation Editor actually is today

A single-file drag-and-drop builder per platform — `automations.tsx` (React, 375
lines pre-hardening) and `automation_editor.dart` + `automation_canvas.dart` +
`automations_screen.dart` (Flutter, ~665 lines combined) — with **no shared package
between them**. Each independently hand-authors the same palette of six node types,
the same default-value table, and the same field-editing UI. This is a real,
confirmed instance of cross-platform duplicated logic (documented, not silently
fixed — see the [Production Hardening Report](./Automation-Editor-Production-Hardening-Report.md)
§1), inherent to TypeScript and Dart not sharing a module system; resolving it would
mean building a shared schema-driven renderer, which is exactly the kind of
architectural expansion this hardening pass was told not to attempt.

Both platforms edit a **fixed, hardcoded set of six node types** — there is no
dynamic, driver-aware, or capability-aware rendering of any kind:

| Node type | Section | Editable fields | Fixed (never exposed to the user) |
|---|---|---|---|
| `time` | trigger | `at` (HH:MM), `days` | — |
| `interval` | trigger | *(view-only in Canvas; not authorable in the editor)* | — |
| `device_state` | trigger or condition | `deviceId`, a boolean on/off toggle | `capability: "onoff"`, `field: "on"`, `op: "eq"` |
| `device_command` | action | `deviceId`, a boolean on/off toggle | `command.capability: "onoff"` |
| `scene_activate` | action | `sceneId` | — |
| `notify` | action | `title`, `body` | `level: "info"` |
| `delay` | action | `ms` (rendered/edited as seconds) | — |

The web editor's own source comment has always been explicit about this: *"Display +
run/enable here; full drag-and-drop editing is a follow-up."*

## 2. The DSL supports far more than the editor exposes — the real, honest gap

`packages/domain-model/src/automations-dsl.ts` defines the actual wire/execution
contract, and it is considerably richer than what either editor lets a homeowner
author:

- `AutomationTrigger`/`AutomationCondition`'s `device_state` variant accepts **any**
  `CapabilityKind` (`onoff`, `brightness`, `color`, `temperature`, `position`,
  `media`, `lock`, `fan`, `vacuum`, `sensor`), **any** field name within that
  capability's state shape (not just `"on"`), and **any** `Comparator`
  (`eq`/`ne`/`gt`/`lt`/`gte`/`lte`/`changed` — not just equality).
- `AutomationAction`'s `device_command` variant accepts the **full** `CapabilityCommand`
  discriminated union (`packages/domain-model/src/capabilities.ts`) — e.g. a real
  brightness `set` command with a percent, a color command with hue/saturation, a
  media `volume`/`seek` command — not just onoff.

None of this is reachable from either Automation Editor UI today. A homeowner
cannot build "when the living room lamp's brightness drops below 20%, run the movie
scene" through either drag-and-drop builder, even though the backend DSL, the
engine, and the compiler (`compileToHa()`) all already support it. **This is the
real field-resolution gap** — not a missing four-level pipeline, but a UI that
hardcodes one capability (`onoff`) and ignores the rest of a DSL it already fully
executes.

This is a legitimate, evidence-based finding, not a defect introduced by this
hardening pass — it predates this work and is being documented, not fixed, per the
explicit "no new user-facing features" constraint on this task.

## 3. What resolves a field today — the real (single-level) pipeline

There is no multi-level resolution chain. What actually happens, end to end:

```
PALETTE (hardcoded array in automations.tsx / automation_editor.dart)
        │  user drags/taps a block
        ▼
defaultNode(type)  — a hardcoded switch, one fixed shape per node type
        │
        ▼
NodeConfig / _ConfigSheet  — a hardcoded switch on node.type,
                             rendering ONLY the fields listed in §1's table
        │  user edits deviceId / at / title / body / sceneId / the onoff toggle
        ▼
EditorNode[]  (typed union, see §4)
        │  Editor.save() / _AutomationEditorState._save()
        ▼
POST /v1/automations  →  CreateAutomationRequest.parse()  (zod validation against
                          the FULL DSL — packages/supreme-contracts/src/phase3.ts)
        │
        ▼
AutomationService.create()  →  AutomationEngine.setAutomations()
```

The one genuinely **driver-influenced** input anywhere in this chain is the
`devices`/`scenes` lists themselves (`client.home()` → per-room `devicesInRoom()`,
`client.scenes()`) — which device/scene names appear in the picker dropdowns. The
driver never influences *which fields are shown or how they're validated* — that's
entirely hardcoded per node type, identically for every device regardless of its
real capabilities or the driver that owns it.

### The one real, generic mechanism that exists but isn't wired in

`INativeProtocolDriver.getCapabilityConfig?(deviceId, capability):
Record<string, unknown> | null` (`services/integration-layer/src/protocols/
driver.ts`) is a genuine, already-shared, already-used mechanism — AVR, HEOS,
Yamaha, and CoolMaster all implement it, returning driver-reported structural
config (volume ranges, sound modes, zone lists, fan-speed lists, etc. — see
[Driver-SDK.md](./Driver-SDK.md)). It is surfaced generically via
`GET /v1/devices/:id/diagnostics`-adjacent device-detail UI
(`apps/web-homeowner/src/features/media/detail.tsx` and sibling feature modules).

**The Automation Editor never calls this.** It is the closest real analog to the
originally-requested "Capability Structural Configuration" level, and it's the only
one of the four originally-named levels with any implementation in this repository
— but it is completely disconnected from automation authoring today. Wiring it in
would be new functionality (a capability-aware field editor), not a hardening fix,
and is out of scope here — see the roadmap doc for how this would plug in if a
future session builds it.

There is no "Live-State Inference" level and no "Static Capability Table" anywhere
in the codebase (verified by repository-wide search for the concept, not just the
name) — the engine's condition evaluation (`AutomationEngine.evaluateConditions()`)
reads live state directly via the injected `getState()` executor at *execution*
time, which is a runtime read, not an authoring-time inference step the editor
consults while building the automation.

## 4. Type safety of the authoring shape (`EditorNode`)

As of this hardening pass, `automations.tsx` types its six node shapes as a real
discriminated union, `EditorNode`, rather than the previous
`Record<string, unknown> & { type: string }` escape hatch:

```ts
export type EditorNode =
  | { type: "time"; at: string; days: number[] }
  | { type: "device_state"; deviceId: string | null; capability: "onoff"; field: "on"; op: "eq"; value: boolean }
  | { type: "device_command"; deviceId: string | null; command: { capability: "onoff"; action: "on" | "off" } }
  | { type: "scene_activate"; sceneId: string | null }
  | { type: "notify"; level: "info"; title: string; body: string }
  | { type: "delay"; ms: number };
```

This is **not** the full DSL — it's a typed mirror of exactly the six shapes the
editor currently produces (§1's table), which is why `nodeSummary()` and
`defaultNode()` can now be `switch` statements with no `default` case: TypeScript
itself enforces that every `EditorNode` variant is handled, and a future variant
added to this union without updating those functions fails to *compile*, not just
to render correctly at runtime. See the
[Production Hardening Report](./Automation-Editor-Production-Hardening-Report.md)
§6 for the full type-safety change list.

## 5. Driver Integration Guide (what exists to integrate with, today)

A driver author who wants their device to work with the Automation Editor needs to
do **nothing automation-specific** — the editor is already fully protocol-agnostic
(confirmed: `automations.tsx` never references a protocol name, driver class, or
`protocol` field anywhere; see the
[Production Hardening Report](./Automation-Editor-Production-Hardening-Report.md)
§8's protocol-compatibility validation). A device becomes automatable the moment it:

1. Is commissioned with `capabilities` including `onoff` (the only capability the
   editor currently authors against).
2. Reports `CapabilityState` for `onoff` through the normal SIL state-delta path
   (`onDeviceState` → `DeviceStateEvent`), so `device_state` triggers/conditions can
   read it.
3. Accepts `CapabilityCommand` for `onoff` through the normal command path, so
   `device_command` actions can drive it.

No manifest field, no driver method, no opt-in flag exists or is needed for
automation support specifically — it rides entirely on the existing capability
contract every driver already implements for the rest of the platform. For what a
**future**, richer automation-authoring surface would need from a driver (to author
brightness/color/media/etc. automations, not just onoff), see
[Automation-Editor-Future-Driver-SDK-Roadmap.md](./Automation-Editor-Future-Driver-SDK-Roadmap.md)
— explicitly future work, not required or implemented here.

## 6. Event flow (backend)

```
SIL state delta  ──►  AutomationService.onDeviceState(event)
                          │  (no-op until AutomationService.start() has loaded once)
                          ▼
                       AutomationEngine.onDeviceState(event)
                          │  for each enabled engine="supreme" automation:
                          │  does any device_state TRIGGER match this event?
                          ▼
                       AutomationEngine.execute(automation, "device_state")
                          │  evaluate ALL conditions (device_state + time_window)
                          │  — first failure recorded, short-circuits
                          ▼
                       run each action in order via the injected AutomationExecutors
                       (command / activateScene / notify / delay's sleep)
                          │  first failing action stops the run (documented as-is)
                          ▼
                       AutomationRun recorded (ring buffer, historyLimit=100)
                          │
                          ▼
                 GET /v1/automations/:id/runs  →  ActivityLog (Automation Debugger)
```

Time/interval triggers follow the same `execute()` path, driven by
`AutomationService.tick()` (gateway calls this once a minute per ADR-0005). Manual
"Run now" (`POST /v1/automations/:id/run` → `AutomationService.testRun()`) skips
condition evaluation entirely (`skipConditions = true`) — documented, existing
behavior, unaffected by this hardening pass.
