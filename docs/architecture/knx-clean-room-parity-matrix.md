# SupremeOS KNX — Clean-Room Driver Parity Matrix

Status: **living document** · Stage 1 audit complete · native stack in progress
Branch: `claude/great-keller-fmenbn` (task brief named `feat/knx-clean-room-driver-foundation`; the
session's designated branch was kept — rename/cherry-pick at merge time if required)

> Evidence rules: every "Exists" claim below was verified by reading the cited file. "Tested"
> means a test in the repo exercises it and passed in this session's baseline run
> (442/442 KNX tests, `pnpm --filter @supreme/protocols test`). "Native" means the clean-room
> replacement is implemented **and** has passing tests. **Nothing is claimed validated on real
> hardware** — no KNX IP interface was available. "Deployed use" cannot be derived from the
> repository (no installation inventory exists in the repo); it is listed as **Unknown** and
> must be answered from field data before the removal gate.

**Documents the brief referenced that do not exist in the repo:**
`supreme-knx-clean-room-driver-blueprint.md` and `KNX-CLEAN-ROOM-CLAUDE-PROMPT.md`. This file and
`knx-driver-handoff.md` are the only KNX architecture docs present. No requirement was inferred from
the missing files.

## 1. Where `knxultimate` is used (complete)

Source imports — exactly two dynamic `import("knxultimate")` call sites, nothing else:

| Site | File | Surface used |
|---|---|---|
| Production driver transport | `services/protocols/src/knx-driver.ts` `defaultKnxConnection()` / `wrapKnxUltimate()` | `KNXClient` (TunnelUDP; `Connect`, `Disconnect`, `write`, events `connected`/`error`/`indication`), `dptlib.resolve`, `dptlib.fromBuffer` |
| Commissioning/diagnostic provider | `services/protocols/src/knx/knx-ultimate-provider.ts` `doConnect()` | same + `client.read()` (GroupValueRead), `localIPAddress` option, `cEMIMessage.{srcAddress,dstAddress,npdu.{dataValue,isGroupWrite,isGroupResponse}}` |

Manifest/lock: `services/protocols/package.json` (`knxultimate ^6.0.1`), `pnpm-lock.yaml`
(importer + `knxultimate@6.0.1`). Transitive: `binary-parser`, `serialport@13` (native
`@serialport/bindings-cpp`), `winston`, `xml2js` — to be re-checked at removal (other packages,
e.g. `modbus-serial`, may keep `serialport`).
Non-code mentions: comments in `knx-codec.ts`, `driver-diagnostics.ts`, `index.ts`, docs, and
`services/gateway/src/knx-feedback-diagnostics.e2e.test.ts` (test). Not referenced by `infra/`.
ETS importers (`services/commissioning/src/knx/*`) and KNX IoT (`knx-iot-*.ts`, CoAP) do **not**
use it.

Production wiring: `services/gateway/src/bootstrap.ts:149` registers
`new KnxProtocolDriver({host: config.knxHost, port: config.knxPort})` when `SUPREME_KNX_HOST` is
set. `SupremeKnxDriver` (task router + `KnxUltimateProvider`) is constructed by
`installer-context.ts` for discovery/commissioning and the feedback-diagnostics passthrough.

## 2. Feature parity

Legend — Exists: ✔ verified in code · Tested: existing automated test · Native: clean-room status
(`done` = implemented + tests pass; `partial`; `todo`) · Deployed: Unknown unless stated.

### 2.1 Transport / protocol

| Feature | Exists today (via) | Tested today | Native status | Notes |
|---|---|---|---|---|
| KNXnet/IP frame encode/decode | ✔ library-internal | indirectly | **done** `native/knxnetip-frame.ts` | strict; 13 tests incl. fuzz |
| cEMI L_Data + APCI group services | ✔ library-internal | indirectly | **done** `native/cemi.ts` | 14 tests incl. fuzz; TPCI/other APCI parsed as `group: null` |
| GA / IA parse + canonicalize | ✔ library-internal | one real-lib GA round-trip test | **done** `native/address.ts` | 2-level & raw spellings canonicalize to 3-level |
| Tunnelling session (connect, seq/ack, retry, heartbeat, disconnect) | ✔ library-internal | via fake only | **todo** (next stage) | see §4 |
| Routing (multicast 224.0.23.12) | ✘ **not used** — both sites hard-code `hostProtocol:"TunnelUDP"` | — | not required | comment in `knx-driver.ts:50` mentions it; no code path |
| Gateway discovery (SEARCH) | ✔ `knx-discovery.ts` (own dgram, no library) | ✔ `knx-discovery.test.ts` | already independent | to be rebased onto `native/knxnetip-frame.ts` later (optional) |
| Local interface selection | ✔ `localAddress` option (provider only) | ✔ | todo | |
| KNX IP Secure / Data Secure | ✘ none (provider doc comment mentions the library supports it; unused) | — | **out of scope / gap** | explicit accepted gap unless an installation uses it — Unknown |
| KNX IoT Point API (CoAP) | ✔ `knx-iot-transport.ts`, `coap` pkg | ✔ | already independent | keep separate; not touched |
| Reconnect / self-heal | ✔ `connection-manager.ts` (+ per-site glue) | ✔ | reusable as-is | native client will plug under it |
| Offline command queue | ✔ `offline-command-queue.ts` | ✔ | reusable as-is | safety policy gaps — see §5 |

### 2.2 Group communication behaviours (current semantics that MUST be preserved)

| Behaviour | Where | Tested | Native |
|---|---|---|---|
| Observe only declared feedback GAs; never attribute command-GA traffic to a device (`hasFeedback`) | `knx-driver.ts` | ✔ | n/a (driver layer unchanged) |
| Ignore GroupValueRead requests as feedback (PASS 23 fix) | `knx-ultimate-provider.ts` | ✔ | **done by construction**: `cemi.ts` returns `service:"read"`, `data:null` |
| Count write/response/read-ignored/unmatched telegrams, bounded last-telegram snapshots | provider `diagnostics()` | ✔ | todo (telegram bus) |
| Multiple observers per GA, per-binding unsubscribe | `wrapKnxUltimate` / provider (note: provider `unsubscribe(ga)` drops *all* observers of a GA) | ✔ | todo — native bus will do per-handle unsubscribe |
| GroupValueRead trigger (state sync) | provider `execute(bus.group_read)` | ✔ | todo |
| Stale-listener guard after reconnect | provider `wireIndications` | ✔ | todo |
| Connect timeout + leak-free cleanup of failed attempts | both sites | ✔ | todo |

### 2.3 DPT parity (decoded shape = `KnxValue` in `knx-codec.ts`)

Native codec: `native/dpt.ts`; 40 golden/property tests + differential test vs `knxultimate`
(test-only, auto-skips when the package is gone).

| DPT | Used by | Native | Differential vs library |
|---|---|---|---|
| 1.xxx | on/off, lock, heat/cool 1.100 | done | equal on 0/1 |
| 3.007/3.008 | **classified only** (`dpt-analyzer`); no command/state path | **unsupported — explicit error** | — |
| 5.001 / 5.100 / 5.003 / 5.004 / 5.010 | brightness, position, fan stage | done | equal (5.003 half-step rounding differs; not used live) |
| 6.xxx, 7.xxx (7.600 CCT), 8.xxx | sensors / CCT | done | equal |
| 9.xxx | temperature, sensors | done | equal on decode; encode rounds to nearest (library truncates at exponent>0) |
| 12.xxx, 13.xxx, 14.xxx | metering/sensors | done | equal |
| 17.001 | scene | done | equal (native rejects reserved bits) |
| 20.102 / 20.105 | HVAC mode / controlling mode | done | equal |
| 22.101 | HVAC status | done — **returns raw 16-bit number** | **intentional deviation, fixes defect D1** |
| 222.100 | HVAC setpoints | done — lowercase keys | **intentional deviation, fixes defect D2** |
| 232.600 | RGB | done | equal |
| 251.600 | RGBW | done | equal |
| 16.xxx strings, 18.001, 19.001, 29.xxx, 2.xxx, 4.xxx, 10/11 | referenced in classifier tables / ETS import only | **unsupported — explicit `unsupported_dpt`** | — |

### 2.4 SupremeOS capability mappings (above the transport — unchanged)

Lighting on/off, dimming (5.001), RGB/RGBW (232.600/251.600), CCT (7.600), covers/blinds
(5.001 position), HVAC (9.001 + hvacRoles 20.102/20.105/22.101/222.100/1.100), sensors, locks
(1.x), keypad (`knx-keypad.ts`), ETS `.knxproj`/ESF/GA-export import, room assignment,
duplicate detection, unified device mapper. **All sit above `KnxConnection` / `IKnxProvider` and
are untouched by this work.** Deployed use of each: Unknown.

## 3. Defects found in the existing implementation during this audit

| ID | Finding | Evidence | Confidence |
|---|---|---|---|
| D1 | With the real `knxultimate` transport, DPT 22.101 reaches `decodeHvacStatus` as an object (`{Fault, StatusEcoH, …}`); the decoder does `Number(value)` → `NaN` → returns `null`. HVAC `status` therefore never populates in production. Unit tests pass only because they inject numbers via a fake bus. | oracle output of `dptlib.fromBuffer` for `0103`; `knx-codec.ts:422`; test at `knx-driver.test.ts:1257` uses numeric fake | high (library output observed directly; did not run against a live bus) |
| D2 | Same class: DPT 222.100 arrives as `{Comfort,Standby,Economy}`; `isKnxSetpoints` requires lowercase → HVAC `setpoints` never populate in production. | oracle output for `0c1a0c9a0b00`; `knx-codec.ts` `isKnxSetpoints` | high (same caveat) |
| D3 | `0x7FFF` "invalid data" on plain DPT 9 sensors decodes to 670760.96 and would be published as a reading. | oracle output | high |
| D4 | Provider `unsubscribe(groupAddress)` removes *every* observer for that GA, not only the caller's. | `knx-ultimate-provider.ts` `unsubscribe` | high (code read) |

D1/D2 are fixed by construction in the native codec; they are **not** fixed in the legacy path
(production behaviour deliberately untouched until the feature-flag stage).

## 4. Implementation stages

| # | Stage | Status |
|---|---|---|
| 1 | Audit + parity matrix | **done** (this document) |
| 2 | Transport interfaces + deterministic harnesses | in progress |
| 3 | Framing | **done** (addresses, KNXnet/IP frames, cEMI) |
| 4 | Tunnelling + group communication | todo |
| 5 | DPT parity | **done** for required set; gaps listed above |
| 6 | Feature-flagged integration | todo |
| 7 | Health diagnostics, troubleshooting, self-healing | todo |
| 8 | Simulator validation + hardware-in-the-loop | simulator todo; **hardware: not started, no hardware** |
| 9 | Remove `knxultimate` | **blocked** on gates below |

## 5. Removal gates (all must hold before `knxultimate` is deleted)

1. Every row above that is deployed has `Native: done` or a signed-off documented gap (KNX Secure,
   routing, string/date DPTs).
2. Native tunnel client passes simulator suite **and** a hardware-in-the-loop run against a real
   KNX IP interface (reboot, outage, reconnect, soak/leak).
3. Feature flag has run in shadow/parallel on a non-customer installation.
4. Lockfile regenerated with pnpm; `knxultimate` absent from sources, manifests, lockfile, `dist/`,
   container image and SBOM (scan scripted).
5. `dpt-differential.test.ts` and `defaultKnxConnection` / `KnxUltimateProvider` deleted together.

Verified state of the offline command queue (`knx/offline-command-queue.ts`, read in full):
it already implements merge-by-key, TTL expiry (default 5 min) and explicit clear/evict. Gaps vs
the clean-room safety brief: the TTL is **uniform** (not capability-aware — a 5-minute-old lock,
blind, security or HVAC command is replayed the same as a light), there is no "never replay"
class, no replay audit record, and failed replays are dropped silently into the return count.
Note it is wired only into `SupremeKnxDriver` (grep: no reference in the production `KnxProtocolDriver`), so commands issued to the production driver while the bus is down are not queued at all.
Stage 7 adds a per-capability replay policy on top; the queue's merge/expire semantics are kept.
