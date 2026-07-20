# Universal AV Driver SDK — Developer Guide

> Reference documentation for the framework built across ADR 0015 and its 2026-07-19
> addendum, hardened by `docs/architecture/avr-framework-production-audit.md`. This
> doc explains what each piece IS and how they fit together; for the step-by-step
> "how do I add a new brand" walkthrough, see `docs/architecture/adding-avr-brands.md`
> — that doc plus this one together should be enough to implement a new AV driver
> without reading the driver source first.

## 1. What this SDK actually is

**Updated 2026-07-20**: when this section was first written, "no separate AVR
engine" meant the shared modules below were the entire story — genuinely true at
the time, but read literally it could be mistaken for "there is no runtime SDK at
all," which a later architecture-verification pass confirmed was NOT quite
accurate either way: there was no *speculative* engine-shaped abstraction layer
(still true, see below), but there also wasn't yet a real `av-sdk/` module for the
one piece of AV-specific logic that actually WAS duplicated (TCP transport
plumbing). That gap has since been closed by a full evidence-based duplication
audit — see [Universal-AV-SDK.md](./Universal-AV-SDK.md) for the complete story,
including exactly what was and wasn't built and why.

There is still no separate "AVR engine" in the sense of a new abstraction layer
routing between drivers and their transports. Every AV driver is a thin,
protocol-specific implementation of the SAME seam every one of the 22 drivers in
this fleet implements — `INativeProtocolDriver`
(`services/integration-layer/src/protocols/driver.ts`). The "SDK" is the set of
SHARED modules that make implementing that seam for a new AV brand fast and
consistent, not a new abstraction layer above it:

| Concern | Shared module | Used by |
|---|---|---|
| Pooled reconnecting line-buffered TCP transport | `services/protocols/src/av-sdk/tcp-line-transport.ts` (`TcpLineTransport`) | AVR, HEOS |
| Capability-state record/dedupe/dispatch | `services/protocols/src/av-sdk/state-cache.ts` (`recordCapabilityState`) | AVR, HEOS, Yamaha |
| Reconnect (capped exponential backoff) | `services/protocols/src/avr-reconnect.ts` (`ReconnectScheduler`) | AVR, HEOS (via `TcpLineTransport`) |
| Diagnostics counters | `services/protocols/src/driver-diagnostics.ts` (`DriverDiagnosticsTracker`) | AVR, HEOS (via `TcpLineTransport`), Yamaha (direct) |
| Bounded line buffering | `services/protocols/src/line-buffer.ts` (`LineAccumulator`) | AVR, HEOS (via `TcpLineTransport`) |
| Best-effort MAC lookup | `services/protocols/src/arp-lookup.ts` | AVR, HEOS, Yamaha |
| Capability config shape | `services/protocols/src/avr-capabilities.ts` (`AudioCapabilityConfig`) | AVR, HEOS, Yamaha |
| Discovery transport | `services/protocols/src/ssdp.ts`, `mdns.ts` | AVR, HEOS, Yamaha, + non-AV drivers |
| Room assignment | `services/commissioning/src/room-assignment-engine.ts` | AVR, HEOS, Yamaha (any protocol can opt in) |
| Media topology | `packages/domain-model/src/media-topology.ts` | any `media`-capability device |

A driver author writes exactly two files (`<brand>-codec.ts`, `<brand>-driver.ts`),
composes the shared modules above (now including `av-sdk/` for a TCP-line-protocol
brand), and gets transport pooling, reconnect, diagnostics, room assignment, and
topology "for free." See the
[AV Adapter Development Guide](./AV-Adapter-Development-Guide.md) for the concrete
walkthrough.

## 2. Driver Lifecycle

**There is no explicit `DriverState` enum anywhere in this fleet** (confirmed during
the production audit — this is a fleet-wide convention, not something unique to AV
drivers). The lifecycle is real but IMPLICIT in control flow:

```
Discovered ──▶ Registered ──▶ Created ──▶ Connecting ──▶ Connected
                                                              │
                                              Capability Discovery
                                                              │
                                              Initial State Sync
                                                              │
                                                            Ready ◀────────┐
                                                              │            │
                                                        Operational        │
                                                          │       │        │
                                                    Reconnect ────┘        │
                                                          │                │
                                                    Disconnected ──────────┘
                                                          │
                                                      Destroyed
```

| Phase | How it's actually represented in code |
|---|---|
| Discovered | A `DiscoveredDevice` returned from `discover()` — never persisted state, just a return value |
| Registered | `SupremeNativeAdapter.registerDriver()` adds the driver instance to the fleet and calls `connect()` |
| Created | `new <Brand>ProtocolDriver(opts)` — a driver constructor never opens I/O itself |
| Connecting | Between `net.connect()`/`fetch()` and the transport confirming it's live. AVR/HEOS: `link.ready === false` with a non-null socket. Yamaha: no persistent connection, so this phase barely exists — every request is its own connect+use+release |
| Connected | AVR/HEOS: `link.ready === true` (set on the socket `"connect"` event). Yamaha: `isConnected()` reflects the driver-level `this.connected`, not per-host — there's no per-host "connected" concept for a stateless HTTP driver |
| Capability Discovery | Yamaha only, genuinely: `ensureHostFeatures()` queries `/system/getFeatures` once per host. AVR: none (installer-declared). HEOS: none needed (fixed protocol surface) |
| Initial State Sync | AVR/HEOS: the init-query token burst sent in the `"connect"` handler. Yamaha: `syncZone()` at the end of `bind()` |
| Ready / Operational | Not distinguished as separate states — `command()` is safe to call the instant the driver considers itself connected (guarded by `link.ready`/`this.connected` checks — see §5 below) |
| Reconnect | `ReconnectScheduler.notifyDisconnected()` → capped backoff → `reconnect()` callback re-opens the link and re-runs Initial State Sync. Yamaha has no persistent socket to reconnect — `hostDown` tracking plus periodic UDP re-registration (every 8 min, ahead of the protocol's 10-min timeout) is the closest honest equivalent |
| Disconnected | Socket `"close"` handler nulls `link.socket`, sets `link.ready = false`, and calls `reconnect.notifyDisconnected()` |
| Destroyed | `disconnect()` — stops all reconnect schedulers, destroys sockets, clears every Map. **Known gap** (fleet-wide, not just AV drivers): there is no `unbind()` — removing ONE device's bindings without tearing down the whole driver isn't supported anywhere in this fleet yet. See the production audit's Phase 6/10 findings. |

### §5 — the one safety rule every driver must follow

**Never let `command()` silently succeed against a link that isn't actually live.**
Two specific guards every driver in this framework implements, copy them exactly:

```ts
async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
  // 1. Driver-level: reject anything after disconnect() — otherwise a command issued
  //    post-teardown silently resurrects a real connection instead of failing.
  if (!this.connected) throw new Error(`<brand>: driver is disconnected — cannot command ${deviceId}`);

  const b = this.bindings.find(/* ... */);
  if (!b) throw new Error(`<brand>: ${deviceId} not bound for ${command.capability}`);

  const link = this.ensureLink(/* ... */);
  // 2. Link-level: reject a write to a socket that's not yet (or no longer) ready —
  //    `socket !== null` alone is NOT sufficient; ensureLink() may have just started a
  //    brand-new connection attempt that hasn't finished.
  if (!link.ready || !link.socket || link.socket.destroyed) {
    throw new Error(`<brand>: not connected to ... `);
  }
  // ... write to the wire ...
}
```

## 3. Digital Twin

The Digital Twin is the union of `CapabilityState` (`packages/domain-model/src/
capabilities.ts`, specifically `MediaState`/`onoff` state) and `AudioCapabilityConfig`
(`avr-capabilities.ts`) — never a separate object. There is no per-brand "twin" class;
Supreme's existing `Device`/`CapabilityState` model IS the twin, and a driver's whole
job is keeping it in sync with the real device via `record()`/`onState()`.

- **State that changes live** (power, volume, mute, source, playback, metadata) →
  `CapabilityState`, pushed via `record(deviceId, capability, state)` → `onState`
  listeners → WebSocket stream. Every driver's internal cache (`MediaCache`/
  `HeosMediaCache`/`YamahaMediaCache`) exists ONLY to assemble the next `CapabilityState`
  from partial wire updates — it is never read directly by anything outside the driver.
- **Configuration that's fixed per-session** (inputs, sound modes, zones, tone/volume
  ranges, transport support, presets, bluetooth presence) → `AudioCapabilityConfig`,
  fetched once via the optional `getCapabilityConfig(deviceId, capability)` and stored
  on `Device.capabilities[].config`.
- **Connection/traffic health** (RX/TX, last command/response, reconnect count,
  response time, model/firmware/IP/MAC) → `DriverDiagnosticsSnapshot`, fetched
  on-demand via the optional `getDiagnostics(deviceId)` — never pushed on every state
  delta (it's a diagnostics pull, not a hot-path field).
- **Real-world wiring** (what's plugged into a physical input/output) →
  `MediaTopology`, stored in `device.metadata.avrTopology` — always installer-declared,
  since no AV protocol in this fleet reports what's on the other end of an HDMI cable.

See the production audit's Phase 2 table for exactly which properties each of
Denon/HEOS/Yamaha actually populates — don't assume a field exists for your new brand
without checking the equivalent table for it.

## 4. Discovery Engine

Two real transports, both protocol-agnostic and reusable as-is:

- **SSDP** (`ssdp.ts`) — UDP M-SEARCH multicast. Give it a search target (`st`); most
  AV/streaming brands answer one. AVR/HEOS both search
  `urn:schemas-denon-com:device:ACT-Denon:1`; Yamaha searches the generic
  `urn:schemas-upnp-org:device:MediaRenderer:1` and filters by `<manufacturer>` in the
  UPnP device-description XML fetched from the SSDP response's `Location` URL.
- **mDNS/Bonjour** (`mdns.ts`) — used by Shelly/AirPlay/Apple TV today; not currently
  used by any of the 3 AV drivers (their brands don't advertise via mDNS), but
  available if your new brand does.

A driver's `discover()` returns `DiscoveredDevice[]`, each with an opaque `raw`
bag. Fields the framework specifically looks for (all optional, all additive):

```ts
raw: {
  protocol: "denon" | ...,          // required — used to filter/route discovery results
  ip, mac,                          // NetworkInfo — extracted automatically by extractNetwork()
  bindConfig: { zone, pid, model }, // passed straight through to bind()'s config
  locationHint: { raw, source },    // feeds the Room Assignment Engine — see §6
  zones: [{ id, label }],           // feeds Automatic Zone Generation — see §6
}
```

There is no active subnet-scanning fallback in this framework (deliberately —
SSDP/mDNS already cover every brand in scope non-intrusively; see the production
audit's Phase 6/7 notes on why a blind scan was rejected as the wrong default for a
local-first platform). "Add by IP" (manual entry, protocol auto-detected by probing
known ports/endpoints) is not implemented in this framework as of this document.

## 5. Capability Engine

`AudioCapabilityConfig` (§3 above) is populated one of two ways, and the shape tells
the UI which:

- **`source: "device_reported"`** — genuinely queried from the device
  (Yamaha's `getFeatures`, HEOS's fixed protocol-level enum). The UI can trust this is
  what the specific unit actually supports.
- **`source: "installer_declared"`** — the protocol has no way to ask
  (classic Denon Telnet — verified, no feature-query command exists in the spec). The
  data comes from `ProtocolBinding.config` set at commissioning time instead. Same
  shape, honestly labeled source, so the UI can (if it ever wants to) visually
  distinguish "the device told us this" from "the installer told us this."

**Never claim `"device_reported"` for data you hardcoded** — this is the single most
important rule of this whole framework (it's the literal reason the `source` field
exists). If you're not sure whether your new brand's protocol can genuinely answer a
"what do you support" query, read the spec looking specifically for that command
before assuming either way.

## 6. Room Assignment Engine

`services/commissioning/src/room-assignment-engine.ts` — generic, confidence-tiered,
NOT AVR-specific (any protocol's `discover()` can attach a `locationHint`).

| Tier | Confidence | What qualifies | Auto-creates a room? |
|---|---|---|---|
| `explicit_attribute` | 100 | A real protocol room/location attribute (KNX ETS room, Matter Room cluster — none of AVR/HEOS/Yamaha have this) | Yes |
| `persistent_user_zone_name` | 90 | A persistent, user-set name from THAT protocol's own setup flow (HEOS player name, Yamaha MusicCast zone name) | Yes |
| `friendly_name_heuristic` | 70 | A generic device name (SSDP friendlyName), normalized by stripping brand/category/zone noise words | Yes, if normalization leaves a real name |
| (below 70) | — | Pure noise after normalization, or no hint at all | No — lands in the fixed `"Unassigned Devices"` room |

`resolveRoomAssignment(hint, existingRoomNames)` is a pure function — no I/O, easy to
unit test against your own brand's real discovery output before wiring it up.
`InstallerServices.autoCommissionMedia()` (`services/gateway/src/installer-context.ts`)
is the orchestrator that calls it, creates/reuses rooms, commissions, and binds — see
`adding-avr-brands.md` §8 for exactly what a new driver needs to do to participate.

## 7. Media Topology Engine

`packages/domain-model/src/media-topology.ts` — a zod-validated shape stored in the
existing free-form `device.metadata.avrTopology` field (no persistence/migration
change, ever, for any brand):

```ts
{
  connections: [
    { output: "hdmi1", label: "HDMI1", connectedLabel: "Apple TV" },
    { output: "hdmiOut", label: "HDMI OUT", connectedDeviceId: "dev_...", connectedLabel: "Sony Projector" },
  ]
}
```

Always installer-declared — no AV protocol in this fleet's scope reports what's
physically connected to a port. `parseMediaTopology()` degrades any malformed/missing
metadata to `{ connections: [] }` rather than throwing, so a driver/UI never needs to
special-case "this device has no topology yet." Rendered + edited in
`apps/web-homeowner/src/features/media/detail.tsx`'s `TopologySection` for any
`media`-capability device — automatic for every brand, nothing for a driver author to
implement.

## 8. Diagnostics

`DriverDiagnosticsTracker` (`driver-diagnostics.ts`) owns exactly four things: send/
receive counters + last command/response + timestamps, response-time arithmetic,
reconnect count, and last error. It does NOT know your protocol's framing — you call
`.recordSend(commandString)` right before writing to the wire and `.recordReceive
(responseString)` right after reading, and it computes everything else. See
`avr-driver.ts`'s `openSocket`/`onData`/`command()` for the exact call sites to mirror.

`bestEffortMacForIp(ip)` (`arp-lookup.ts`) reads the host's own ARP table
(`/proc/net/arp`, Linux only, passive — never active probing) — reusable as-is for any
IP-based brand, returns `null` honestly when unavailable rather than guessing.

## 9. What NOT to do

Everything below was checked during the production audit and found NOT to be a
pattern in this codebase — don't introduce it for a new brand:

- **Don't add a brand-specific field to `MediaState`/`CapabilityCommand`.** Use the
  `advanced: Record<string, unknown>` escape hatch, exactly like every existing brand.
- **Don't build a second discovery mechanism.** `ssdp.ts`/`mdns.ts` are the only two;
  if your brand needs neither, that's a real, rare exception — check twice first.
- **Don't invent a per-brand lifecycle state machine.** None of the 25 drivers in this
  fleet has one; follow the implicit pattern in §2, don't be the first to diverge.
- **Don't fabricate `AudioCapabilityConfig` fields your protocol can't actually
  supply.** An honestly-gated missing control beats a plausible-looking fake one —
  this is this codebase's single most repeated architectural principle, and it's
  enforced by the `source: "device_reported" | "installer_declared"` field existing at
  all.
- **Don't skip the disconnect-guard/link-ready-guard pattern in §2.5** — it's not
  boilerplate, it's the fix for a real bug found during this session's production audit.
