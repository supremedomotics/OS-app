# SupremeOS KNX Driver — Engineering Handoff

Purpose: a map of *what runs where* in the KNX integration — which file/function handles a
given command or piece of state, which real library (or hand-built protocol implementation)
it goes through, and which of the two parallel KNX drivers in this codebase actually owns
production traffic today. Written for a reader who is not this session's context — every
claim below is traceable to a file path.

---

## 1. The two-driver situation (read this first)

There are **two independent driver classes** implementing `INativeProtocolDriver` for
`protocol: "knx"`. This is not duplication by accident — they exist for different reasons and
only one of them is wired to live commands today.

| | `KnxProtocolDriver` | `SupremeKnxDriver` |
|---|---|---|
| File | `services/protocols/src/knx-driver.ts` | `services/protocols/src/knx/supreme-knx-driver.ts` |
| Role | **The production driver.** Bound to the real KNX bus by `services/gateway/src/bootstrap.ts` from `config.knxHost`; every real `command()`/state-feedback call for an installed KNX device goes through this file. | The **discovery/commissioning-time** driver — task-router architecture, richer diagnostics, offline-queue, KNX IoT discovery. Its own `getCapabilityConfig`/`bind` back the *scan/preview* pipeline (ETS import → binding plan → installer review), not live control. |
| KNX bus access | Talks to the bus through its own small `KnxConnection` interface (`connect/disconnect/write/observe`), whose **default implementation dynamically imports `knxultimate` directly** (`defaultKnxConnection()`, same file, line ~188). | Talks to the bus through `KnxUltimateProvider` (`services/protocols/src/knx/knx-ultimate-provider.ts`), a richer wrapper with connection-state events, diagnostics counters, and KNX IoT discovery support. |
| Why two paths to the same library | `KnxProtocolDriver` predates the task-router/provider architecture and was kept deliberately simple/small since it's the always-on production path; `SupremeKnxDriver` was built for the commissioning pipeline's more complex needs (multi-provider routing, offline queue, sync-on-reconnect) and reuses `KnxUltimateProvider` rather than another hand-rolled connection. |

**If you're debugging "a command isn't reaching the bus," start in `knx-driver.ts`
(`KnxProtocolDriver`) — that's the one actually running.** If you're debugging "discovery/scan
isn't finding a device correctly," you're in the commissioning pipeline
(`services/commissioning/src/knx/*` → `SupremeKnxDriver`/`KnxUltimateProvider`/`KnxIotProvider`).

---

## 2. Library/API boundary map

Three genuinely different external integration points exist. Nothing else in the KNX code
imports a KNX library directly — every real network call funnels through one of these three.

### 2.1 `knxultimate` (npm package) — the real KNX bus (group read/write/telegrams)

- **`services/protocols/src/knx/knx-ultimate-provider.ts`** — "the ONLY file in the Supreme
  KNX Driver that imports `knxultimate`" (its own doc comment, line 11) for the
  `SupremeKnxDriver` path. Wraps the library's client into the `IKnxProvider` interface
  (`services/protocols/src/knx/provider.ts`), exposing connection-state events and real
  packet/error counters for diagnostics.
- **`services/protocols/src/knx-driver.ts`**, function `defaultKnxConnection()` (~line 188) —
  a **second, independent** dynamic `import("knxultimate")` for the production
  `KnxProtocolDriver` path. Pulls `KNXClient`/`dptlib` off the module, wraps them into the
  driver's own minimal `KnxConnection` interface (`wrapKnxUltimate`, same file).
- **What flows through `knxultimate`**: every real group-write (a command), every real
  group-read/status subscription (feedback), DPT byte-level (de)serialization
  (`dptlib`), and the actual KNXnet/IP tunnelling/routing session.

### 2.2 Official KNX IoT Point API (CoAP, hand-implemented against the published spec — no npm KNX-IoT package exists)

- **`services/protocols/src/knx/knx-iot-transport.ts`** — `CoapKnxIotTransport`. Its own doc
  comment is explicit: *"the KNX IoT Point API Stack's C reference implementation has no
  Node binding, so this speaks the documented protocol directly... built on the
  general-purpose `coap`/`coap-packet` npm packages, not a port of KNX Association source."*
  Real CoAP multicast `GET /.well-known/core` (`224.0.1.187:5683`) for discovery, real CoAP
  unicast `GET` for per-resource retrieval, real CoAP Observe (RFC 7641) for push updates —
  built on the generic `coap`/`coap-packet` libraries (`node:dgram` underneath), never
  `knxultimate`.
- **`services/protocols/src/knx/knx-iot-provider.ts`** — `KnxIotProvider`, the `IKnxProvider`
  wrapper around that transport. Registered in `SupremeKnxDriver`'s task router for **exactly
  two** task kinds: `discovery.metadata` and `discovery.functional_blocks` (see §3). Explicitly
  documented as NOT implementing `discovery.semantic`/`discovery.resource_model`/
  `discovery.room_metadata` — "no live KNX IoT device in this environment to validate a real
  GET/parse cycle against, so they stay honestly unregistered rather than guessed at."
- **What flows through KNX IoT**: only discovery/metadata retrieval for KNX IoT-capable
  devices. Never group read/write, never DPT bus traffic, never the production command path.

### 2.3 Pure `node:dgram`, hand-built to the KNXnet/IP Core spec — gateway discovery (not device control)

- **`services/protocols/src/knx-discovery.ts`** — multicasts a SEARCH_REQUEST to
  `224.0.23.12:3671` (the KNX system-setup group) and parses SEARCH_RESPONSE frames
  (6-byte header + 8-byte HPAI + Device Information DIB) by hand, per the KNXnet/IP Core
  spec's own wire layout. Purpose: find KNX IP interfaces/routers on the LAN so the installer
  can configure `KnxProtocolDriver`'s `host`/`port` — it does not talk to individual devices
  or DPTs at all, and does not use `knxultimate` or CoAP.
- **`services/protocols/src/lan-adapters/knx-discovery-remote-socket.ts`** — swaps the real
  `dgram` socket in `knx-discovery.ts` for a remote-transport adapter (for a hub-behind-NAT
  scenario); same protocol, different socket source.

---

## 3. SupremeKnxDriver's task router — exact routing table

`services/protocols/src/knx/supreme-knx-driver.ts`, constructor (~line 115-151):

```
bus.group_write, bus.group_read, bus.monitor,
dpt.encode, dpt.decode,
security.knx_secure, transport.routing, transport.tunneling
                                    → KnxUltimateProvider   (knxultimate)

discovery.metadata, discovery.functional_blocks
                                    → KnxIotProvider        (CoAP / KNX IoT)

discovery.semantic, discovery.resource_model, discovery.room_metadata
                                    → unregistered (no live device to validate against)
```

Every task kind not in this table has no registered provider — `KnxTaskRouter.providerFor()`
(`services/protocols/src/knx/task-router.ts`) throws rather than silently routing anywhere,
so an unregistered task kind fails loudly, not silently.

`KnxTaskRouter.dispatch(task)` (same file) is the single call site every `SupremeKnxDriver`
method funnels through — no method talks to a provider directly.

---

## 4. Production command/state path (what actually runs live) — `KnxProtocolDriver`

File: `services/protocols/src/knx-driver.ts`.

```
SupremeOS CapabilityCommand
    ↓
KnxProtocolDriver.command(deviceId, command)              [knx-driver.ts:~184]
    ↓ finds the KnxBinding for (deviceId, capability)
    ↓ knx-codec.ts: valueFromCommand(command, prevState, dpt)  — capability+DPT → decoded JS value
    ↓
KnxConnection.write(groupAddress, value, dpt)              [the injected/default connection]
    ↓ (default) wrapKnxUltimate()'s write() → real knxultimate KNXClient.write()
    ↓
Real KNX bus telegram
```

Feedback (state) path — same file, `observe()` (~line 245):

```
Real KNX bus telegram (status GA)
    ↓
KnxConnection.observe(statusGa, dpt, handler)               → knxultimate client 'indication' event
    ↓
knx-codec.ts: stateFromValue(capability, value, config)     — decoded JS value → CapabilityState
    ↓ (§ Phase 3.3C-1) applyHvacRoleOverlay(binding, state)  — re-merges any hvacRoles-derived
    ↓                                                           field (e.g. operatingMode) so a
    ↓                                                           fresh primary reading never wipes it
KnxProtocolDriver.record()  →  onState listeners  →  SupremeOS device state
```

`knx-codec.ts` (`services/protocols/src/knx-codec.ts`) is the **only** file that knows the
capability↔DPT-value mapping — it never touches the network itself; `KnxConnection` (backed by
`knxultimate`) is the only thing that does. This separation is what makes the codec unit-testable
without a real bus (see `knx-driver.test.ts`'s `FakeKnxBus`).

### 4.1 HVAC multi-GA architecture (Phase 3.3B/3.3C-1 — current, in-progress work)

One `temperature` capability binding can now carry **auxiliary group addresses** tagged by
semantic role (not by DPT number), independent of the primary setpoint/ambient GA pair:

```
KnxBinding (temperature)
  ├── writeGa / statusGa        — primary setpoint/ambient GA pair (unchanged since Phase 1)
  └── hvacRoles: KnxHvacRoleBinding[]
        └── { semanticRole: "operatingMode", address, dpt, rawValue, decodedOperatingMode }
```

- Populated from `config.hvacRoles` (a plain `{semanticRole: {address, dpt}}` object) by
  `bind()`'s `parseHvacRoles()` helper (`knx-driver.ts`).
- `config.hvacRoles` itself is threaded in at commissioning time by
  `services/commissioning/src/knx/entity-generator.ts`, sourced from
  `RecognizedBinding.hvacRoles` — which `device-recognition-engine.ts`'s
  `collapseToOneBindingPerCapability()` populates by diverting recognized HVAC auxiliary-role
  signals (currently only `hvac_mode`, DPT 20.102) onto the winning `temperature` binding
  instead of discarding them as "unused."
- **Only DPT 20.102 (`DPT_HVACMode`) has a real codec today** —
  `decodeHvacOperatingMode`/`encodeHvacOperatingMode` in `knx-codec.ts`, wired into
  `KnxProtocolDriver.observe()`/`command()`. Every other HVAC DPT discussed in
  `docs/coolmaster/` sibling sessions (20.105, 1.100, 22.101, multi-setpoint family) is
  **not yet implemented** — recognized-but-inert at most, exactly like the pre-existing
  fan-speed handling.
- Each `hvacRoles` entry gets its **own** `KnxConnection.observe()`/`write()` subscription,
  independent of the primary GA's — see `observe()`/`writeHvacRole()`/`getHvacRoleValue()` in
  `knx-driver.ts`.

---

## 5. Commissioning-time path (discovery/scan/preview) — `SupremeKnxDriver`

```
ETS export / GA export / .esf file
    ↓ services/commissioning/src/knx/{ets-parser,ga-export-parser,esf-parser}.ts
    ↓ dpt-analyzer.ts: classifyDpt()            — DPT number → structural category
    ↓ device-recognition-engine.ts: roleOf()    — category + naming → functional role
    ↓                                 collapseToOneBindingPerCapability() — one binding
    ↓                                  per capability per device (+ hvacRoles, §4.1)
    ↓ room-assignment-engine.ts                 — room inference
    ↓ entity-generator.ts: generateEntities()   — RecognizedBinding → CommissionableBinding
    ↓                                              (config.dpt / statusAddress / hvacRoles)
Installer review UI (apps/web-homeowner/src/knx-discovery-workspace.tsx)
    ↓ approved bindings
services/gateway/src/installer-context.ts: bindProtocol()
    ↓
KnxProtocolDriver.bind()   ← THIS is where commissioning output becomes live production binding
```

`SupremeKnxDriver` itself (live KNX IoT discovery, `bus.*` task routing via
`KnxUltimateProvider`) is used for the **scan-time preview** — reading current values to show
the installer what a binding would look like before approval — not for the live device once
commissioned. Once approved, `KnxProtocolDriver` (§4) takes over permanently.

---

## 6. File index (quick reference)

| File | What it is |
|---|---|
| `services/protocols/src/knx-driver.ts` | **Production driver** (`KnxProtocolDriver`). Own `KnxConnection` abstraction, default impl dynamically imports `knxultimate`. |
| `services/protocols/src/knx-codec.ts` | Capability ↔ DPT-value codec. Pure functions, no I/O. Includes DPT 20.102 codec (§4.1). |
| `services/protocols/src/knx-discovery.ts` | KNXnet/IP gateway discovery (`dgram`, hand-built SEARCH_REQUEST/RESPONSE). Finds the bus interface, not devices. |
| `services/protocols/src/lan-adapters/knx-discovery-remote-socket.ts` | Remote-socket adapter for `knx-discovery.ts` (hub-behind-NAT). |
| `services/protocols/src/knx/knx-ultimate-provider.ts` | `knxultimate` wrapper for the `SupremeKnxDriver`/task-router path. |
| `services/protocols/src/knx/knx-iot-provider.ts` | KNX IoT Point API provider (discovery/metadata only). |
| `services/protocols/src/knx/knx-iot-transport.ts` | Raw CoAP transport (`coap`/`coap-packet`) implementing the documented KNX IoT wire protocol. |
| `services/protocols/src/knx/supreme-knx-driver.ts` | Commissioning-time driver (`SupremeKnxDriver`). Task router, offline queue, sync-on-reconnect. |
| `services/protocols/src/knx/task-router.ts` | `KnxTaskRouter` — task-kind → provider dispatch table. |
| `services/protocols/src/knx/provider.ts` | `IKnxProvider` interface both `KnxUltimateProvider`/`KnxIotProvider` implement. |
| `services/protocols/src/knx/capability-mapper.ts` | DPT category/keyword → SupremeOS capability classification (discovery-time semantic mapping). |
| `services/commissioning/src/knx/dpt-analyzer.ts` | DPT number → structural category (`classifyDpt`). |
| `services/commissioning/src/knx/device-recognition-engine.ts` | Clusters GA signals into devices; `collapseToOneBindingPerCapability` (incl. `hvacRoles`). |
| `services/commissioning/src/knx/entity-generator.ts` | `RecognizedBinding` → `CommissionableBinding` (the shape sent to `bind()`). |
| `services/commissioning/src/knx/{ets-parser,ga-export-parser,esf-parser}.ts` | Import-file parsers (ETS XML / GA-export XML / ESF). |
| `services/commissioning/src/knx/room-assignment-engine.ts` | Room inference from naming/topology. |
| `services/commissioning/src/knx/device-card-generator.ts` | Installer-facing preview card generation. |
| `services/commissioning/src/knx/learning-store.ts` | Persists installer corrections across re-imports. |

---

## 7. Known architectural notes for whoever picks this up next

- The KnxProtocolDriver / SupremeKnxDriver split (§1) is real and intentional, not tech debt
  to "clean up" casually — merging them would require reconciling `KnxConnection` and
  `IKnxProvider`'s different shapes and semantics; not attempted in this session.
- `hvacRoles` (§4.1) is a generic extension point — adding a second real HVAC DPT (e.g. DPT
  20.105) means: (a) add its decode/encode pair to `knx-codec.ts`, (b) add one entry to
  `device-recognition-engine.ts`'s `HVAC_AUX_SEMANTIC_ROLE` map, (c) wire the new semantic
  role into `KnxProtocolDriver.observe()`'s decode branch and `applyHvacRoleOverlay()`. No
  new entity/binding architecture is needed.
- `packages/domain-model`'s `TemperatureState` carries `operatingMode`/`controllingModeExtended`/
  `heatCool`/`status`/`setpoints` as protocol-neutral optional fields (not KNX-specific) —
  see `packages/domain-model/src/capabilities.ts`. **Remember to `pnpm --filter
  @supreme/domain-model build` after editing this package** — every consumer resolves it via
  `dist/`, not live TypeScript source; a stale `dist/` silently hides new/changed fields from
  every downstream typecheck.
