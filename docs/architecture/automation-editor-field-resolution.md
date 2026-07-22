# Automation Editor — Field Resolution, Command Metadata & Driver Maturity

> **Status:** Living reference doc for `apps/web-homeowner/src/automation-capability-fields.ts`
> and `automations.tsx`. Documentation only — nothing in this file describes unimplemented
> behavior as if it were live. Sections marked **Future** are explicitly not built; this is the
> recommended shape for when they are.
>
> **Scope note (§ ADR 0100 Production Hardening):** this doc does not redesign ADR 0016–0021 or
> ADR 0100, the Runtime Object model, the Automation Engine, the Capability Model, or the Driver
> SDK. It documents how the existing, shipped Automation Editor already behaves, and lays out
> where the Driver SDK — not the editor — should grow next.

## 1. How Automation Rendering Works

The Automation Editor never branches on device type, manufacturer, or protocol. Every
trigger/condition/action control it renders comes from two closed vocabularies already owned by
`packages/domain-model/src/capabilities.ts`:

- **`CapabilityState`** — what a capability reports (drives the Trigger/Condition builder).
- **`CapabilityCommand`** — what a capability accepts (drives the Action builder).

`automation-capability-fields.ts` mirrors both, member-for-member, as `STATE_FIELDS` (a
`FieldDef[]` per `CapabilityKind`) and `COMMAND_DEFINITIONS` (a `CommandDefinition[]` per kind —
one definition per real command verb, e.g. `onoff.on` / `onoff.off` / `onoff.toggle` are three
separate definitions, not one shared field list filtered after the fact). A `CommandDefinition`'s
`params` are that verb's OWN parameters — never a param pool shared across verbs and narrowed
post-hoc by `forActions`-style filtering (an earlier iteration of this file did that; it was
refactored away because it made "what does this verb actually take" a two-step lookup instead of
one).

`automations.tsx`'s `CapabilityActionFields`/`CapabilityStateFields` components pick a device →
enumerate its `device.capabilities[].kind` → resolve THAT device's real field/command list (see
§2) → render one `FieldControl` per field, dispatching on a `widget` presentation hint (§ How
Presentation Hints Work). Nothing here is capability-*type*-specific code — `media`, `fan`,
`vacuum`, and any future kind added to the closed `CapabilityKind` union all flow through the
exact same components.

## 2. How Drivers Influence UI — the Field Resolution Chain

`resolveStateFields(kind, ctx)` / `resolveCommandDefinitions(kind, ctx)` narrow a capability's
full static surface down to what ONE specific device actually supports, checking four sources in
strict priority order. Each tier exists to answer a question the tier below it can't:

```
1. Driver Command Metadata     "did the driver already tell us, completely and precisely?"
        ↓ (not present)
2. Capability Structural Config "did the driver tell us SOMETHING, even if not everything?"
        ↓ (not present)
3. Live-State Inference          "the driver told us nothing structural, but state proves something"
        ↓ (not present / inconclusive)
4. Static Capability Table       the capability's full generic surface — always renders, never wrong,
                                  just not narrowed to this one device
```

### Tier 1 — Driver Command Metadata

An **opt-in** convention: a driver may populate `DeviceCapability.config.commandMetadata` with a
`{ commands?: CommandDefinition[]; stateFields?: FieldDef[] }` object. When present, it is treated
as this specific device's complete, authoritative description — used verbatim, no further
narrowing. **No driver publishes this today.** The tier exists so a future driver can skip tiers
2–4 entirely once it does; see §3 for the recommended (not implemented) full contract.

*Why it's tier 1:* a driver that bothers to publish rich metadata is, by definition, telling the
truth about exactly what its device supports — there's nothing left to infer.

### Tier 2 — Capability Structural Config

Narrower, capability-specific signals a driver can populate today without adopting full command
metadata — currently only `color`'s `colorModes: { rgb, cct }` and `kelvinRange: { min, max }`
(§ ADR 0017 `ColorCapabilityConfig`), set at **discovery time** from the driver's real protocol
model (e.g. Casambi's `colorConfigFromUnit()` reading the unit's advertised controls). This is
the same signal `device-ui-capabilities.ts`'s `getDeviceUiCapabilities()` already resolves for
every other page (device cards, detail pages) — the Automation Editor reuses that exact function
rather than re-deriving RGB/CCT itself, so there is exactly one place in the app that knows how
to tell them apart.

*Why it's tier 2, not tier 1:* it answers ONE narrow question ("is this RGB, CCT, or both?"), not
"describe this device's entire command surface."

### Tier 3 — Live-State Inference

When a driver hasn't populated structural config, `colormode.ts`'s `colorModes()` infers RGB vs.
CCT from **nullability in the device's last reported state**: if `hue`/`saturation` are non-null
but `kelvin` is null, the device is demonstrably RGB-only, regardless of what its driver ever
declares. This is strictly weaker than tier 2 — it needs at least one real state report to work,
and (documented in `colormode.ts`) can't distinguish "never reported yet" from "genuinely
unsupported," so the safe default when state is entirely absent is "show both."

*Why it's tier 3, not tier 2:* it's evidence, not a declaration — a device that has simply never
been switched on yet looks identical to one that doesn't support the missing field at all.

### Tier 4 — Static Capability Table

The unnarrowed `STATE_FIELDS[kind]` / `COMMAND_DEFINITIONS[kind]`. Always renders something,
never wrong (every field listed IS a real field that capability's real schema carries), just not
narrowed to one specific device. This is the floor every driver gets automatically, with zero
opt-in — a brand-new driver that implements nothing beyond `discover()`/`command()`/`getState()`
still gets a fully working, if unnarrowed, automation editor on day one.

### Why the fallback chain is required at all

Drivers are added incrementally and by third parties over the product's lifetime; the editor
cannot require every driver to reach the richest tier before it becomes usable. Each tier is a
strictly-optional enhancement over the one below it — removing any tier's data source degrades
the UI to the next tier down, never to a broken or empty state.

### Expected future evolution

As official drivers adopt tier 1, the chain's *shape* doesn't change — it's used less deep, more
often, for more capabilities. Tiers 2–4 remain the permanent compatibility floor for any driver
that never adopts tier 1 (third-party/community drivers, legacy protocols with no natural
"command metadata" concept like KNX group addresses). See §6 Roadmap.

### `NarrowingContext` — one lookup, not three

`automations.tsx`'s `resolveNarrowingContext(device, kind)` computes tiers 2–3 (and carries the
raw config tier 1 needs) in a **single** `device.capabilities.find()` pass, returned as one
`{ modes?, kelvinRange?, config? }` object consumed by both resolver functions. This replaced an
earlier version that called two separate helpers (`colorNarrowingFor` + `configFor`), each doing
its own array scan, at every one of the four call sites that need this data — a real, measured
duplicate-lookup removal, not a hypothetical one.

## 3. Command Metadata Contract — Recommended Future Shape (documentation only, NOT implemented)

This section describes the recommended shape for tier 1 (`config.commandMetadata`) so a future
Driver SDK change has a concrete target. **No schema changes are proposed here** — this stays
inside the existing free-form `DeviceCapability.config: z.record(z.unknown())` bag, exactly like
`colorModes`/`kelvinRange` already do.

```ts
// Illustrative only — not a real exported type today.
interface DriverCommandMetadata {
  commands: DriverCommandDef[];
  stateFields?: DriverStateFieldDef[];
}

interface DriverCommandDef {
  /** Stable id, e.g. "color.set" — the capability's real discriminant + verb. */
  id: string;
  /** Homeowner-facing name, e.g. "Set color". */
  displayName: string;
  /** Grouping hint for a future command palette — e.g. "lighting", "climate", "media". */
  category?: string;
  parameters: DriverParamDef[];
  /** Optional cross-field validation beyond per-param min/max/enum (e.g. "targetLowC must be
   * less than targetHighC"), expressed however the future contract settles on — JSON Schema,
   * a small expression DSL, etc. Deliberately unspecified here; needs its own design pass. */
  validation?: unknown;
  /** How long this command typically takes, whether it's idempotent, whether it can be
   * cancelled mid-flight — informs retry/timeout UX without the editor guessing. */
  execution?: { typicalDurationMs?: number; idempotent?: boolean; cancellable?: boolean };
  /** i18n key namespace so displayName/param labels can be localized without the editor
   * hardcoding a translation table per driver. */
  localizationKey?: string;
  /** Icon reference into the SAME icon system every other Aureon surface uses
   * (`packages/aureon-web/src/components/Icon.tsx`) — never an ad hoc image URL. */
  icon?: string;
}

interface DriverParamDef {
  key: string;
  displayName: string;
  type: "boolean" | "number" | "enum" | "string";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  required?: boolean;
  enumValues?: { value: string; displayName: string }[];
  /** Presentation hint — the SAME closed vocabulary `Widget` already uses
   * (`toggle` | `slider` | `colorWheel` | `cctSlider` | `volumeSlider` | `fanSelector` |
   * `chips` | `duration` | `select` | `text`), so a driver publishing metadata renders through
   * the EXACT SAME widget components as the static table — never a driver-specific renderer. */
  presentationHint?: string;
}
```

**Design intent, not implementation:** a driver publishing this would let `resolveStateFields`/
`resolveCommandDefinitions` return it verbatim (tier 1 already does this — see §2). The
`presentationHint` field intentionally reuses the existing `Widget` union rather than inventing a
parallel one, so day-one tier-1 adopters get the SAME color wheel / CCT slider / chip selector
every tier-4 capability already renders through.

## 4. Driver SDK Maturity Levels (documentation only)

A recommended, non-binding maturity ladder for driver authors — each level is additive over the
one below it, and every level already works end-to-end with the shipped Automation Editor via
the fallback chain in §2.

| Level | Capabilities | Automation Editor behavior |
|---|---|---|
| **1 — Baseline** | `discover()`, `getState()`, `command()` | Full static-table editor (tier 4). Every real capability the device reports is fully editable, unnarrowed. |
| **2 — Structural Config** | Populates `DeviceCapability.config` (e.g. `colorModes`, `kelvinRange`) at discovery time | Tier 2 narrowing — RGB/CCT-correct color controls, device-accurate Kelvin range, without any state ever having been observed. |
| **3 — Command Metadata & Presentation Hints** | Populates `config.commandMetadata` (§3) | Tier 1 — the editor renders the driver's own command list/labels/hints directly; the static table becomes a pure fallback for capabilities the driver didn't describe. |
| **4 — Diagnostics, Validation, Error Recovery** | Structured command failure reasons, retry/backoff hints, live health surfaced per-command | Not consumed by the Automation Editor today — this level is about the Driver SDK's own diagnostics surface (`services/*/diagnostics`), listed here for completeness of the ladder, not as an editor requirement. |
| **5 — AI Metadata** | Natural-language command descriptions, suggested automations, example phrasings | Feeds a future AI-assisted automation authoring surface, NOT the current DSL-based editor. Explicitly out of scope for ADR 0100. |

Levels 1–3 are the only ones the current Automation Editor's resolution chain consumes (they map
directly onto tiers 4/2/1 respectively). Levels 4–5 are recorded here so a driver author has a
single reference for "how far could this go," not because the editor requires them.

## 5. Developer Reference

### How Capability Config Works
`DeviceCapability.config: Record<string, unknown>` (already free-form in the domain model) is
the ONE place a driver attaches structural, discovery-time metadata about a capability. Today
only `color` uses it (`colorModes`, `kelvinRange`); §3's `commandMetadata` convention would live
in the same bag under its own key. Adding a new config key is never a schema change.

### How Live-State Inference Works
See §2 Tier 3 and `colormode.ts`'s own doc comment. Only applies to `color` today (RGB vs. CCT);
there is no equivalent inference for other capabilities because no other capability has a
comparable "state nullability implies unsupported field" signal.

### How Presentation Hints Work
`FieldDef.widget` is a closed union (`Widget` in `automation-capability-fields.ts`). `FieldControl`
in `automations.tsx` is the single dispatch point — one `widget` value always renders the same
component everywhere in the app (a `chips`-hinted enum and a `fanSelector`-hinted enum literally
share one `ChipSelector` component; they're different semantic names for the same control because
"Mode → Chips" and "Fan Speed → Selector" are different *intents* that happen to look identical).
Every widget degrades to its `type`'s generic control if the hint doesn't apply post-narrowing
(e.g. a `colorWheel`-hinted `hue` param that got dropped by tier 2 narrowing simply never renders
— there's no broken half-state).

### How Future Drivers Should Publish Metadata
1. Do nothing — Level 1 already works.
2. Populate `DeviceCapability.config` with whatever structural signal is cheap to get from your
   protocol at discovery time (Level 2).
3. If/when the Driver SDK formalizes §3's contract, populate `config.commandMetadata` (Level 3).
   Until then, do not hand-roll a driver-specific `commandMetadata` shape — it won't be consumed
   any differently by today's editor than tier 2/3/4 already are, and risks needing a breaking
   migration once the real contract lands.

## 6. Future Roadmap

```
Current:
  Driver → Capability Config → Live-State Inference → Automation Editor

Future (NOT part of ADR 0100 — a Driver SDK enhancement):
  Driver → Typed Command Metadata → Presentation Hints → Automation Editor
```

This is a **Driver SDK** roadmap item, not an Automation Editor one. The editor already fully
supports tier 1 today (§2) — the missing piece is entirely on the driver-authoring side: a
formalized, versioned `commandMetadata` schema (§3), SDK tooling to validate it, and official
drivers adopting it. No editor code changes are anticipated as part of that future work; this is
precisely the point of the resolution chain existing — the editor was built once, against the
full four-tier contract, before any driver needed tier 1.

## 7. Validation

The resolution chain, presentation hints, and command definitions are protocol-agnostic by
construction (keyed on `CapabilityKind`, never on protocol/manufacturer/device type), so they
apply uniformly to every current and future integration surface: KNX, Matter, Casambi, Home
Assistant, Zigbee, DALI, virtual/test devices, and any future driver — including composite
device classes like AVRs, Apple TV, climate systems, and media players, all of which are
expressed as combinations of the same closed `CapabilityKind` set (`media` + `onoff` for an AVR,
`temperature` + `fan` for HVAC, etc.), never as a bespoke device-type branch in the editor.
`apps/web-homeowner/src/automation-capability-fields.test.ts` and
`device-ui-capabilities.test.ts` cover the resolver/narrowing logic directly; no protocol-specific
test fixtures exist because none of this code path is protocol-specific.
