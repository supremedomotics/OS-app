# Casambi Local Mode 2 — Architecture (Phase 1: Research)

> **Status: PHASE 1 — RESEARCH ONLY. No code written. One blocking decision is required before
> Phase 2 can proceed (see §2).**
>
> Baseline: existing driver at `services/protocols/src/casambi/`, reference doc
> `docs/architecture/Casambi-Driver-Reference.md`.
> Protocol authority: Lithernet Casambi Gateway **System Manual v6.38** (verified by direct
> quotation throughout — every claim below cites the manual or existing code, none are assumed).

---

## 1. Executive summary

The requested architecture is **UDP (events) + Local REST (commands) + Cloud (enrichment only)**.

Research produced two findings that change that design, one of them blocking:

1. **🔴 BLOCKING — `WebApi` is an *operating mode*, not an always-on API.** The Lithernet gateway
   runs in exactly one operating mode at a time, and the REST endpoints are gated on it. The
   requested UDP-events + REST-commands hybrid therefore **cannot run on a single gateway**.
2. **🟢 OPPORTUNITY — MQTT is a single mode that provides *both* planes.** It exposes a command
   surface that is a strict superset of REST **and** an event/push surface, entirely locally. It
   satisfies every Local Mode 2 objective without the mode conflict, and without polling.

Three viable architectures follow from this (§3). **Recommendation: Option C (MQTT-primary)**,
with Option B (two gateways) as the fallback where a site's gateway must stay in UDP mode.

Everything else in the brief — multi-network/multi-gateway identity, target abstraction, Cloud-as-
metadata-only, persistence, failure isolation, scale — is unaffected by this choice and is
specified in §5–§12.

---

## 2. 🔴 The blocking finding: operating-mode exclusivity

### 2.1 Evidence

Manual §5.16 (WebAPI), opening sentence:

> "The endpoints are only available if the Gateway is running in the corresponding operating mode.
> **If a different mode is active, the call is not processed.**"

Manual §4.3.1.15:

> "In the **WebApi operating mode**, the gateway provides REST endpoints (`/set/*` …)"

Manual §2.5 (UDP/TCP Casambi Command):

> "Selecting the operating mode — For this function, one of the following operating modes must be
> selected: **'UDP Casambi Command'** / **'TCP Casambi Command'**"

Operating modes are enumerated as siblings throughout §2 and §4.3.1: `Netcomposer`, `HelvarNet
(TCP)`, `UDP Casambi Bridge`, **`UDP Casambi Command`**, `TCP Casambi Command`, `ArtNet (Input
Only)`, `BacNet/IP`, `BACnet/SC`, `Modbus/TCP`, **`WebApi`**, `MQTT`, `KNX`.

### 2.2 Consequence

Today's Local Mode 1 requires the gateway in **`UDP Casambi Command`** mode. In that mode, per the
manual's own sentence, `/set/*` and `/get/*` **are not processed**. Conversely, putting the gateway
in `WebApi` mode to gain REST would **silence the UDP event plane Local Mode 1 depends on**.

> ⚠️ This also means a naive Local Mode 2 rollout could *break a working Local Mode 1 site* if an
> installer switches the gateway's mode. Mode is gateway-global, not per-client.

### 2.3 Confidence and what would disprove it

**Confidence: high** (explicit, unambiguous sentence in the endpoint chapter). **Not yet
hardware-verified.** It is conceivable the firmware processes REST regardless of mode and the
sentence is stale. That single question is the highest-value hardware test in this project:

**HW-VALIDATION-001** — with the gateway in `UDP Casambi Command` mode, call
`GET /set/target_value?type=1&id=<unit>&duration=0&value=128` with the API key.
*If it returns `ok` and the light responds → the hybrid is viable on one gateway and Option A wins.*
*If it returns nothing/error or is refused → exclusivity confirmed; choose Option B or C.*

This is a five-minute test on the user's existing hardware and **should be run before Phase 2**.

---

## 3. Architecture options

| | **A. UDP + REST (as briefed)** | **B. Two gateways per network** | **C. MQTT-primary (recommended)** |
|---|---|---|---|
| Gateway mode | one gateway, both planes | GW1 `UDP Casambi Command`, GW2 `WebApi` | one gateway, `MQTT` |
| Events | UDP push | UDP push (GW1) | MQTT push (`get/*` topics) |
| Commands | REST | REST (GW2) | MQTT `set/*` topics |
| Authoritative readback | `/get/target_value` | `/get/target_value` (GW2) | `get/poll_device` / `poll_broadcast` |
| Viability | **blocked unless HW-VALIDATION-001 passes** | viable; needs 2× hardware | viable on existing hardware |
| Cost | none | one extra gateway per network | none |
| Command surface | REST set (13 endpoints) | same | **superset of REST** (see §4.3) |
| Polling required | no | no | no |
| Risk | premise unverified | hardware/BOM + routing complexity | MQTT broker dependency (local) |

### 3.1 Why Option C is recommended

* It is the **only option that meets every stated objective on existing single-gateway hardware**.
* Its command surface is a **superset** of REST — `set/scene_level` and `set/group_level` exist as
  first-class topics, which REST only reaches indirectly via `type`/`id`.
* It is **push-based in both directions**, so the "don't poll every device" scale requirement is
  satisfied structurally rather than by careful engineering.
* A local MQTT broker is already part of this deployment (`mosquitto` runs on the hub — confirmed
  in `ss -ltnp`: `127.0.0.1:1883`), so there is **no new infrastructure**.

### 3.2 Why the brief's Option A is still worth testing first

If HW-VALIDATION-001 passes, Option A is the least disruptive to the existing mental model and the
user's stated preference. It costs five minutes to find out. **Do not build either until this is
answered.**

---

## 4. Verified protocol surfaces

### 4.1 Local REST (`WebApi` mode) — fully verified, v6.38 §5.16

**Target addressing** (`type`/`id`), identical to the UDP scheme:

| type | id | Meaning |
|---|---|---|
| 0 | 0 | Broadcast (default when type/id omitted) |
| 1 | 1–250 | Device |
| 2 | 0–255 | Group (0 = ungrouped) |
| 3 | 1–255 | Scene — only luminaires where the scene is active |
| 4 | 1–255 | Scene — all luminaires of the scene |

**Endpoints** (all answer `ok` / `error`; `duration` = fade in 10 ms steps, 0 = default, always optional):

| Endpoint | Parameters | Since |
|---|---|---|
| `/set/target_value` | `type`,`id`,`duration`,`value` — **all four mandatory** | 6.35 |
| `/set/load_shedding` | `level` 0–255 (0/255 = off, mandatory), `timeout` min, `type` (0 all/1 group/4 scene/7 button), `id` | 6.35 |
| `/set/color_temperature` | `value` Kelvin (mandatory), `type`,`id`,`duration` | 6.36 |
| `/set/color_rgbw` | `red`,`green`,`blue` mandatory 0–255; `white`, `level`, `type`,`id` optional (`level` omitted ⇒ 255 ⇒ unchanged) | 6.36 |
| `/set/color_huesat` | `hue` 0–65535, `sat` 0–255 mandatory; `white`,`level` optional (255 = no change) | 6.36 |
| `/set/color_xy` | `x`,`y` 0–65535 mandatory | 6.36 |
| `/set/vertical` | `value` 0–255 mandatory — **"ratio of direct/indirect light"** | 6.36 |
| `/set/dimmers` | `index` 0–3, `value` 0–255 mandatory | 6.36 |
| `/set/elements` | `index` 0–7 + `value`, **or** `values=v0,…,v7` (exactly 8) | 6.36 |
| `/set/resume_automation` | `type`,`id` | 6.36 |
| `/set/presence` | `value` 0/1 — **network-wide, no target** | 6.36 |
| `/set/lux` | `value` 0–65535 — **network-wide, no target** | 6.36 |
| `/set/button` | `id` 1–8, `event` 1=pressed/0=released — **network-wide** | 6.36 |
| `GET /get/target_value` | → JSON `level`, `poll_level`, `color_temperature`, `red/green/blue/white`, `hue/sat`, `x/y`, `vertical`, `online` | 6.36 |
| `GET /get/load_shedding` | → JSON `level`, `active`, `remaining_s` | 6.36 |

**Authentication** (§5.16.5, since 6.35 / all endpoints since 6.36): API key sent as
`X-API-Key: <key>`, `Authorization: Bearer <key>`, or `&api_key=<key>`.
Constant-time SHA-256 comparison; separate brute-force lockout from the web login; **not** included
in configuration import. Max 64 chars `[A-Za-z0-9-_]`. Empty field disables the check.

> **Use `X-API-Key`.** Never the URL parameter — it would leak the key into gateway logs, our own
> traces and diagnostics.
> This key is **distinct** from the existing `gatewayUsername`/`gatewayPassword` (the gateway's web
> login, used for HTTP Basic auth on Local Mode 1's one REST write endpoint). Three separate
> credential concepts now exist and must not be conflated: Casambi Cloud API key, gateway web
> login, gateway REST API key.

### 4.2 `/get/target_value` is the reconciliation primitive

It returns **both** `level` (last commanded) and `poll_level` (actual polled state), plus
authoritative `color_temperature` **in Kelvin**. This directly solves the documented CCT gap: the
UDP type-10 notification is a *normalised* 0–255 byte with no per-fixture range, so Local Mode 1
honestly reports `kelvin: null`. Local Mode 2 can report real Kelvin without changing that
assumption for Local Mode 1.

### 4.3 MQTT (`MQTT` mode) — verified, v6.38 §5.8

**Command topics** (`casambi/[id]/set/…`): `level`, `scene_level`, `group_level`,
`push_button_level`, `target_level`, `target_tc`, `target_rgbw`, `target_huesat`,
`target_vertical`, `target_dimmers`, `target_elements`, `execute_automation`, `load_shedding`,
plus sensor injection `light_sensor`, `pir_sensor`, `push_button_pressed`/`released`, and a DALI
sub-surface (`dali/read_dali_nodes`, `…node_details`, `…memory`).

**State/event topics** (`casambi/[id]/get/…`): `poll_device`, `poll_broadcast`, `node_deleted`,
`element_slider`, `load_shedding`, and per-device element/dimmer polling.

`poll_broadcast` payload shape (§5.8.3):
```json
{ "level": 0, "last_level": 255, "cct_level": 127, "vertical": 130, "last_change": 79712 }
```

Note `element_slider` returns `slider_1 … slider_8` — an **indexed** view of the custom-element
sliders, which is precisely the information Local Mode 1 cannot obtain (see §4.5).

### 4.4 UDP (`UDP Casambi Command` mode) — already implemented

Unchanged from the existing reference doc. Retained for Local Mode 1 and, under Option B, for
Local Mode 2's event plane.

### 4.5 The curtain question, revisited

Local Mode 1's open/close works via `0x3F SetTargetElements` on elements 0/1, but **set-position is
honestly unimplemented** because the motor reports its slider in *short form* (no element index)
and the Casambi app writes it over BLE, so the gateway never reveals a writable index.

Local Mode 2 has **three new routes to solve this**, in order of likelihood:

1. **`/set/elements?values=v0,…,v7`** — writes **all eight elements at once**, so the unknown index
   stops mattering: read the current 8 values, change the slider one, write the set back. This is
   the most promising and is *documented*, not inferred.
2. **MQTT `get/element_slider`** — returns `slider_1…slider_8` explicitly, which would *reveal the
   index directly*, closing the exact information gap that blocked Local Mode 1.
3. **`/set/vertical`** — documented as "ratio of direct/indirect light", i.e. a luminaire property,
   **not** a shade position. Test it, but do not expect it to be the answer.

> **Status: UNVERIFIED.** Do not claim percentage positioning until HW-VALIDATION-004 (§13) passes.

### 4.6 IR blaster

**No `/set/ir` endpoint exists** — confirmed by exhaustive search of v6.38. The only plausible route
is custom elements (`/set/elements`). Semantics are device-specific and must not be invented:
the transport layer exposes raw elements 0–7; a *profile* layer may name them only after
per-device hardware validation. **Status: UNVERIFIED (HW-VALIDATION-005).**

---

## 5. Data model — multi-site, multi-network, multi-gateway

The existing driver is implicitly single-network: `this.units` is keyed by bare numeric unit id, and
`backendId` is `casambi:<unitId>`. **That collides across networks** and must not be reused.

```
Site
 └── CasambiNetwork (networkKey)        ← identity, NOT derived from gateway IP
      ├── LithernetGateway (gatewayId)  ← 1..N gateways may serve ONE network
      │    ├── transport: udp | rest | mqtt
      │    ├── health (independent)
      │    └── role: events | commands | both
      ├── CasambiUnit (unitId 1..250)
      ├── CasambiGroup (groupId 0..255)
      └── CasambiScene (sceneId 1..255)
```

### 5.1 Canonical identity

```ts
/** Globally unique, collision-free across networks and gateways. */
type CasambiV2DeviceKey = `casambi2:${NetworkKey}:${UnitId}`;
type CasambiV2GroupKey  = `casambi2:${NetworkKey}:g${GroupId}`;
type CasambiV2SceneKey  = `casambi2:${NetworkKey}:s${SceneId}`;
```

* `NetworkKey` is a **stable, network-scoped identifier**, never the gateway IP (IPs change; the
  reference doc already records this project being bitten by that). Derive it from the Casambi
  Cloud network id where enrichment ran, else an installer-assigned stable key.
* **Network ≠ gateway.** They are separate entities with a many-to-many edge, per the brief.
* Command routing resolves `device → network → gateway(s) → transport`. A command is **never**
  broadcast across gateways; a network with several gateways picks one by health/role policy.

### 5.2 Why not reuse `casambi:<unitId>`

Local Mode 1's `backendId` scheme is retained untouched for Local Mode 1. Local Mode 2 uses the
`casambi2:` prefix so the two can coexist on one hub without any possibility of a device-registry
collision, and so a site can migrate mode-by-mode.

---

## 6. Protocol responsibility matrix

Two columns: the brief's intent, and what each option can actually deliver.

| Function | Briefed | Option A (if HW-001 passes) | Option C (MQTT) |
|---|---|---|---|
| Live device discovery | UDP | UDP | MQTT `get/poll_*` |
| Real-time state events | UDP | UDP | MQTT push |
| Button / sensor / presence events | UDP | UDP | MQTT push |
| ON/OFF, dimming, fade | REST | `/set/target_value` | `set/target_level` |
| RGB / RGBW | REST | `/set/color_rgbw` | `set/target_rgbw` |
| HSV | REST | `/set/color_huesat` | `set/target_huesat` |
| XY | REST | `/set/color_xy` | *(verify topic exists)* |
| CCT command | REST | `/set/color_temperature` | `set/target_tc` |
| **CCT authoritative state** | REST | `/get/target_value` | `get/poll_device` |
| Group command | REST | `type=2` | `set/group_level` (first-class) |
| Scene command | REST | `type=3\|4` | `set/scene_level` (first-class) |
| Multi-dimmer 0–3 | REST | `/set/dimmers` | `set/target_dimmers` |
| Custom elements 0–7 | REST | `/set/elements` | `set/target_elements` |
| Curtain open/close | REST | `/set/elements` | `set/target_elements` |
| Curtain set-% | **UNVERIFIED** | `/set/elements?values=` | `get/element_slider` + set |
| IR | **UNVERIFIED** | elements | elements |
| Presence / lux / button injection | REST | network-wide endpoints | `set/pir_sensor`, `light_sensor`, `push_button_*` |
| Load shedding | REST | `/set` + `/get/load_shedding` | `set`/`get/load_shedding` |
| Automation resume | REST | `/set/resume_automation` | `set/execute_automation` |
| State reconciliation | REST | `/get/target_value` | `get/poll_device` |
| Names / groups / scenes / fixtures | Cloud | Cloud (commissioning only) | Cloud (commissioning only) |

---

## 7. Command flow

```
SupremeOS: "Living Room → 50%"
        ↓
CasambiV2Driver.command(deviceKey, cmd)
        ↓
TargetResolver         device | group | scene | broadcast   →  (type, id)
        ↓
NetworkRouter          deviceKey → networkKey → gateway (health-aware)
        ↓
GatewayClient          bounded queue + rate limit + retry/backoff
        ↓
REST /set/*   or   MQTT set/*
        ↓
Lithernet Gateway → Casambi
```

The application layer never learns which transport was used — the brief's core requirement.

## 8. Event & state flow

```
Casambi → Gateway → (UDP | MQTT) → EventNormalizer → StateStore → SupremeOS
                                          ↑
                          Reconciler ── /get/target_value (authoritative)
```

**Reconciliation strategy (explicitly not per-device polling):**

1. **Optimistic** — apply commanded value immediately (existing UX).
2. **Event-confirmed** — the push event supersedes it, normally within ms.
3. **Targeted readback** — `/get/target_value` for *one* device only when a command produced no
   confirming event within a timeout. Cost is O(missed commands), not O(devices).
4. **Startup / gateway-restart resync** — broadcast-scoped read (`type=0`) plus per-group reads,
   never a per-device sweep.
5. **Slow drift sweep** — a bounded, low-priority round-robin (e.g. N devices/minute, tunable),
   sized so a 5000-device site completes a full pass on a documented schedule without ever
   exceeding the gateway's request budget.

## 9. Cloud enrichment flow (commissioning only)

```
Commissioning:  Cloud session (per NETWORK, deduplicated, cached)
                    ↓
        names · groups · scenes · fixture metadata
                    ↓
        persisted to the local model  ──►  Cloud never consulted again at runtime
```

**Scale rules:** one session per *network* (not per gateway, not per device), reference-counted and
reused; incremental/delta enrichment; retry with backoff; persistent cache keyed by `networkKey`.
A site with 100 networks opens at most 100 sessions, sequentially with bounded concurrency.

**Hard rule:** no runtime code path may depend on Cloud. Offline is an acceptance criterion (§12).

## 10. Persistence model

Persist (survives restart; hub is offline-first):

`Site · CasambiNetwork(networkKey, cloudNetworkId?, name) · LithernetGateway(id, ip, ports, mode,
role, credentials-ref) · Unit(unitId, name, fixtureId, capabilities) · Group(id, name, members) ·
Scene(id, name) · room mapping · last-known state · enrichment timestamps`

Startup: **load cached model → start transports → receive live signals → reconcile → optional Cloud
refresh.** A restart must never present an empty installation. Secrets are stored via the existing
encrypted driver-secret mechanism, never in the model blob.

## 11. Failure & health model

Independent health per **Cloud**, **Network**, **Gateway**, **REST**, **UDP/MQTT**. Gateway A
failing must not affect B/C/D; Cloud failing must not mark any gateway disconnected. Per-gateway
circuit breaker with backoff; commands to a down gateway fail fast with a real reason rather than
queueing unboundedly.

## 12. Scale model

Targets: ~100 networks, ~10 gateways/network, ~5000 devices.

* **Shared per-gateway connection** (one HTTP agent / one MQTT client), never per-device.
* **Bounded concurrency + FIFO queue + rate limit per gateway**; backpressure surfaced, not hidden.
* **No timer per device.** One reconciliation scheduler per gateway.
* **Batching** where documented (`/set/elements?values=`, group/scene targeting instead of N device
  commands — a group command is one request regardless of member count).
* **Event-driven by default**; polling only as the bounded fallback in §8.

## 13. Hardware validation register

| ID | Question | Blocks |
|---|---|---|
| **HW-001** | Does `/set/*` work while the gateway is in `UDP Casambi Command` mode? | **Entire option choice — run first** |
| HW-002 | Does MQTT mode deliver both `set/*` and `get/*` against this hardware? | Option C |
| HW-003 | Do group (`type=2`) and scene (`type=3/4`) targets actually actuate? | Group/scene control |
| **HW-004** | Can `/set/elements?values=v0..v7` set curtain position? Does `/set/vertical` do anything to a blind? | Curtain set-% |
| HW-005 | Do IR-blaster functions appear as custom elements? | IR |
| HW-006 | Do `/set/presence`, `/set/lux`, `/set/button` behave network-wide as documented? | Sensor injection |
| HW-007 | Is `/get/target_value.poll_level` genuinely the actual state (vs commanded)? | Reconciliation |
| HW-008 | Does load shedding require Casambi module fw ≥ 49.50 on this site? | Energy integration |

**Rule: no capability ships as available until its validation passes.** Unverified capabilities
render gated with the real reason, per `CLAUDE.md`.

## 14. Isolation guarantee

Local Mode 2 lives entirely under `services/protocols/src/casambi/v2/`. **Zero modifications** to
`casambi-driver.ts`, `cloud-transport.ts`, `local-transport/*`, `local-command-mapper.ts`,
`local-discovery.ts`, `entity-mapper.ts`, `command-engine.ts`, `event-engine.ts`,
`discovery-engine.ts`. Shared code is consumed **read-only** (types, `udp-codec` encoders) or
copied where sharing would create coupling. New `connectionType` value `local-v2` is *additive* to
the driver manifest; existing values keep their exact behaviour.

Two bugs observed in Local Mode 1 during this research are **documented, not fixed** here, per the
brief: (a) `capabilitiesFromUnit` returns `["onoff"]` for a control-less unit, which can mask a
still-undiscovered fixture; (b) the case-sensitivity control-merge issue was fixed earlier in this
branch — no further Local Mode 1 changes are proposed.

## 15. Testing strategy

* **Unit** — target resolution (all 5 target types), every endpoint's parameter mapping/ranges,
  auth header construction, network scoping, gateway routing, state parsing, identity collision
  (Network A/unit 20 vs Network B/unit 20).
* **Integration** — multi-network, multi-gateway, gateway failure isolation, Cloud failure,
  transport failure, stale state, reconnect, restart persistence, **offline acceptance**.
* **Regression** — the entire existing Casambi suite (1024 tests) must pass untouched. No existing
  test may be weakened to accommodate Local Mode 2.
* **Hardware** — the §13 register.

---

## 16. Decision required before Phase 2

1. **Run HW-001** (5 minutes, existing hardware) — does REST answer while in UDP mode?
2. **Choose the architecture** given the result:
   * HW-001 passes → **Option A**, exactly as briefed.
   * HW-001 fails → **Option C (MQTT)** recommended, or **Option B** if the site can add a second
     gateway per network and you prefer staying on REST.

Phase 2 (gap analysis) and Phase 3 (file-by-file plan) are ready to follow immediately once this is
settled — the remaining sections above are option-independent.
