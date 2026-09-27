# Direct LAN Discovery (mDNS / port 7272) — apps/new Mobile & Touch Panel

> Status: implemented (Hub-side responder + direct listener) and integration-tested at the
> socket level. Not yet wired into a shipped `apps/new` UI (no Setup/Home-selection screen
> exists yet to consume `discoverAllLan()`'s multi-Hub result — see "Known limitations" below).

## What this is for

`apps/new` (the Mobile / Touch Panel Flutter client stack, distinct from `web-homeowner`/
`web-installer`) needs to find a SupremeOS Hub on the local network without a hardcoded IP or
manual entry. This document describes the resulting architecture end to end.

```
SupremeOS Hub
     │
     ├── Existing Web API (UNCHANGED by this work)
     │      └── services/gateway on :8080 (internal) ── Caddy reverse proxy ── :443 (HTTPS)
     │             consumed by: web-homeowner, web-installer (browser clients)
     │
     └── Direct LAN API (NEW)
            └── the SAME services/gateway Fastify instance, ALSO listening on :7272 (plain HTTP)
                   ▲
                   │  TCP connect, full REST/WSS API, same auth as :8080
                   │
             `_supremeos._tcp.local` (DNS-SD instance name: "<hubId>._supremeos._tcp.local")
                   ▲
                   │  PTR / SRV / TXT / A records
                   │
             mDNS responder (services/gateway/src/mdns-responder.ts)
             UDP multicast 224.0.0.251:5353
                   ▲
                   │  PTR query for `_supremeos._tcp.local`
                   │
        Mobile / Touch Panel client (apps/new/shared/lib/src/connection/mdns_hub_discovery.dart)
```

Key facts, stated plainly because they're easy to get wrong:

- **mDNS only discovers the Hub's address.** It never grants access. The connection made to
  the discovered address goes through the exact same authenticated API as everything else.
- **`hubId` is the stable identity, not the IP.** A Hub's LAN address can change (DHCP lease
  renewal, router reboot); `hubId` (a persisted UUID, see `loadOrCreateHubIdentity` in
  `services/gateway/src/hub-agent.ts`) does not. Never key a "is this the same Hub I paired
  with before" decision off `address`/`host`.
- **The existing web architecture is untouched.** `web-homeowner`/`web-installer` still go
  through Caddy on 443 exactly as before this work; nothing about that path changed.

## The TXT record contract (versioned, locked)

Defined once, server-side, in `services/gateway/src/mdns-responder.ts` as
`MDNS_TXT_SCHEMA_VERSION` (currently `"1"`), and read client-side by `HubMdnsTxtKeys` in
`apps/new/shared/lib/src/connection/mdns_hub_discovery.dart`. Both sides must agree on this
list — it is the actual interface between the two, not an implementation detail of either.

| Key | Required | Meaning |
|---|---|---|
| `hubId` | yes | Stable Hub identity (`loadOrCreateHubIdentity().hubUuid`) — survives reinstall, rename, IP change. |
| `version` | yes | The Hub's own software version (`config.hubVersion`) — for a client gating a feature on a minimum Hub version. |
| `txtvers` | yes | **This TXT contract's own schema version** (not the Hub's software version — a separate axis). Bump only on a breaking change (a key removed, or an existing key's meaning changed); adding a new optional key is not breaking. |
| `projectId` | no | The commissioned home's id. Absent before Setup Wizard commissioning — a fresh client must be able to find the Hub before a home even exists. |

Deliberately **excluded**, and not to be added without a real, reviewed reason: any
credential/token/secret (mDNS TXT is unauthenticated, unencrypted UDP anyone on the LAN can
read), a display name (installer-set, home-scoped — lives behind the authenticated API, not
broadcast pre-auth), device/model/capabilities (a connected client asks the authenticated API
for this; it doesn't need it before it even connects). A future genuinely-needed
unauthenticated hint (e.g. "setup required: yes/no", so a fresh app can distinguish a
ready-to-pair Hub from an already-commissioned one before connecting) should be added as its
own reviewed key, not folded into the reasoning above by default.

## Port behavior

| Port | Config | Protocol | Purpose |
|---|---|---|---|
| 8080 | `SUPREME_PORT` (default 8080) | HTTP (internal only) | Existing internal listener, unchanged. Caddy fronts this with HTTPS on 443 for browser clients. |
| 7272 | `SUPREME_DIRECT_PORT` (default 7272) | HTTP (plain, LAN) | The SAME Fastify instance/router as 8080 — every route, every auth check, identical. `0` disables this second listener entirely. An invalid value (non-numeric, negative, `> 65535`) fails safe to the default 7272, never to `NaN` or a garbage port. |
| 5353 (UDP) | fixed | mDNS/DNS-SD | Multicast query/response for `_supremeos._tcp`. Not itself a control channel — it only tells a client where 7272 is. |

## Security model

**LAN discovery does not equal authorization.** This is the property that actually matters,
and it holds because 7272 is the identical Fastify `app` instance as 8080 — `app.listen()` is
called twice on the same instance in `services/gateway/src/main.ts`, so every route
(`registerAuthRoutes`, `registerDeviceRoutes`, …), every `authenticate(ctx, req)` call inside a
route handler, every `enforce()` permission check, applies exactly the same regardless of
which port the request arrived on. There is no separate, weaker code path for 7272.

What is genuinely different from 8080/443, and an accepted, explicit tradeoff for this client
architecture rather than an oversight:

- **7272 is plain HTTP, not TLS.** 8080 is only ever reached internally (Caddy terminates TLS
  in front of it for browser clients); 7272 is reached directly, in the clear, on the LAN. A
  credential/session token sent over 7272 is visible to anything else on the same LAN
  segment doing packet capture. This was the explicit, deliberate choice for this client
  generation ("same gateway API, plain HTTP on 7272" — see this feature's own design
  decision). If that posture needs to change later, the natural next step is TLS on 7272
  mirroring Caddy's on-demand internal-CA policy (`infra/hub-compose/Caddyfile`) — not
  attempted here.
- **mDNS TXT records are unauthenticated, unencrypted, and public to the LAN by construction.**
  This is why the TXT contract above is deliberately minimal (see "Deliberately excluded"
  above) — nothing in it is sensitive, and nothing in it grants access on its own.
- **Pairing/authentication remains mandatory.** Discovering `_supremeos._tcp` and knowing a
  Hub's `hubId`/address does not let a client control anything; it still has to go through
  the existing pairing (`/v1/pairing/*`) or login flow, over the connection itself, exactly as
  it would over 8080/443.

## Multi-interface / restart behavior

- The responder re-resolves the host's real (non-internal) IPv4 interfaces on **every incoming
  query**, not once at startup — a NIC that appears after boot (Wi-Fi reconnects, a DHCP
  renewal changes the address) is picked up on the next query with no separate watch/poll loop
  needed.
- Multicast group membership is joined **per-interface** (not just the OS's single default
  route), so a multi-homed Hub (Ethernet + Wi-Fi both up) answers queries arriving on either
  one.
- The responder is **query-triggered only** — it never sends unsolicited announcements, so a
  restart can never produce a "duplicate advertisement": the next query after restart simply
  gets the same, correct answer from the (single) responder that's running now.
- Shutdown is wired into the gateway's existing `SIGINT`/`SIGTERM` handler
  (`services/gateway/src/main.ts`'s `shutdown()`) — the responder's socket is closed before the
  process exits, same as every other resource it tears down.

## Native Linux deployment (systemd / firewall)

This project's native-linux install/deploy scripts (`infra/native-linux/`) do **not** manage
firewall rules today (confirmed: `supremeos-support.sh` only ever *reads* `ufw`/`iptables`
status for a diagnostics bundle — it never writes a rule). This document does not add any
firewall automation, per that existing posture. If the target host has a restrictive firewall
enabled, an installer needs to explicitly allow:

- **UDP 5353** (multicast) — for the mDNS responder to receive queries and reply.
- **TCP 7272** — for the direct client API itself.

Both are LAN-only concerns; neither needs to be reachable from outside the LAN (remote access
already goes through the existing outbound-only relay/broker tunnel, untouched by this work).

## Known limitations (honestly stated, not silently worked around)

- **No shipped `apps/new` UI consumes this yet.** `mdns_hub_discovery.dart`'s
  `discoverAllLan()` already returns every Hub visible on the LAN (supports multiple Hubs
  today), but there is no Setup/Home-selection screen in this repo yet that remembers a
  chosen `hubId`, prefers it on relaunch, or lets the user switch Hubs. Building that flow is
  a separate, UI-shaped piece of work, not attempted here — don't claim "multi-Hub selection
  works end to end" until that screen exists and is tested.
- **IPv4 only.** No AAAA/IPv6 support in the responder. Every existing LAN discovery mechanism
  in this codebase (KNXnet/IP search, SSDP, the existing mDNS browse-side codec) is IPv4-only
  too, so this matches the codebase's existing posture rather than introducing a new gap.
- **7272 is plain HTTP** (see Security model above) — an accepted tradeoff for this client
  generation, not a gap this document is hiding.
- **AP/Wi-Fi-BSSID → Space auto-switching is explicitly out of scope** (a future, separate
  feature) and nothing here hard-codes against it — `HubDiscovery`/`DiscoveredHub` don't
  assume anything about Wi-Fi access points, so that future work can compose with this one
  without a rewrite, but no abstraction for it was speculatively added here (avoid
  unnecessary architecture for a feature that isn't being built yet).
