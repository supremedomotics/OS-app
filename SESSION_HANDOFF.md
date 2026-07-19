# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start.

## Current development status

The incoming brief asked for a full "SupremeOS Universal AV Driver SDK." A gap analysis (citing
exact file:line evidence, not assumption) found the Universal AVR Framework (ADR 0015) was
already built and shipping in a previous session — Denon/Marantz Telnet, HEOS, and Yamaha YXC
drivers with real discovery, dynamic capability detection, and reconnect. This session closed the
genuinely missing pieces confirmed by that gap analysis: a Diagnostics Console, a confidence-based
Room Assignment Engine (replacing a narrower prior policy, per explicit user direction), Automatic
Zone Generation, and a Media Topology Engine — plus small, honest discovery enrichment (best-effort
MAC lookup, real model threading). Full details and rationale live in ADR 0015's new addendum
(`docs/architecture/adr/0015-universal-avr-framework.md`).

## Completed this session

1. **Diagnostics Console** (§ Universal AV Driver SDK): a shared `DriverDiagnosticsTracker`
   (`services/protocols/src/driver-diagnostics.ts`, generalized from the counter pattern already
   proven in `knx-ultimate-provider.ts`) wired into `AvrProtocolDriver`/`HeosProtocolDriver`/
   `YamahaProtocolDriver` — real RX/TX packet counts, last command/response + timestamps, response
   time, reconnect count, last error. Exposed via a new optional `INativeProtocolDriver.
   getDiagnostics?()`, plumbed through `SupremeNativeAdapter`/`RoutingBackendAdapter`/
   `SupremeIntegrationLayer` (mirroring the existing `getCapabilityConfig` seam exactly — and in
   the process fixed a real pre-existing gap: `RoutingBackendAdapter` never actually implemented
   `getCapabilityConfig`, so a routed device's capability config silently never reached the UI;
   both are now implemented together). New route `GET /v1/devices/:id/diagnostics` → new
   `DeviceDriverDiagnostics` contract type → `fetchDeviceDiagnostics()` → rendered in
   `DiagnosticsSection` (`device-detail-sections.tsx`). MAC is a best-effort local ARP-table read
   (`services/protocols/src/arp-lookup.ts`, Linux `/proc/net/arp` only — never active probing).
   Firmware stays honestly `null` for all three protocols (verified: none of the specs expose it).
2. **Room Assignment Engine** (§ Automatic Room Assignment) — a new, generic, protocol-agnostic
   engine (`services/commissioning/src/room-assignment-engine.ts`), explicitly NOT the same as
   the existing KNX-ETS-project-tree engine at `knx/room-assignment-engine.ts` (different input
   shape, different job — both now coexist). Confidence tiers: `explicit_attribute` (100),
   `persistent_user_zone_name` (90 — HEOS player names, Yamaha MusicCast zone names), `friendly_
   name_heuristic` (70 — normalized SSDP friendlyName, brand/category/zone noise words stripped).
   Below 70 → the fixed `"Unassigned Devices"` room, never a silent guess. This **explicitly
   supersedes** ADR 0015 §2.3's prior "installer always assigns the room" position, per direct
   user instruction overriding that architecture decision — see the ADR addendum for the full
   policy text.
3. **Automatic Zone Generation**: Yamaha's `discover()` now also queries `/system/getFeatures`
   per candidate (a real wire call) and reports every zone the unit actually has; a new
   `InstallerServices.autoCommissionMedia()` (`services/gateway/src/installer-context.ts`, routed
   at `POST /v1/commissioning/auto-media`) auto-creates a sibling Supreme device per extra zone,
   sharing the physical connection, in the same resolved room. Denon Telnet's Zone 2 stays a
   deliberate manual step (protocol genuinely can't detect it — unchanged from the original ADR).
   Dedup via `registry.reverseLookup` so a repeat run never re-commissions/re-expands.
4. **Media Topology Engine**: `packages/domain-model/src/media-topology.ts` — installer-declared
   HDMI-input/output/zone → connected-thing graph (`{output, label, connectedDeviceId?,
   connectedLabel}`), stored in the existing free-form `device.metadata.avrTopology` (no
   persistence/migration change). Rendered + edited (devMode-gated) in a new `TopologySection`
   inside the AVR console (`apps/web-homeowner/src/features/media/detail.tsx`).
5. **Discovery enrichment**: HEOS/Yamaha now thread a real `model` string through to `bindConfig`
   (HEOS `get_player_info`, Yamaha's UPnP `<modelName>`) — Denon Telnet stays `null` (no wire
   source). Active subnet scanning was deliberately NOT built (SSDP/mDNS already cover every
   brand in scope non-intrusively — a blind scan is the wrong default here).
6. **Tests**: 20 new/changed test files across `services/protocols`, `services/commissioning`,
   `services/integration-layer`, `services/gateway`, `packages/domain-model` — including a new
   end-to-end proof (`services/gateway/src/auto-commission-media.e2e.test.ts`): discover →
   confidence-scored room assignment → auto zone generation → bind → live control, plus the
   Unassigned-bucket and repeat-run-is-a-noop cases. Full monorepo `pnpm turbo run build /
   typecheck / test` all pass clean (93/93 tasks each).

## Files touched this session

- New: `services/protocols/src/{driver-diagnostics,arp-lookup}.ts` (+ `.test.ts` each)
- New: `services/commissioning/src/room-assignment-engine.ts` (+ `.test.ts`)
- New: `packages/domain-model/src/media-topology.ts` (+ `.test.ts`)
- New: `services/gateway/src/auto-commission-media.e2e.test.ts`
- Modified: `services/protocols/src/{avr,heos,yamaha}-driver.ts`, `yamaha-codec.ts`,
  `{avr,heos,yamaha}-driver.test.ts`
- Modified: `services/integration-layer/src/{adapter,native-adapter,routing-adapter,sil,
  protocols/driver}.ts`, `index.ts`
- Modified: `services/commissioning/src/index.ts` (`DiscoveredView` gains `locationHint`/`zones`)
- Modified: `services/gateway/src/installer-context.ts`, `routes/{devices,installer}.ts`
- Modified: `packages/supreme-contracts/src/rest.ts` (`DeviceDriverDiagnostics`)
- Modified: `packages/domain-model/src/index.ts`
- Modified: `apps/web-homeowner/src/{api,device-detail-sections,styles}.ts(x/css)`,
  `features/media/detail.tsx`
- Docs: `docs/architecture/adr/0015-universal-avr-framework.md` (addendum),
  `docs/architecture/avr-framework-review.md` (supersede note on §2.3)

## Architecture decisions made this session

- **Two Room Assignment Engines coexist, deliberately.** The new generic one
  (`services/commissioning/src/room-assignment-engine.ts`) handles live-discovery hints across
  any protocol; the existing KNX one (`knx/room-assignment-engine.ts`) resolves an ETS project
  file's building/floor/room tree — different input shape, different job. Neither was merged into
  the other; the KNX ETS import pipeline was not touched (working, well-tested, high blast-radius
  if broken).
- **`autoCommissionMedia` is a new method, not a rewrite of `autoCommission`.** The existing
  generic `autoCommission(protocol)` (used by Casambi) takes a bare `raw.room` string with no
  confidence check and has no zone-expansion concept; extending it in place risked regressing
  Casambi's working path. A parallel, AVR/HEOS/Yamaha-scoped method was added instead, following
  the same `discover → resolve room → commission → bind` shape.
- **Diagnostics is per-physical-link, not per-Supreme-device**, for AVR/HEOS (one TCP socket,
  many devices) and per-host for Yamaha (HTTP request/response, no persistent socket) — sibling
  zone devices on the same physical unit correctly report identical RX/TX counters, which is
  honest (it *is* the same wire traffic), not a bug.
- **No active subnet scanning.** SSDP/mDNS already cover every brand in scope; a blind scan is
  intrusive and the wrong default for a local-first luxury platform. MAC enrichment uses the
  passive local ARP table instead.

## Known issues / open gaps

- **Not live-verified against real Denon/HEOS/Yamaha hardware or a running `hub-compose` stack**
  — this environment has neither. Every protocol claim is checked against the vendor specs
  already cited in ADR 0015 and exercised through in-process fake TCP/HTTP servers (this repo's
  established testing convention); `tsc`/`vite build` both pass clean, but the new Topology UI has
  not been Playwright-verified in a real browser at any responsive tier, per this project's own
  UI testing standard. Do this first if picking AVR work back up.
- No whole-home Media Dashboard topology *graph view* — only the per-device connections list was
  built (task explicitly asked for diagnostics/dashboard/automation-relationships support; only
  the diagnostics-adjacent per-device view shipped this session).
- The generic Room Assignment Engine is wired for AVR/HEOS/Yamaha only. The brief asked for it to
  be reusable by Matter/KNX/Zigbee/Z-Wave/BLE/IP drivers too — the engine itself is already
  protocol-agnostic (takes a generic `LocationHint`), but none of those other drivers were changed
  to emit one this session (deliberately, to avoid touching working KNX ETS import / other stable
  pipelines in a single large session).
- Everything from the previous handoff not touched this session remains open (Infrastructure
  module device types #2–8, design-polish phase, density-breakpoint remount bug, production-
  readiness gap — see `TODO.md`).

## Immediate priorities for the next session

1. Stand up `hub-compose` and live-verify the Topology UI + Diagnostics Console fields against
   real device data at every responsive tier (or at minimum against a real Denon/HEOS/Yamaha unit
   if hardware is available).
2. If more protocols should feed the Room Assignment Engine, wire a `locationHint` into Matter/
   KNX/Zigbee discovery the same way AVR/HEOS/Yamaha now do — the engine itself needs no changes.
3. Continue the Infrastructure module (Solar/Battery Storage next) or the Design Polish phase —
   both still open from before this session.

See `TODO.md` for the full backlog with priority tiers.
