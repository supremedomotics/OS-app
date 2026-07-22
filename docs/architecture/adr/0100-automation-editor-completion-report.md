# ADR 0100 — Automation Editor Completion Report

**Scope:** the Automation Editor's capability-driven rendering layer
(`apps/web-homeowner/src/automations.tsx` + `automation-capability-fields.ts`) — the client-side
UI that lets a homeowner/installer build Triggers, Conditions, and Actions for an Automation.
This report covers implementation work only; it does not revise, extend, or supersede ADR 0100
itself, ADR 0016–0021, the Runtime Object model, the Automation Engine, the Capability Model, or
the Driver SDK. Those remain **locked**, exactly as every prompt in this workstream required.

**Distinct from:** `0100-certification-report.md`, which is a pre-implementation architecture QA
pass over the Automation Engine as a whole (triggers/conditions/actions execution semantics,
failure modes, scale). This report is post-implementation and scoped narrowly to the editor UI
that authors automations against that already-certified engine.

---

## 1. Implemented Architecture

The editor renders every Trigger/Condition/Action control from a closed, capability-keyed
vocabulary — never from device type, manufacturer, or protocol:

- **`CommandDefinition`** — one entry per real `CapabilityCommand` verb (`onoff.on`, `onoff.off`,
  `onoff.toggle`, `color.set`, `media.volume`, …), each owning its own parameter list. Mirrors
  `packages/domain-model/src/capabilities.ts`'s discriminated union member-for-member — no shared
  param pool filtered post-hoc by whichever verb happens to be selected.
- **`STATE_FIELDS`** — the parallel, deliberately separate vocabulary for what a capability
  *reports* (drives Triggers/Conditions), since "what you can set" and "what you can read" are
  genuinely different surfaces on the same capability (e.g. `ambientC` is state-only).
- **Presentation hints (`Widget`)** — `toggle`, `slider`, `colorWheel`, `cctSlider`,
  `volumeSlider`, `fanSelector`, `chips`, `duration`, `select`, `text`. One dispatch point
  (`FieldControl`) turns a hint into a control; `chips` and `fanSelector` deliberately share one
  underlying component (`ChipSelector`) since they're the same visual pattern for two different
  semantic intents — implemented once, not forked.
- **Per-device narrowing** — `resolveNarrowingContext(device, kind)` computes what ONE specific
  device actually supports (today: RGB vs. CCT vs. both, and a device's own reported Kelvin
  range) in a single lookup, reusing `getDeviceUiCapabilities()` — the SAME resolver every other
  page in the app already uses for this, so the editor can never disagree with a device detail
  page about what a light supports.
- **Domain-specific widgets** — `ColorWheel` (joint hue/saturation, rendered only when both
  survive narrowing together), `CctSlider` (warm↔cool gradient, bounded to the resolved Kelvin
  range), `VolumeSlider`, `DurationPicker` (mm:ss), `ChipSelector` (segmented buttons).
- **Live natural-language summary** (`summarizeAutomation`) — generated from the exact same node
  data the visual canvas renders, shared phrase-builders (`describeCommand`,
  `describeFieldCondition`) so the summary and the canvas chips can never describe the same node
  differently.

## 2. Final Resolution Chain

```
1. Driver Command Metadata     (opt-in, config.commandMetadata — no driver publishes this today)
        ↓ absent
2. Capability Structural Config (config.colorModes / config.kelvinRange — color capability only)
        ↓ absent
3. Live-State Inference          (colormode.ts nullability inference — color capability only)
        ↓ inconclusive
4. Static Capability Table       (STATE_FIELDS / COMMAND_DEFINITIONS — always renders)
```

Full rationale (why each tier exists, why the fallback is required, expected future evolution)
is documented in
[`docs/architecture/automation-editor-field-resolution.md`](../automation-editor-field-resolution.md).
Tier 1 is a real, tested code path (`readCommandMetadata`) with zero current producers — it
exists so a future driver can adopt it without any editor change, not as aspirational dead code:
[`automation-capability-fields.test.ts`](../../../apps/web-homeowner/src/automation-capability-fields.test.ts)
exercises it directly (a fabricated `commandMetadata` payload does override tiers 2–4).

## 3. Testing Strategy

| File | Tests | Covers |
|---|---|---|
| `automation-capability-fields.test.ts` | 18 | All 4 resolution tiers (incl. tier-1 override + malformed-metadata fallthrough), RGB/CCT/both/none narrowing, Kelvin-range override, sensor read-only invariant, command-definition shape (one verb = one definition, zero-verb capabilities have exactly one `action: null` definition), presentation-hint internal consistency (every `cctSlider` field declares min+max, every `chips`/`fanSelector` field declares real `enumValues`). |
| `device-ui-capabilities.test.ts` | 22 | The shared `getDeviceUiCapabilities()`/`getRoomUiCapabilities()` matrix the editor's tier-2/3 narrowing depends on (pre-existing, not written this workstream, but load-bearing for the editor's correctness). |

**Total: 40 passing tests**, `pnpm --filter web-homeowner typecheck` clean, production `build`
clean. No test is protocol-specific, because no code under test is protocol-specific — coverage
is expressed entirely in terms of `CapabilityKind`/`NarrowingContext`, which is the same
guarantee that makes the editor itself protocol-agnostic.

## 4. Developer Documentation

- [`docs/architecture/automation-editor-field-resolution.md`](../automation-editor-field-resolution.md)
  — the resolution chain, how drivers influence UI, how capability config works, how live-state
  inference works, how presentation hints work, how future drivers should publish metadata, the
  Driver Command Metadata Contract (examples only, §3), Driver SDK maturity levels (§4), and the
  future roadmap (§6) — all cross-referenced above.
- In-code: `automation-capability-fields.ts`'s module header and the `NarrowingContext`/tier
  functions carry the same explanation inline, so a reader never has to leave the source to
  understand why a given lookup order exists.

## 5. Known Limitations

Listed honestly rather than silently — none of these are regressions, they're places the real
`CapabilityState`/`CapabilityCommand` schema (or the real driver layer) doesn't yet carry data
the editor could render:

1. **No camera, energy-meter-specific, or Apple-TV-specific capability kinds.** The real
   `CapabilityKind` union has 10 members (`onoff`, `brightness`, `color`, `temperature`,
   `position`, `media`, `lock`, `fan`, `vacuum`, `sensor`); AVR/Apple TV/media-player behavior is
   expressed through `media`+`onoff` combinations, energy through `sensor`. Fields explicitly
   requested in earlier prompts but absent from the real schema (curtain tilt, lock
   latch/auto-lock-delay, AVR zones/listening-mode, TV channel/apps/picture-mode) were
   deliberately **not** added — doing so would mean fabricating capability data, which this
   codebase treats as a hard rule (`CLAUDE.md`: "never fabricate data or capabilities").
2. **Tier 1 (driver command metadata) has zero live producers.** The code path is tested and
   correct, but no shipped driver populates `config.commandMetadata` yet — narrowing today
   effectively always resolves at tier 2/3/4. This is expected, not a defect (§9 of the
   resolution-chain doc).
3. **`step` (slider granularity) is only set where it meaningfully matters** (Kelvin: 50). Most
   percent/number fields default to `step={1}` implicitly rather than an explicitly authored
   value — harmless, but future authors should set it explicitly for any new field where 1-unit
   granularity is wrong.
4. **Production bundle exceeds Vite's 500KB chunk-size warning** (~1.12MB / 330KB gzipped for the
   whole `web-homeowner` app, not the editor specifically). Pre-existing, not introduced or
   worsened by this workstream; flagged here only because it surfaces in every build log touched
   during this work. Code-splitting is a reasonable future improvement but was correctly out of
   scope for a "no runtime behavior change" hardening pass.
5. **No production live-testing this session.** Sign-in credentials for the sandboxed browser
   used in this workstream were never available, so verification relied on typecheck/unit
   tests/production build + container health checks rather than a driven click-through of the
   editor. Recommend a manual pass (or a Playwright suite with real credentials) before the next
   release.

## 6. Deferred Items — Future Driver SDK Command Metadata

**Explicitly deferred, not implemented, and not part of ADR 0100:**

- A formalized, versioned schema for `config.commandMetadata` (id, display name, category,
  parameters, validation, presentation hints, execution metadata, localization, icon — full
  illustrative shape in the resolution-chain doc §3).
- Driver SDK tooling to validate a driver's published command metadata against that schema.
- Any official driver actually adopting it.
- Levels 4 (Diagnostics/Validation/Error Recovery) and 5 (AI Metadata/Automation
  Suggestions/Natural-Language Examples) of the documented Driver Maturity ladder — recorded for
  completeness, not consumed by the editor today, and level 5 explicitly feeds a future
  AI-assisted authoring surface outside the current DSL-based editor.

These are **Driver SDK** roadmap items. The editor already fully supports tier 1 consumption
today (§2 above) — the missing piece is entirely on the driver-authoring side. No editor code
change is anticipated when this work eventually happens; that is the point of having built the
resolution chain against the full four-tier contract up front.

## 7. Completion Checklist

| # | Item | Status |
|---|---|---|
| 1 | Every Trigger/Condition/Action control renders from capability/command definitions, never device-type branching | ✅ |
| 2 | Per-device narrowing (RGB/CCT, Kelvin range) matches every other page's resolution (`getDeviceUiCapabilities`) | ✅ |
| 3 | 4-tier resolution chain implemented, tested, and documented (driver metadata → structural config → live-state → static table) | ✅ |
| 4 | Presentation hints cover every domain-specific control requested (color wheel, CCT slider, volume slider, fan/chip selectors, duration picker) | ✅ |
| 5 | Dead code removed (`parseFieldValue`), duplicate lookups eliminated (`resolveNarrowingContext` single-pass), duplicate render logic deduplicated (`kindsForNode`) | ✅ |
| 6 | Type safety strengthened (`NarrowingContext`, exported `KelvinRange`, no positional-arg ambiguity) | ✅ |
| 7 | 40 tests passing (18 new + 22 pre-existing dependency), zero regressions | ✅ |
| 8 | Developer documentation covering rendering flow, capability config, live-state inference, presentation hints, and the future contract | ✅ |
| 9 | `pnpm --filter web-homeowner typecheck` clean | ✅ |
| 10 | Production `build` clean | ✅ |
| 11 | Zero runtime/architecture changes — ADR 0016–0021, ADR 0100, Runtime Objects, Runtime Events, Automation Engine, Capability Model, Driver SDK all untouched | ✅ |
| 12 | Backward compatible — every existing driver, automation, and stored command continues to work unmodified | ✅ |
| 13 | Live production click-through verification | ⚠️ Not performed this session (see Limitation 5) — recommended before next release |

**Verdict: ADR 0100's Automation Editor is COMPLETE and PRODUCTION-READY, FROZEN pending the one
open item above (#13, a verification gap, not an implementation gap).**

## 8. Recommendations for Future Work (non-modifying)

These are recommendations only — none require or imply any change to the current implementation:

1. **Live-verify the editor** in a real browser session with valid credentials against at least
   one real driver of each maturity level currently in production (KNX, Casambi, Home Assistant)
   before the next release ships, closing checklist item #13.
2. **Prototype tier 1 on one real driver** (Casambi is the strongest candidate — it already
   exposes `colorModes`/`kelvinRange` at tier 2, and its scene/group model plausibly maps onto a
   handful of real named commands) as a proof of the Driver Command Metadata Contract before
   formalizing it SDK-wide.
3. **Track `step` authoring as a lint-style convention**, not a required field — encourage future
   `FieldDef`/`CommandDefinition` authors to set it explicitly for anything coarser than 1-unit
   granularity, rather than relying on the implicit default.
4. **Revisit bundle size** for `web-homeowner` as a whole (not editor-specific) via
   `manualChunks`/dynamic `import()` the next time meaningful new UI surface is added — flagged,
   not urgent, and explicitly out of scope for this hardening pass.
5. **When the Driver SDK actually adds command metadata support**, re-run
   `automation-capability-fields.test.ts` unmodified against a real driver-supplied payload as an
   integration smoke test — the unit tests already prove the resolver accepts and prioritizes it
   correctly using a synthetic payload; a real one is the natural next validation step.

---

*This report certifies implementation completeness of the Automation Editor's capability-driven
rendering layer only. It does not certify, modify, or re-open ADR 0100's Automation Engine
architecture, which remains governed by `0100-automation-engine.md` and
`0100-certification-report.md`.*
