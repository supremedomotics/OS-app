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
   │   homeassistant (headless, hidden, no ports) │
   │   postgres · redis · nats · mqtt             │
   └──────────────────────────────────────────────┘
```

Home Assistant runs as a **headless, hidden** sidecar. It has **no published
ports**, lives only on the internal `supreme-core` network, and is reached
exclusively by the Supreme Integration Layer (SIL). End users and installers
never see HA's UI or branding (§7, §12, §17). The SIL owns the long-lived HA
token.

## Bring-up

```bash
cp .env.example .env        # fill in secrets (HA token, signing secret, DB pw)
docker compose up -d --build
# Supreme API now on http://<hub>:8080  (health: /healthz)
```

For a backend-free smoke test of the Supreme plane (no HA), set
`SUPREME_BACKEND=mock` in `.env` — the gateway serves the same contract with the
in-memory adapter. This is the Phase-0 vertical slice proven by
`services/gateway` e2e tests.

## Services

| Service | Role | Host port |
|---------|------|-----------|
| `gateway` | Supreme API Gateway / BFF (REST + WSS) + SIL | **8080** |
| `homeassistant` | Hidden headless backend (Phase 1) | none |
| `postgres` | Supreme system of record | none |
| `redis` | sessions, presence, optimistic state | none |
| `nats` | JetStream event/command bus | none |
| `mqtt` | Mosquitto device bus | none |

## Security notes (§12)

- Only `:8080` (the Supreme API) is exposed; everything else is internal.
- `supreme-core` is an `internal` Docker network — no host or outbound access.
- HA admin is effectively loopback-bound: it is unreachable from the LAN/host.
- Secrets come from `.env` locally and the hub's sealed key store in production.
