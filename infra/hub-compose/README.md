# Supreme Home Hub — Docker Compose

The home hub is the **complete Supreme OS product**: identity, permissions,
automations, scenes, drivers, licensing and the AI assistant all run here and
work with **zero internet** (blueprint §1, §13). Supreme Cloud is optional.

## Topology

```
            host :8080  ── the ONLY published port (Supreme API)
                 │
        ┌────────┴─────────┐   supreme-edge (client-facing)
        │     gateway      │
        └────────┬─────────┘   supreme-core (internal, no host access)
   ┌─────────────┼───────────────────────────────┐
   │   postgres · redis · nats · mqtt             │
   └──────────────────────────────────────────────┘
```

Every device backend is a native Supreme protocol driver hosted directly by the
gateway/SIL — there is no external home-automation sidecar in this stack.

## Bring-up

```bash
cp .env.example .env        # fill in secrets (signing secret, DB pw)
docker compose up -d --build
# Supreme API now on http://<hub>:8080  (health: /healthz)
```

For a backend-free smoke test of the Supreme plane, set `SUPREME_BACKEND=mock`
in `.env` — the gateway serves the same contract with the in-memory adapter.
This is the Phase-0 vertical slice proven by `services/gateway` e2e tests.

## Services

| Service | Role | Host port |
|---------|------|-----------|
| `gateway` | Supreme API Gateway / BFF (REST + WSS) + SIL | **8080** |
| `postgres` | Supreme system of record | none |
| `redis` | sessions, presence, optimistic state | none |
| `nats` | JetStream event/command bus | none |
| `mqtt` | Mosquitto device bus | none |

## Security notes (§12)

- Only `:8080` (the Supreme API) is exposed; everything else is internal.
- `supreme-core` is an `internal` Docker network — no host or outbound access.
- Secrets come from `.env` locally and the hub's sealed key store in production.

## LAN access & local hostnames

`docker-compose.yml` already publishes `80`/`443` on every host network interface, not
just loopback (`0.0.0.0:80->80` in `docker ps`) — so the hub is reachable from other
devices on the LAN today via `https://<host-LAN-IP>`, no compose change needed. The
Caddyfile's site blocks handle the rest: the named block (`localhost`, or a real domain
via `SUPREME_DOMAIN`) is unchanged; a `:443`/`:80` catch-all now serves every other way
of reaching this machine — a LAN IP, `supremeos.local`, anything — using Caddy's
internal CA (self-signed; never attempts a real ACME cert for an IP or a `.local` name,
which would just fail).

### Trusting the local CA (stops the browser warning)

Caddy's internal CA is unique per deployment and lives in the `caddy-data` volume. The
Docker host itself already trusts it automatically (`certificate installed properly in
linux trusts` in `docker logs supreme-hub-proxy-1`) — this step is only for **other**
devices (a phone, a second laptop, Claude Desktop's underlying OS trust store) that hit
this hub over the LAN and would otherwise see a certificate warning.

1. Extract the root cert from the running proxy:
   ```bash
   docker exec supreme-hub-proxy-1 cat /data/caddy/pki/authorities/local/root.crt > supreme-local-ca.crt
   ```
2. Install `supreme-local-ca.crt` into the trust store of each device that needs a
   warning-free connection:
   - **Windows:** double-click the file → *Install Certificate* → *Local Machine* →
     *Trusted Root Certification Authorities*.
   - **macOS:** open in *Keychain Access*, drag into *System*, then set
     *Always Trust* on the cert.
   - **iOS:** AirDrop/email the file to the device, install via *Settings → General →
     VPN & Device Management*, then enable full trust under *Settings → General →
     About → Certificate Trust Settings*.
   - **Android:** *Settings → Security → Encryption & credentials → Install a
     certificate → CA certificate*.
   - **Linux:** copy to `/usr/local/share/ca-certificates/`, run
     `sudo update-ca-certificates`.

   Skipping this is fine for internal/dev use — the connection is still fully
   encrypted, the browser just shows an interstitial warning to click through.

### `supremeos.local` / `supreme.local`

Docker containers can't broadcast mDNS onto the host's LAN by default, so a `.local`
name isn't zero-config here. Two options, in order of effort:

- **Static hosts-file entry** (simplest): on each device that needs the friendly name,
  add `<host-LAN-IP>  supremeos.local` to its hosts file (`/etc/hosts` on macOS/Linux,
  `C:\Windows\System32\drivers\etc\hosts` on Windows — needs admin rights). Caddy's
  catch-all already accepts any hostname, so no server-side config is needed once the
  client resolves the name.
- **Real mDNS** (zero-config on every LAN device, more moving parts): run an Avahi
  reflector container on `network_mode: host` advertising `supremeos.local` for this
  machine's LAN IP. Not included here — add it only if the static-hosts-file approach
  proves too manual for your install base; it's a genuinely separate concern from the
  Caddy TLS termination this section covers.
