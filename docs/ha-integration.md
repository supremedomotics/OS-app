# Home Assistant integration & verification (readiness §2)

The Supreme Integration Layer (SIL) is the only component that talks to Home
Assistant. This doc covers how the HA path is verified and how to validate it
against a **real** HA before release.

## What's automatically tested

- **`ha-ws-transport.test.ts`** — a fake HA WebSocket server proves the auth
  handshake, `call_service` mapping, and `state_changed` normalization end-to-end.
- **`ha-adapter.test.ts`** — deterministic resilience: command buffering while
  disconnected → flush on connect, discovery → capability mapping, state-event
  normalization (mapped entities only), and re-buffering on a dropped socket.
- **`sil.test.ts` / `routing-adapter.test.ts`** — the SIL facade + native-migration
  routing.

These run in CI with no HA present.

## Validating against a real HA (gated) — VERIFIED

`ha-live.test.ts` runs only when a real HA is provided; it's skipped otherwise. It
has been run against a real HA instance (auth handshake + entity discovery pass).

```bash
# 1. Launch a standalone HA (publishes localhost:8123 — test harness only)
docker compose -f infra/hub-compose/docker-compose.ha-test.yml up -d

# 2. Headlessly onboard + mint a token (no manual clicks)
TOKEN=$(HA_URL=http://127.0.0.1:8123 bash scripts/dev/ha-onboard.sh)

# 3. Run the gated test against it
SUPREME_HA_TEST_URL=ws://127.0.0.1:8123/api/websocket \
SUPREME_HA_TEST_TOKEN=$TOKEN \
  pnpm --filter @supreme/integration-layer test
```

## HA-upgrade regression gate

`.github/workflows/ha-regression.yml` runs the gated SIL suite against a **matrix of
HA versions** (manual dispatch + weekly), each headlessly onboarded. Running the
same suite across version N and N+1 IS the upgrade gate — bump the matrix as HA
releases to catch a regression before it ships (the blueprint's top risk).

To exercise the **full stack** against real HA, run the gateway with
`SUPREME_BACKEND=ha`, `SUPREME_HA_URL`, and `SUPREME_HA_TOKEN`, then map Supreme
devices to HA entities and drive them from the app.

## Remaining before "production-ready" (tracked in production-readiness.md §2)

- [ ] HA-upgrade regression suite — pin the HA version, run the gated test across an
      upgrade gate (the blueprint's top risk: an HA update breaking the SIL).
- [ ] Discovery mapping verified against the full breadth of real HA domains.
- [ ] End-to-end against real devices (KNX/Zigbee/Matter) through HA.
- [ ] Headless-HA leak audit (no Lovelace/onboarding exposed; admin on loopback).
