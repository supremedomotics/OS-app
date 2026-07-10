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

### Enabling it

Provide credentials via the sealed-secrets `*_FILE` convention (never plaintext env). The
driver is added at boot only when the API key **and** e-mail **and** password are present:

```bash
SUPREME_CASAMBI_API_KEY_FILE=/run/secrets/casambi_api_key   # WebSocket-enabled key from Casambi
SUPREME_CASAMBI_EMAIL=network-admin@site.example
SUPREME_CASAMBI_PASSWORD_FILE=/run/secrets/casambi_password
SUPREME_CASAMBI_NETWORK_ID=                                 # optional: faster session handshake
```

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

```ts
import { knxSearch } from "@supreme/protocols";
const interfaces = await knxSearch();   // e.g. [{ address: "192.168.1.10", name: "MDT IP Interface", ... }]
```

> KNX has no per-device discovery without a project — individual devices come from the ETS
> import below.

### ETS import + automatic device generator (`knx-ets.ts`)

Installers hand over a project's **group addresses** as an ETS export. `parseEtsGroupAddresses`
accepts both the "Group Addresses" **CSV** export and the `GroupAddress-Export` **XML**
(integer or slash addresses), normalizing every DPT spelling (`DPST-1-1`, `DPT-1`, `1.001` →
`DPT1.001`). `generateKnxDevices` then folds the flat address list into Supreme devices:

- a fixture's **Switch / Dimming / Status** addresses are grouped by name;
- capability is derived from **DPT + name** — DPT1 → `onoff` (or `position` for a blind),
  DPT5 scaling → `brightness` (or `position` by name), DPT9 float → temperature `sensor`;
- **Status** group addresses are wired to the binding's `config.statusAddress`.

The output binds 1:1 onto `KnxProtocolDriver`, so importing an ETS file yields working
devices with no hand-mapping.

```ts
import { parseEtsGroupAddresses, generateKnxDevices } from "@supreme/protocols";
const devices = generateKnxDevices(parseEtsGroupAddresses(fileContents));
```

---

## 3. Verification

All of the below is green on this branch:

- `pnpm --filter @supreme/protocols run test` — 111 tests, incl. 39 Casambi + 17 KNX
  discovery/ETS assertions (driver tested against a fake transport; frames/codecs pure-tested).
- `pnpm run typecheck` / `pnpm run build` / `pnpm run test` — 93/93 tasks.
- Gateway boot wiring + config are covered by the existing gateway suite (191 tests).

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
