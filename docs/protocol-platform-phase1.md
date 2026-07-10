# Commercial Protocol Platform — Phase 1 (Casambi + KNX)

This guide covers the Phase 1 protocol work: a **native Casambi driver** and the
completed **KNX** discovery + ETS import path. Both sit behind the existing
`INativeProtocolDriver` seam (`services/integration-layer/src/protocols/driver.ts`) —
nothing above the SIL changed, and the hub boots identically whether or not either
protocol is configured.

There are **no breaking changes**. Homeowners never see any of the terms below; these are
Installer/Developer concepts only.

---

## 1. Casambi (native Cloud REST + WebSocket)

Casambi is a Bluetooth-mesh luminaire ecosystem reached through Casambi Cloud. The driver
replaces the previous `ha-integration` manifest backend with a real native driver.

**Files** (`services/protocols/src/`):

| File | Responsibility |
| --- | --- |
| `casambi-codec.ts` | The only place that knows Casambi wire shapes. Derives capabilities per fixture from advertised `controls`; normalizes unit → Supreme state; translates commands → `targetControls`. Pure functions. |
| `casambi-transport.ts` | The only place that touches the wire. REST session/auth + network/state fetch, and the WebSocket wire (open/ping/controlUnit framing). `fetch` and `WebSocket` are injectable seams. |
| `casambi-driver.ts` | `CasambiProtocolDriver` — lifecycle, heartbeat, auto-reconnect, event → state, room mapping, health. |

### Enabling it — two ways, both wired

1. **Driver Manager UI** (recommended). The `supreme-casambi` manifest exposes an API-key /
   email / password / network-id config page; on save, the runtime builds the driver via the
   native-driver factory (`native-driver-factory.ts` → `casambi` case) and registers it live.
2. **Boot env vars** (headless / compose). Provide credentials via the sealed-secrets `*_FILE`
   convention (never plaintext env); the driver is added at boot when the API key **and**
   e-mail **and** password are present:

   ```bash
   SUPREME_CASAMBI_API_KEY_FILE=/run/secrets/casambi_api_key   # WebSocket-enabled key from Casambi
   SUPREME_CASAMBI_EMAIL=network-admin@site.example
   SUPREME_CASAMBI_PASSWORD_FILE=/run/secrets/casambi_password
   SUPREME_CASAMBI_NETWORK_ID=                                 # optional: faster session handshake
   ```

### One-tap setup — auto-commission with room mapping

`POST /v1/commissioning/auto {"protocol":"casambi"}` runs the full flow: discover every unit,
create any missing rooms **from the Casambi group names**, then commission + bind each fixture's
capabilities to the bus. This is the generic live-bus equivalent of the KNX ETS import, and is
covered end-to-end by `auto-commission.e2e.test.ts` (discover → rooms → commission → bind →
command reaches the driver). Individual fixtures can still be commissioned one at a time via the
normal `discover` → `commission` (with a chosen `roomId`) flow.

> The API key requires WebSocket entitlement — request it from Casambi Support. Availability
> of API keys is limited by Casambi.

### Behaviour

- **Capabilities are derived, never hard-coded.** A unit's advertised controls decide its
  Supreme capabilities: a `Dimmer` → `brightness`, `+Color`/`+CCT` → `color` (both RGB and
  tunable-white), a bare `OnOff` → `onoff`, a `Slider`/vertical → `position`, and sensor
  units → `sensor`.
- **Live state** arrives on the WebSocket as `unitChanged` events and is normalized to
  Supreme state. Initial state is also seeded from REST at connect.
- **Reliability.** A `PING` is sent inside the 5-minute keep-alive window; a dropped socket
  or an expired session (HTTP 410) triggers capped-exponential-backoff reconnect with a full
  re-auth + re-fetch, so no state is lost.
- **Automatic room mapping.** Discovery surfaces each luminaire's Casambi **group name** as
  `raw.room`, so commissioning maps fixtures to Supreme rooms with no manual step.
- **Health.** `driver.getHealth()` returns a credential-free snapshot
  (`connected`, `sessionActive`, `reconnects`, `units`, `lastEventAt`, `lastError`) for
  monitoring.
- **Secrets never log.** The API key, password and session id live only inside the transport
  instance; they never appear in logs or thrown errors.

### Commissioning binding shape

A binding's `address` is the Casambi unit id (`"casambi:45"` or a bare `"45"`), or set
`config.unitId`. One unit maps to one Supreme device; multiple capabilities (e.g.
`brightness` + `color`) bind to the same unit.

---

## 2. KNX — KNXnet/IP discovery + ETS import

The KNX driver runs on `knxultimate` (KNXnet/IP tunnelling, UDP 3671) behind the unchanged
`KnxConnection` abstraction. Phase 1 adds the two pieces the manifest promised:

### KNXnet/IP discovery (`knx-discovery.ts`)

`knxSearch()` multicasts a KNXnet/IP **SEARCH_REQUEST** to `224.0.23.12:3671` and parses each
**SEARCH_RESPONSE** into `{ address, port, individualAddress, name, multicastAddress, mac }`.
That is how the installer finds the IP interface/router to configure the driver's
`host`/`port`. The UDP socket is injectable, so the frame encoding is unit-tested without
real multicast.

Surfaced at `GET /v1/commissioning/knx/interfaces` (installer picks the gateway), or directly:

```ts
import { knxSearch } from "@supreme/protocols";
const interfaces = await knxSearch();   // e.g. [{ address: "192.168.1.10", name: "MDT IP Interface", ... }]
```

> KNX has no per-device discovery without a project — individual devices come from the ETS
> import below.

### ETS import + automatic device generator (already complete)

This was already implemented and wired in `@supreme/commissioning`
(`knx-import.ts` + `knx-project.ts`) and is reachable at `POST /v1/commissioning/import/knx`:

- **Group-address export** — `parseKnxGroupExport` reads both the "Group Addresses" CSV export
  and the `GroupAddress-Export` XML, normalizes every DPT spelling, infers capability from
  DPT + name (onoff / brightness / position / temperature / lock / sensor), groups a fixture's
  addresses, and **derives the room from the name**.
- **Full `.knxproj`** — `parseKnxProject` / `unzipKnxproj` read a real (optionally
  password-protected) ETS project, including its building → room → function structure, so
  device cards land in their real ETS rooms.

`InstallerServices.importKnx` then creates the rooms and binds every capability to its group
address. (An earlier duplicate of this parser was removed from `@supreme/protocols` in this
change — the commissioning implementation is the single source of truth.)

---

## 3. Verification

All of the below is green on this branch:

- `pnpm --filter @supreme/protocols run test` — 104 tests, incl. 39 Casambi codec/driver +
  KNXnet/IP discovery assertions (driver tested against a fake transport; frames/codecs pure).
- `services/gateway/src/auto-commission.e2e.test.ts` — full live-bus flow end-to-end:
  discover → create rooms from group names → commission → bind → a command reaches the driver.
- `pnpm run typecheck` / `pnpm run build` / `pnpm run test` — all tasks green (gateway 192).

---

## 4. Known gap — curated room-image library (Phase 1, Part 3)

The directive's Part 3 (ship a curated royalty-free room-image library with auto-matching and
caching) is **not delivered in this change**. High-resolution, genuinely royalty-free imagery
cannot be produced or sourced from this environment without fabricating or scraping assets,
which the directive explicitly forbids. The runtime plumbing that *consumes* room imagery
(name auto-match, per-room caching, and user upload) already exists on the homeowner surface;
what remains is the licensed asset set itself. This needs one of:

1. a licensed image pack (e.g. a paid Unsplash+/stock license) dropped into the app's asset
   bundle, or
2. a signed-off source list so the images can be fetched and cached at build time.

Point us at the licensed source and the auto-match + cache layer can be wired to it directly.
