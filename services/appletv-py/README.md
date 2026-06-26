# Supreme Apple TV bridge (`appletv-py`)

A small FastAPI sidecar that fronts [`pyatv`](https://pyatv.dev) so the Node Apple TV
driver (`@supreme/protocols` → `AppleTvProtocolDriver`) can **pair with and fully
control** a tvOS Apple TV — transport (play/pause/stop/next/previous), volume, mute —
and read **what's playing**: the foreground app (Netflix, Disney+, Music…) and its
content (title, show·episode, artwork).

## Why a bridge?

Apple TV is controlled over the **Media Remote Protocol (MRP)**, which since tvOS 15 is
tunnelled over AirPlay 2 / Companion with HAP-style pairing (SRP + Curve25519) and is
fully encrypted. There is no production-grade pure-Node MRP stack; the de-facto
implementation is `pyatv` (Python). This bridge keeps that Python dependency — and the
**pairing credentials** (the only secret) — out of the Node plane. Credentials persist
to `/data` so a paired hub reconnects on boot without re-pairing.

## API

| Method & path | Purpose |
|---|---|
| `GET /healthz` | liveness + list of paired device addresses |
| `GET /scan` | discover Apple TVs on the LAN (mDNS) |
| `POST /pair/begin` `{address, protocol}` | start PIN pairing (the TV shows a code) |
| `POST /pair/pin` `{session_id, pin}` | submit the code; stores credentials |
| `POST /connect` `{address}` | open a control session (uses stored creds) |
| `POST /disconnect` `{address}` | drop the session |
| `POST /devices/{address}/command` `{action, volume?}` | control |
| `GET /devices/{address}/now_playing` | current app + content + transport (+ `has_artwork`) |
| `GET /devices/{address}/artwork` | current cover-art image bytes (404 if none) |

## Pairing flow (one time per device)

Modern Apple TVs usually need **two** protocols paired — `airplay` and `companion`.
Run the begin/pin pair twice, once per protocol:

```bash
# 1. Find the device
curl -s http://appletv:9300/scan | jq

# 2. Begin pairing (the Apple TV displays a 4-digit PIN on screen)
SID=$(curl -s -XPOST http://appletv:9300/pair/begin \
  -H 'content-type: application/json' \
  -d '{"address":"10.0.0.42","protocol":"airplay"}' | jq -r .session_id)

# 3. Enter the PIN shown on the TV
curl -s -XPOST http://appletv:9300/pair/pin \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"pin\":\"1234\"}"

# 4. Repeat steps 2–3 with "protocol":"companion"
```

After that the hub gateway (with `SUPREME_APPLETV_ENABLED=1` and `SUPREME_APPLETV_URL`
pointing here) binds the Apple TV as a Supreme `media` device and drives it like any
other player — the foreground app shows up as the media **source**.

## Cover art

`now_playing` reports `has_artwork`; the actual image is fetched out-of-band from
`GET /devices/{address}/artwork` so the (large) bytes never ride on every state delta.
The Node driver advertises a **client-reachable** URL in the media state's `artworkUrl`
— the gateway proxy `GET /v1/devices/{deviceId}/media/artwork` — which streams the bytes
through the edge. Set `SUPREME_PUBLIC_BASE_URL` on the gateway so that URL is absolute.

## Networking note (mDNS in Docker)

Discovery uses multicast mDNS, which does not cross Docker bridge networks reliably. In
`infra/hub-compose` this service is attached to the LAN-routable `supreme-edge` network,
which is enough for **unicast control by IP** once you know the address.

For reliable **discovery** from inside Docker, use the host-networking overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.appletv-host.yml up -d
```

It runs the bridge with `network_mode: host` (so LAN multicast reaches it) and points the
gateway at `http://host.docker.internal:9300`. Linux only (host networking is a no-op on
Docker Desktop); needs Compose v2.24+ for the `!reset` tag. Without it you can still pair
by passing the Apple TV's IP to `/pair/begin` directly — control works without discovery.

## Tests / CI

Tests run against an in-memory `FakeBackend` (no pyatv, no hardware), so the full
contract — discover → pair → connect → control → now-playing — is verified in CI. Set
`SUPREME_APPLETV_FAKE=1` to run the live service against the fake for a no-hardware
smoke test. The real `PyatvBackend` is selected by default; `pyatv` is imported lazily
so the module loads (and tests pass) even where pyatv isn't installed.
