# 0016 — Capability-Driven UI Architecture

## Status

Accepted.

## Context

Multiple frontend pages independently re-derived "does this device/room support control X"
from raw `device.capabilities` arrays (`device.capabilities.some(c => c.kind === "color")`,
`.find(c => c.kind === "temperature")`, etc.). Each re-derivation was a chance to get it wrong.

One concretely did: `room-lighting.tsx`'s room-aggregate RGB/CCT computation read
`stateOf(d).color` for every light in the room, including lights with no `color` capability at
all. A light with no color capability has no color state to read, so `colorOf(d)` returned
`undefined` — and the color-mode disambiguation helper's documented "state not seen yet, assume
both" safe default (correct for a light that DOES have `color`) fired for lights that never had
the capability in the first place. The result: a Kitchen room with two plain onoff/brightness
lights showed a colour wheel and CCT slider that no device in the room could act on. The
individual `LightingDetail` page had the correct gate; the room aggregate did not — because
each page owned its own copy of the check instead of sharing one.

## Decision

**All UI visibility decisions must originate from `getDeviceUiCapabilities()` (per device) or
`getRoomUiCapabilities()` (per room), both in `apps/web-homeowner/src/device-ui-capabilities.ts`.
No component may independently inspect a `capabilities` array to decide whether a control is
visible.**

```
Device.capabilities ──▶ getDeviceUiCapabilities() ──▶ every UI surface
                                    │
Room's devices ──▶ [per-device result] ──▶ getRoomUiCapabilities() ──▶ Room UI
```

### Capability vs. state — kept strictly separate

- **Capability** answers "what controls exist." Source: `device.capabilities` (structural
  presence), full stop. Missing state never removes a capability-backed control; a driver that
  hasn't reported a value yet still gets to show the control, with a sensible placeholder/default
  value.
- **State** answers "what value does that control currently show." Source: `device.state` /
  live-merged state. Never consulted to decide *whether* to render a control — only *what* to
  render inside it once shown.

**One narrow, documented exception:** Supreme's capability vocabulary has a single generic
`color` kind with no separate static metadata for "RGB-only / CCT-only / both" — there is no
other place in the domain model that carries this distinction. `colorModes()` (`colormode.ts`)
uses live state nullability as a proxy for that split, because every driver's codec structurally
nulls the field a fixture doesn't have. This is the ONE flag pair (`showRGB`/`showCCT`) where
state participates in the capability answer, and it still obeys "never hides a capability the
device doesn't have": a device without `color` at all always resolves both to `false`
regardless of state; a device WITH `color` and no state at all shows both (the safe default,
never neither).

### Room-level aggregates never bypass the per-device layer

`getRoomUiCapabilities()` takes an array of already-computed `DeviceUiCapabilities` — it never
re-reads raw capability arrays itself. A room-wide control is shown when at least one device in
the room supports it; a room-wide command still only targets devices whose OWN flag is true
(`perDevice.filter(d => d.showRGB)`, never "all lights in the room").

### What this helper does NOT replace

- `features/_shared/capability-availability.ts` (`capabilityAvailability()`) answers a narrower,
  complementary question — "is this *specific* control's config field present," with a
  installer-facing reason string ("Driver required" / "Not supported by current driver"). It
  stays the mechanism for the Premium Device Experience pages' `CapabilityGate`/`CapabilityGrid`.
- `features/*/capability-mapper.ts` files (Media, Security, Energy) classify device *subtype*
  from capability + installer-entered metadata (e.g. "is this a TV or a speaker") — a different,
  deeper concern than simple control visibility, and already governed by `CLAUDE.md`'s permanent
  feature-module pattern.
- Deep per-capability config extraction (e.g. reading `temperature` capability's `config.modes`
  for a climate schedule, or `media` capability's `config.inputs` for an AVR input list) is not a
  visibility boolean and stays local to the page that needs that specific config shape.

## Consequences

- `lighting.tsx`, `room-lighting.tsx`, `device-detail-router.tsx` (the canonical router's own
  `isLight`/`isClimate`/`isLock`/`isMedia` dispatch), `lighting-page.tsx`, `climate.tsx`,
  `climate-console.tsx`, `media.tsx`, `screens.tsx`, and `advanced.tsx` now all derive visibility
  through the shared helper.
- A future page adding a new capability-gated control gets the correct behavior by construction,
  not by remembering to copy an existing check correctly.
- `apps/web-homeowner/src/device-ui-capabilities.test.ts` is the capability matrix — the single
  fixture protecting this rule went forward; a regression in any consumer's visibility shows up
  there even before a live page is opened.
