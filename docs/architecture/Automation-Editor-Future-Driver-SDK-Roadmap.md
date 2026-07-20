# Automation Editor — Future Driver SDK Roadmap

> **Everything in this document is a future design proposal.** None of it is
> implemented. None of it is part of ADR-0005 or any accepted ADR. No code in this
> repository does what's described here. This document exists to answer "what would
> it take to let the Automation Editor author more than onoff automations" without
> implementing any of it now — per the explicit brief that this hardening pass must
> not introduce speculative abstractions, new schemas, or Driver SDK changes.
>
> If this roadmap is ever pursued, it should become its own ADR (the next available
> number after the current highest, `docs/architecture/adr/0015-*.md` at the time of
> writing) and its own implementation session — not retrofitted into this one.

## Why this is needed (recap from [Automation-Editor.md](./Automation-Editor.md) §2)

The DSL and engine already support triggers/conditions/actions across every
`CapabilityKind` (brightness, color, temperature, position, media, lock, fan,
vacuum, sensor — not just onoff) and the full `CapabilityCommand` union. The editor
UI hardcodes one capability. Closing that gap needs the editor to know, for a given
device, *which* fields are meaningful to expose and how to render them — which is
exactly what the following proposal would provide.

## Proposed: Driver Command Metadata contract (examples only — no implementation)

A structural, optional, driver-reported description of a capability's commands —
distinct from (and layered *above*) the existing, real
`getCapabilityConfig()` mechanism ([Automation-Editor.md](./Automation-Editor.md)
§3), which describes device-instance *state* (current volume range, current zone
list). Command Metadata would describe the *shape of the command itself*, for
authoring UIs like the Automation Editor to render generic, capability-aware forms
instead of a hardcoded onoff toggle.

**This is not a new schema being introduced by this pass** — it is a worked example
of what one could look like, for a future ADR to actually specify and a future
session to actually build.

```ts
// ILLUSTRATIVE ONLY — not a real type, not exported anywhere, not implemented.
interface DriverCommandMetadata {
  /** Stable id — the discriminant this metadata describes, e.g. "brightness.set". */
  commandId: string;
  /** User-facing name, pre-localization. */
  displayName: string;
  /** i18n key set, so `displayName` isn't hardcoded English in the metadata itself. */
  localization?: { key: string; namespace: string };
  /** Groups related commands in the Automation Editor's palette
   * (e.g. "lighting", "climate", "media-transport"). */
  category: string;
  /** What the command actually accepts — parallels CapabilityCommand's shape for
   * this one command, but described data-first so a generic form renderer can
   * build UI from it without a hardcoded switch per capability. */
  parameterSchema: {
    name: string;
    kind: "number" | "boolean" | "enum" | "string";
    range?: { min: number; max: number; step?: number }; // for "number"
    options?: { value: string; label: string }[]; // for "enum"
    required: boolean;
  }[];
  /** Structural validation beyond parameterSchema's shape (e.g. "brightness level
   * must be 0 when on=false") — illustrative; a real design would likely reuse zod
   * `.refine()` rather than inventing a second validation DSL. */
  validation?: { rule: string; message: string }[];
  /** How to render this command: icon, whether it needs a confirm step, whether
   * it's safe to expose in a "test run" context, etc. */
  presentationHints?: {
    icon?: string;
    confirmBeforeRun?: boolean;
    advanced?: boolean; // hide behind an "Advanced" disclosure by default
  };
  /** What actually happens on the wire when this fires — latency expectations,
   * idempotency, whether it's safe to retry. Informs Automation Debugger UX
   * (e.g. "this command is not idempotent, don't offer a blind retry button"). */
  executionMetadata?: { idempotent: boolean; typicalLatencyMs?: number };
  /** A stable icon reference into Icon.tsx's PATHS map (aureon-web convention) —
   * distinct from presentationHints.icon, which could be a driver-suggested
   * fallback when no curated icon exists yet. */
  iconMetadata?: { iconName: string };
  /** Which Automation Editor palette section(s) this command can appear under. */
  automationGrouping?: ("trigger" | "condition" | "action")[];
  /** Who may author an automation using this command (e.g. gate a lock/security
   * command behind an installer or owner role, never a guest). */
  permissions?: { minRole: "guest" | "member" | "owner" | "installer" };
  /** When this command should be hidden entirely (e.g. a Zone 2 command on a unit
   * whose binding has no Zone 2) — a predicate over the device's own reported
   * capability config, not a separate flag to keep in sync by hand. */
  visibilityRules?: { requiresCapabilityConfigField: string };
}
```

**Worked example** — what a real AVR volume command's metadata might look like,
purely to make the shape concrete (still illustrative, not implemented):

```ts
{
  commandId: "media.volume.set",
  displayName: "Set volume",
  localization: { key: "automation.action.media_volume_set", namespace: "media" },
  category: "media-transport",
  parameterSchema: [
    { name: "volume", kind: "number", range: { min: 0, max: 100, step: 1 }, required: true },
  ],
  presentationHints: { icon: "volume", confirmBeforeRun: false, advanced: false },
  executionMetadata: { idempotent: true, typicalLatencyMs: 150 },
  iconMetadata: { iconName: "volume" },
  automationGrouping: ["action"],
  permissions: { minRole: "member" },
}
```

## Proposed: Driver SDK Maturity Model (documentation only)

A way to talk about "how automation-ready is this driver" without requiring every
driver to jump straight to full Command Metadata. Purely descriptive — no gating
logic, no enforcement, no code.

| Level | Adds | What it unlocks in the Automation Editor (if built) |
|---|---|---|
| **1 — Baseline** | Discovery, `CapabilityState`, `CapabilityCommand` (what every driver in the fleet already has today) | Exactly today's onoff-only authoring — no change |
| **2 — Structural Capability Configuration** | `getCapabilityConfig()` (already real, already implemented by AVR/HEOS/Yamaha/CoolMaster — see [Automation-Editor.md](./Automation-Editor.md) §3) | The editor could offer capability-appropriate *ranges* (e.g. a volume slider bounded by the device's real min/max) without needing new per-driver metadata — the biggest reachable win for the least new surface |
| **3 — Command Metadata + Presentation Hints** | The proposal above | Generic, data-driven forms per command — no more hardcoded `NodeConfig`/`_ConfigSheet` switch per capability |
| **4 — Diagnostics, Validation, Error Recovery** | Structured pre-flight validation (not just "the command threw"), typed recovery hints | The Automation Debugger could distinguish "this action failed because the device is offline" from "the command was malformed" instead of a bare error string |
| **5 — AI Metadata** | Natural-language command descriptions, automation-suggestion hints (e.g. "this device pairs well with a `time` trigger") | Feeds `@supreme/ai`'s drafting (ADR-0005 §2) with richer, driver-sourced context instead of only the capability name |

No driver in this codebase is above Level 2 today (per the audit in
[Automation-Editor.md](./Automation-Editor.md) §3 — only 4 of 22 drivers even
implement `getCapabilityConfig()`). This model is offered as vocabulary for a future
ADR, not as a target any driver is expected to hit.

## Extension points a future editor could expose (documented, none implemented)

- **Custom parameter editors** — a way for a capability to supply its own React/Dart
  widget for a command's parameter (e.g. a color wheel for `color` commands) instead
  of the generic form Level 3's `parameterSchema` would drive. No such registration
  point exists today; the editor's `NodeConfig`/`_ConfigSheet` are closed switch
  statements, not a plugin surface.
- **Driver validation hooks** — a driver-supplied function validating a command's
  parameters against live device state before the automation is saved (e.g. "this
  zone doesn't exist on this unit"). Today, validation is only the DSL's own zod
  schema (structural, not device-instance-aware).
- **Presentation hint providers** — see Command Metadata's `presentationHints`
  above; no provider interface exists.
- **Metadata providers** — a registry a driver could publish Command Metadata
  through, analogous to how `getCapabilityConfig()` is a per-driver method today.
  Not designed beyond "would plausibly mirror the existing optional-method-on-
  `INativeProtocolDriver` pattern," since actually designing it is out of scope here.
- **AI suggestion hooks** — a way for `@supreme/ai`'s planner (ADR-0005 §2) to read
  Level 5 metadata when drafting an automation. No such hook exists; the planner
  today works from capability names alone.

## Explicitly out of scope for this document and this hardening pass

- No schema in `packages/domain-model` or `packages/supreme-contracts` changes.
- No method added to `INativeProtocolDriver` (`services/integration-layer/src/
  protocols/driver.ts`).
- No new extension point is wired up anywhere.
- Nothing here is required for, or blocks, any existing driver, automation, or user
  workflow — it is purely a roadmap for a future, separately-scoped session.
