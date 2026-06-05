# Supreme OS — Production Readiness Checklist

> Living document. Tracks the work between "feature-complete (Phases 0–4)" and
> "deployable in paying customers' homes." Update the status boxes as items land.
> Rough overall readiness today: **~55%** (feature breadth high; hardening, real
> hardware/protocol integration, deploy, and operability are the remaining bulk).

Legend: `[x]` done · `[~]` partial · `[ ]` not started

## 0. Scorecard (by dimension)

| Area | Status | Notes |
|------|--------|-------|
| Architecture & contracts | ~90% | SIL seam, domain model, contract-first, migration routing |
| Feature breadth (P0–4) | ~85% | All phases + e2e; some MVP-depth surfaces |
| Automated testing | ~70% | unit/e2e/PGlite/fake-HA/real-LLM-gated; no load/soak/hardware |
| Persistence | ~70% | security panel, fleet, license cache still in-memory |
| Real HA integration | ~40% | verified vs a fake HA only — see §2 |
| Drivers & protocols | ~30% | manifests only; no real bus adapters |
| Native migration engine | ~35% | routing proven; native adapter is in-process |
| Security hardening | ~35% | see §1 |
| Infra / deploy | ~40% | hub compose only; no cloud IaC/CD/OTA |
| Observability / ops | ~20% | logs only; no metrics/tracing/alerting |
| Mobile / web delivery | ~45% | compiles; no store pipeline/push |
| Optional cloud (relay) | ~10% | remote-access relay not built |

---

## 1. Security hardening  ← CRITICAL PATH (in progress)

- [x] Fail-closed config: refuse to boot in production with the dev token secret / weak secrets
- [x] HTTP security headers (helmet) on the gateway
- [x] CORS allow-list (no wildcard in production)
- [x] Rate limiting (global + strict on `/v1/auth/*`) to blunt brute force
- [x] Request body size limits (1 MB JSON cap)
- [x] Refresh-token rotation + revocation (session-bound; reuse → session revoked; logout); sessions persisted (Postgres) so revocation survives restarts
- [x] MFA enrollment + TOTP verify flow wired end-to-end (RFC 6238, no external dep)
- [~] Sealed secret store — `*_FILE` convention (Docker/K8s secrets) supported; full vault/age integration later
- [ ] mTLS for the hub↔cloud tunnel
- [ ] TLS termination + HSTS for the hub API (reverse proxy)
- [ ] Per-command authorization re-check at services (defense in depth) — partially done at gateway
- [x] Dependency & container image scanning in CI (pnpm audit + Trivy fs: vuln/secret/misconfig)
- [ ] Third-party penetration test + authz matrix test suite
- [ ] Secrets never logged; audit log shipped off-box (tamper-evident already ✓)

## 2. Real Home Assistant integration  ← CRITICAL PATH (next)

- [x] HA WebSocket transport (auth/handshake/call_service/state) — vs a fake HA
- [x] Capability mapper for light/climate/cover/media/lock/sensor
- [x] Resilience tests: command buffering while disconnected → flush on reconnect
- [x] Reconnect/backoff after socket drop (transport schedules reconnect; adapter re-buffers)
- [~] Discovery mapping verified (against fake payloads; real-HA breadth pending)
- [x] Gated live-HA integration test (`SUPREME_HA_TEST_URL` / token) — skipped without HA
- [x] HA test harness compose (`docker-compose.ha-test.yml`) + bring-up doc
- [ ] HA-upgrade regression suite (pinned version + tested upgrade gate) — top blueprint risk
- [ ] Headless HA hardening verified (no Lovelace/onboarding leak; loopback admin)
- [ ] End-to-end against real devices (KNX/Zigbee/etc.) through HA

## 3. Drivers & protocols

- [x] Driver SDK + signing + license gating + lifecycle
- [ ] Real first-party adapter code (KNX/DALI/Casambi/Zigbee/MQTT/Modbus/Matter)
- [ ] Real protocol commissioning (replace simulators in `commissioning-py`)
- [ ] Driver sandboxing + security scan in the certification pipeline
- [ ] Native (non-HA) protocol stacks behind `SupremeNativeAdapter`

## 4. Persistence & data

- [x] Postgres system-of-record for identity/home/scenes/grants/drivers/automations/audit
- [ ] Persist security panel, active license, and fleet
- [ ] TimescaleDB (or partitioning) for `energy_samples` at volume
- [ ] Migration tooling for production upgrades (rollback-safe)
- [ ] Backups: off-site, scheduled, rotation, restore drills

## 5. Infra, deploy & scale

- [x] Hub Docker Compose (hidden HA + data plane)
- [ ] Wire Redis (sessions/presence) + NATS JetStream (event bus) — currently in-process
- [ ] Cloud IaC (Terraform/Pulumi) for licensing/fleet/relay
- [ ] CD with staged rollout + rollback; signed images
- [ ] OTA hub update channel
- [ ] Load / soak / chaos testing (HA restarts, network loss, event storms)

## 6. Observability & ops

- [ ] Metrics (Prometheus) + dashboards
- [ ] Distributed tracing (OpenTelemetry)
- [ ] Alerting + on-call runbooks; SLOs
- [ ] Structured request logging with correlation ids (partial: pino)
- [ ] Health/readiness probes beyond `/healthz`

## 7. Clients (mobile / web)

- [x] Flutter app compiles + analyzes; widget smoke test
- [ ] App-store build/signing pipeline (iOS/Android) + internal installer track
- [ ] Push notifications (with on-LAN degrade)
- [ ] Offline/error UX depth; reconnect/backoff on WSS
- [ ] Golden tests for Aureon widgets; accessibility + i18n
- [ ] Web homeowner app (only installer portal exists today)

## 8. Optional cloud

- [ ] Remote-access relay (outbound mTLS tunnel, no inbound ports)
- [ ] Off-site backup service + driver-store mirror/CDN
- [ ] Multi-home fleet deploy (service exists; needs cloud deploy + portal wiring ✓ page)

---

## Critical path (recommended order)

1. **Security hardening (§1)** — fail-closed secrets, headers, CORS, rate limiting, token rotation.
2. **Real HA integration (§2)** — resilience tests, gated live-HA test, upgrade regression.
3. **Wire Redis/NATS + persist remaining state (§4/§5)** for real multi-process scale.
4. **Cloud IaC + CD + observability (§5/§6)**.
5. **Real drivers/protocols (§3)** and **remote-access relay (§8)**.
