# 0017 — Capability Normalization & the `color` Capability Model

## Status

Accepted.

## Context

ADR 0016 established that all UI visibility decisions must flow through
`getDeviceUiCapabilities()`, and fixed the concrete bug of a room showing RGB/CCT controls no
device in it supported. It also documented a real architectural compromise: RGB-vs-CCT
disambiguation for the generic `color` capability had no signal except live state nullability
(`colorModes()` in `colormode.ts`), because `ColorState`'s `hue`/`saturation`/`kelvin` fields are
the only place Supreme's domain model carried any hint of which color mode a fixture supports.

That is a capability question wearing a state question's clothes. Runtime state answers "what is
the current value" — it should never be the only way to answer "does this control exist."

## Decision

**Capabilities carry their own structural metadata. State never has to.**

```
Drivers ──▶ Capability Normalization Layer ──▶ Supreme Device Capability Model
                                                          │
                                              Device Registry (DeviceCapability.config)
                                                          │
                                    getDeviceUiCapabilities() / getRoomUiCapabilities()
                                                          │
                                                    Canonical UI
```

### The model: structured config on the existing capability, not a bigger enum

`CapabilityKind` stays exactly as small as it is (`onoff`, `brightness`, `color`, `temperature`,
`position`, `media`, `lock`, `fan`, `vacuum`, `sensor`) — this ADR does **not** explode it into a
`colorRgb`/`colorCct`/`colorRgbw`/… enum, and does not touch `fan`/`media`/`lock`/`position`
(nothing in this session's audit found those needing the same treatment — see "Remaining
technical debt"). `DeviceCapability` already had a `config: Record<string, unknown>` bag for
exactly this purpose (documented since day one as "e.g. min/max kelvin for a color light" —
`entities.ts`). The evolution is giving `color`'s slice of that bag a real, typed shape:

```ts
// packages/domain-model/src/capabilities.ts
export const ColorCapabilityConfig = z.object({
  colorModes: z.object({ rgb: z.boolean(), cct: z.boolean() }).optional(),
  kelvinRange: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
});
```

`colorModes` absent entirely (not `{rgb:false, cct:false}`) means "this driver hasn't adopted
structural reporting yet" — the explicit UNKNOWN mode called for in Step 4. It is NOT collapsed
into a false negative; the UI's existing safe-default fallback (show both) still applies exactly
as it did before this ADR.

### Capability Normalization Layer: one instance per driver

Each driver translates its own protocol's real, structural signal — never a state
snapshot — into this shape, in its own codec module (the ONE place per driver that knows its
wire format, mirroring the existing `casambi-codec.ts` pattern). Implemented this round:

```ts
// services/protocols/src/casambi-codec.ts
export function colorConfigFromUnit(u: CasambiUnit): { colorModes: { rgb: boolean; cct: boolean } } | undefined {
  if (!hasControl(u, "color", "rgb", "xy", "cct", "colortemperature")) return undefined;
  return { colorModes: { rgb: hasControl(u, "color", "rgb", "xy"), cct: hasControl(u, "cct", "colortemperature") } };
}
```

Casambi's `unit.controls[]` array is a property of the FIXTURE's advertised control set, part of
the network model returned by discovery — not a live measurement. The equivalent signal exists
in every protocol this ADR is designed for: a KNX DPT number encodes RGB vs. tunable-white
statically; a Zigbee cluster exposes a `ColorCapabilities` bitmap; a Matter `ColorControl`
cluster's `ColorCapabilities` attribute is likewise static; DALI-2 Part 209/8 device types
distinguish colour-type members explicitly. **The UI never sees any of this vocabulary** — every
driver's codec normalizes it down to the same `{ rgb, cct }` shape before it ever reaches
`getDeviceUiCapabilities()`.

### The shared UI helper: config first, state as fallback only

```ts
// apps/web-homeowner/src/device-ui-capabilities.ts
const structuralModes = colorCap?.config?.colorModes;
const modes = !hasColor ? { rgb: false, cct: false } : structuralModes ?? colorModes(colorState);
```

`colorModeConfirmed` on the returned object is `true` only when the structural path was used —
surfaced for a future page that might want to show "confirmed" vs. "best guess," not currently
used to hide anything.

## Backward compatibility & migration

No breaking change, anywhere:

- `ColorCapabilityConfig`'s `colorModes` field is `optional()` — every existing persisted device
  and every driver that hasn't been touched keeps returning `config: {}`, which is
  indistinguishable from "not yet adopted" and falls straight to the pre-existing state-inference
  path.
- `DiscoveredDevice.capabilityConfig` (integration-layer), `DiscoveredView.capabilityConfig`
  (commissioning), and `commissionDevice()`'s `capabilityConfig` parameter (gateway) are all
  optional additions threaded alongside existing fields — a driver/call site that doesn't supply
  them behaves exactly as before.
- Migration path: **Compatibility adapter today, native adoption over time.** A driver that
  doesn't populate `capabilityConfig` gets the compatibility adapter for free — it's just the
  absence of the field, handled by the same fallback that already existed. A driver adopts the
  richer model by implementing one `colorConfigFromUnit`-shaped function in its own codec and
  populating `capabilityConfig.color` at discovery time. No flag day, no forced migration, no
  driver breaks by not adopting it immediately.

## Consequences

- Casambi (the one real driver in this codebase with a genuine RGB/CCT ambiguity in its protocol
  model) now reports structural color-mode metadata end-to-end: `casambi-driver.ts`'s
  `discover()` → `DiscoveredDevice.capabilityConfig` → `commissioning`'s `view()`/`commission()`
  → `installer-context`'s auto-commit fast path (`scanForApproval`) → the persisted device's
  `color` capability's own `config.colorModes` → `getDeviceUiCapabilities()` reads it directly,
  with zero state ever consulted.
- KNX has no genuine ambiguity to normalize away: `services/protocols/src/knx/capability-mapper.ts`
  already emits `color` only for RGB(W) group-address sets and a separate absence of `color` for
  tunable-white-only fixtures reported as `brightness` + a distinct DPT — there was nothing to
  fix there for THIS ADR's specific problem (documented, not assumed).
- Matter, Zigbee, DALI, BACnet, Modbus: no driver for these protocols exists yet in this
  codebase. The model is designed to accept their real capability bitmaps/DPTs when those
  drivers are built — see the tests, which prove the UI helper treats a "Matter-shaped" and a
  "Zigbee-shaped" structural config identically to a Casambi-shaped one, with no protocol
  branching anywhere in the consuming code.

## Remaining technical debt (disclosed, not silent)

- The Pending Approval path (`approvePendingDevice`, reading from the persisted
  `pending_devices` table) does **not** carry `capabilityConfig` forward — that would need a new
  migration column, out of scope this round. Devices approved through that path still fall back
  to state inference. Only the auto-commit fast path (same-tick, no persistence round-trip) has
  the structural signal wired end-to-end.
- The manual "Discover Devices" page's per-device "Pair device" flow (`discover.tsx` →
  `client.commission()`) does not thread `capabilityConfig` through the `CommissionRequest`
  wire contract yet — another disclosed gap, same underlying reason (time-boxed scope this
  round, not an architectural blocker).
- No other capability family (`fan`, `media`, `lock`, `position`) was found during this session's
  audit to have the same "one generic kind hiding real sub-variants with no structural signal"
  problem `color` had — if one is found later, it follows the exact same pattern: a typed
  `<Capability>Config` schema slice, a driver-side normalization function, a UI helper field that
  prefers config over any state-based guess.
