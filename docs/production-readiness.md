# Supreme OS — Production Readiness Checklist

> Living document. Tracks the work between "feature-complete (Phases 0–4)" and
> "deployable in paying customers' homes." Update the status boxes as items land.
> Rough overall readiness today: **~65%** (security, persistence, observability, and
> multi-process messaging now hardened; real hardware/protocol integration, cloud
> deploy/CD/OTA, and client delivery are the remaining bulk).

Legend: `[x]` done · `[~]` partial · `[ ]` not started

## 0. Scorecard (by dimension)

| Area | Status | Notes |
|------|--------|-------|
| Architecture & contracts | ~90% | SIL seam, domain model, contract-first, migration routing |
| Feature breadth (P0–4) | ~85% | All phases + e2e; some MVP-depth surfaces |
| Automated testing | ~70% | unit/e2e/PGlite/fake-HA/real-LLM-gated; no load/soak/hardware |
| Persistence | ~85% | identity/home/scenes/grants/drivers/automations/audit/sessions/security panel persisted; license + fleet have Postgres stores |
| Real HA integration | ~40% | verified vs a fake HA only — see §2 |
| Drivers & protocols | ~78% | KNX/MQTT/Modbus/Matter/Zigbee/DALI/AVR/CoolMaster drivers + bind API + portal UI + persistence; Casambi (closed BLE) + intercom/camera subsystem pending |
| Native migration engine | ~55% | routing proven; native engine fronts real KNX/MQTT/Modbus, bound devices route native |
| Security hardening | ~35% | see §1 |
| Infra / deploy | ~50% | hub compose + NATS/Redis wired via seam; no cloud IaC/CD/OTA |
| Observability / ops | ~60% | Prometheus `/metrics`, `/readyz`, OTel tracing; dashboards/alerting/SLOs pending |
| Mobile / web delivery | ~48% | compiles; camera RTSP→HLS/WebRTC backend; no store pipeline/push/player UI |
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
- [x] TLS termination + HSTS for the hub API (Caddy edge proxy; auto-HTTPS; gateway/portal no longer host-published)
- [ ] Per-command authorization re-check at services (defense in depth) — partially done at gateway
- [x] Dependency & container image scanning in CI (pnpm audit + Trivy fs: vuln/secret/misconfig)
- [x] Authz matrix test suite (every user-type × resource × action + escalation negatives)
- [ ] Third-party penetration test
- [ ] Secrets never logged; audit log shipped off-box (tamper-evident already ✓)

## 2. Real Home Assistant integration  ← CRITICAL PATH (next)

- [x] HA WebSocket transport (auth/handshake/call_service/state) — vs a fake HA
- [x] Capability mapper for light/climate/cover/media/lock/sensor
- [x] Resilience tests: command buffering while disconnected → flush on reconnect
- [x] Reconnect/backoff after socket drop (transport schedules reconnect; adapter re-buffers)
- [~] Discovery mapping verified (against fake payloads; real-HA breadth pending)
- [x] Gated live-HA integration test — VERIFIED against a real HA instance (auth + discovery)
- [x] HA test harness compose + headless onboarding script (`ha-onboard.sh`) + bring-up doc
- [x] HA-upgrade regression suite — automated CI matrix (`ha-regression.yml`) across HA versions, headlessly onboarded; the top blueprint risk now has a gate
- [ ] Round-trip command/state regression against demo entities + real-device breadth
- [ ] Headless HA hardening verified (no Lovelace/onboarding leak; loopback admin)
- [ ] End-to-end against real devices (KNX/Zigbee/etc.) through HA

## 3. Drivers & protocols

- [x] Driver SDK + signing + license gating + lifecycle
- [x] Native protocol-driver seam (`INativeProtocolDriver`) — `SupremeNativeAdapter`
      now fronts real bus stacks; bound devices route to a driver, unbound use the
      in-process model (`@supreme/protocols`)
- [~] Real first-party adapter code — **KNXnet/IP**, **MQTT** (Zigbee2MQTT/Tasmota),
      **Modbus TCP**, **Matter**, **native Zigbee** (ZCL via zigbee-herdsman), **DALI**
      (IEC 62386), **AVR** (Denon/Marantz IP — onoff + media over real TCP), and
      **CoolMasterNet HVAC** (VRF/VRV — onoff + climate over real TCP) land as real
      drivers (each tested vs a fake bus / embedded broker / in-process TCP server);
      Casambi (proprietary BLE — needs official Cloud-API access) is the notable
      remaining bus. **SIP door stations** map door-release→lock + ring→sensor (UA is a
      seam). **RTSP camera streaming** is handled correctly as a *stream source* (not a
      capability driver): `@supreme/cameras` resolves a camera's RTSP source into
      client-playable HLS/WebRTC via the on-hub go2rtc engine — see §7
- [~] Real protocol commissioning — bind API (`POST /v1/commissioning/bind`) places a
      commissioned device on a real bus; `ProtocolBinding`s persisted (Postgres) and
      re-bound on boot; installer-portal **Bus Binding** page wires devices to KNX/
      Modbus/MQTT addresses. **Real MQTT discovery** (Zigbee2MQTT `bridge/devices` →
      Supreme capabilities) + **discover→commission→auto-bind in one step** (a device
      discovered on a bus is bound to it on commission); KNX/DALI native scans and
      retiring the `commissioning-py` simulators still pending
- [ ] Driver sandboxing + security scan in the certification pipeline
- [x] Native (non-HA) protocol stacks behind `SupremeNativeAdapter` (MQTT + Modbus,
      wired at the hub boot edge via `SUPREME_MQTT_URL` / `SUPREME_MODBUS_HOST`)

## 4. Persistence & data

- [x] Postgres system-of-record for identity/home/scenes/grants/drivers/automations/audit
- [x] Persist security panel (survives restart; hydrated on boot, write-through with
      `flush()` on shutdown), active license (already persisted + validated on boot),
      and fleet (Postgres-backed `SqlFleetStore` for the cloud registry)
- [ ] TimescaleDB (or partitioning) for `energy_samples` at volume
- [ ] Migration tooling for production upgrades (rollback-safe)
- [ ] Backups: off-site, scheduled, rotation, restore drills

## 5. Infra, deploy & scale

- [x] Hub Docker Compose (hidden HA + data plane)
- [x] Wire Redis (presence) + NATS (event bus) via the `@supreme/messaging` seam —
      in-process by default, real backends behind `SUPREME_NATS_URL`/`SUPREME_REDIS_URL`;
      device-state + notification fan-out now flows over the bus so it spans gateway
      processes (durable JetStream streams + rate-limit store are a follow-on)
- [ ] Cloud IaC (Terraform/Pulumi) for licensing/fleet/relay
- [ ] CD with staged rollout + rollback; signed images
- [ ] OTA hub update channel
- [ ] Load / soak / chaos testing (HA restarts, network loss, event storms)

## 6. Observability & ops

- [x] Metrics (Prometheus) — gateway `/metrics` exposes request counts/latency
      histograms (by route template) + process gauges; self-contained exposition,
      no external dep; internal-network-only (not at the public edge)
- [ ] Dashboards (Grafana) wired to the `/metrics` scrape
- [x] Distributed tracing (OpenTelemetry) — manual HTTP server span per request,
      exported over OTLP/HTTP when `SUPREME_OTEL_ENDPOINT` is set; no-op (zero cost)
      otherwise. Cross-service context propagation to the Python sidecars is a follow-on
- [ ] Alerting + on-call runbooks; SLOs
- [ ] Structured request logging with correlation ids (partial: pino)
- [x] Health/readiness probes beyond `/healthz` — `/readyz` is dependency-aware
      (backend health + DB reachability), returns 503 when not ready

## 7. Clients (mobile / web)

- [x] Camera streaming done right — view-only `camera` devices carry an RTSP source;
      `@supreme/cameras` resolves it to client-playable HLS/WebRTC through the bundled
      go2rtc engine (`/v1/cameras` register/list, `/v1/cameras/:id/stream`); clients
      never get a raw rtsp://. Player UI in the Flutter/portal apps is the remaining piece
- [x] Flutter app compiles + analyzes; widget smoke test
- [ ] App-store build/signing pipeline (iOS/Android) + internal installer track
- [ ] Push notifications (with on-LAN degrade)
- [ ] Offline/error UX depth; reconnect/backoff on WSS
- [ ] Golden tests for Aureon widgets; accessibility + i18n
- [ ] Web homeowner app (only installer portal exists today)

## 8. Optional cloud

- [ ] Remote-access relay (outbound mTLS tunnel, no inbound ports)
- [ ] Off-site backup service + driver-store mirror/CDN
- [~] Multi-home fleet deploy (HTTP API + Postgres-backed `SqlFleetStore` + portal
      ✓ page exist; still needs cloud IaC/CD to actually deploy + run migrations)

---

## Critical path (recommended order)

1. **Security hardening (§1)** — fail-closed secrets, headers, CORS, rate limiting, token rotation.
2. **Real HA integration (§2)** — resilience tests, gated live-HA test, upgrade regression.
3. **Wire Redis/NATS + persist remaining state (§4/§5)** for real multi-process scale.
4. **Cloud IaC + CD + observability (§5/§6)**.
5. **Real drivers/protocols (§3)** and **remote-access relay (§8)**.
