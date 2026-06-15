# Supreme OS — Production Readiness Checklist

> Living document. Tracks the work between "feature-complete (Phases 0–4)" and
> "deployable in paying customers' homes." Update the status boxes as items land.
> Rough overall **development** completion today: **~80%** (the software surface —
> drivers, cloud relay, IaC/CD/OTA, observability ops, clients — is built and tested in
> CI/simulation). NOTE: *real-world* readiness is materially lower (~25–30%): nothing
> has run against real field-bus hardware, an unattended multi-week soak, real cloud
> providers, or a security audit. See `docs/real-world-readiness.md` framing in chat.

Legend: `[x]` done · `[~]` partial · `[ ]` not started

## 0. Scorecard (by dimension)

| Area | Status | Notes |
|------|--------|-------|
| Architecture & contracts | ~92% | SIL seam, domain model, contract-first, migration routing |
| Feature breadth (P0–4) | ~88% | All phases + e2e; cameras/intercom/cloud now real |
| Automated testing | ~75% | unit/e2e/PGlite/fake-HA/real-LLM-gated; no load/soak/hardware |
| Persistence | ~88% | identity/home/scenes/grants/drivers/automations/audit/sessions/security/bindings/push tokens/migration policy persisted |
| Real HA integration | ~70% | verified against a REAL HA (auth+discovery) + CI upgrade gate — see §2 |
| Drivers & protocols | ~80% | KNX/MQTT/Modbus/Matter/Zigbee/DALI/AVR/CoolMaster/SIP drivers + bind/discovery + portal UI + persistence; Casambi (closed BLE) pending |
| Native migration engine | ~70% | routing proven; native engine fronts real bus stacks; migration policy persisted across restart |
| Security hardening | ~80% | fail-closed config, helmet/CORS/rate-limit, Argon2id/TOTP, token rotation, TLS/HSTS, authz matrix, scanning — see §1 |
| Infra / deploy | ~78% | hub + cloud compose, Terraform IaC skeleton, CD pipeline, OTA channel (signed) |
| Observability / ops | ~82% | metrics/`/readyz`/OTel + Prometheus alerts, Grafana dashboard, SLOs, runbooks |
| Mobile / web delivery | ~72% | Flutter + web homeowner/installer apps, camera players, push pipeline, CD + Fastlane (no real store creds yet) |
| Optional cloud (relay) | ~75% | relay built + tested: push fan-out (FCM/WebPush) + outbound remote-access tunnel (hub↔relay e2e) |

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
- [x] Cloud plane deployable (`infra/cloud-compose`: relay + fleet + otel-collector +
      Prometheus) + Terraform IaC skeleton (`infra/cloud-iac`)
- [x] CD pipeline (`.github/workflows/cd.yml`) — build/test → push hub+cloud images →
      publish a signed OTA manifest; client builds in `clients.yml` (staged rollout +
      rollback are deploy-target wiring)
- [x] OTA hub update channel — signed (Ed25519) release manifest; the hub verifies +
      detects, the OS updater applies (`services/gateway/src/ota.ts`, `tools/ota` signer)
- [ ] Load / soak / chaos testing (HA restarts, network loss, event storms)

## 6. Observability & ops

- [x] Metrics (Prometheus) — gateway `/metrics` exposes request counts/latency
      histograms (by route template) + process gauges; self-contained exposition,
      no external dep; internal-network-only (not at the public edge)
- [x] Dashboards (Grafana) — `infra/observability/grafana/supreme-overview.json`
- [x] Distributed tracing (OpenTelemetry) — manual HTTP server span per request,
      exported over OTLP/HTTP when `SUPREME_OTEL_ENDPOINT` is set; no-op (zero cost)
      otherwise. Cross-service context propagation to the Python sidecars is a follow-on
- [x] Alerting + on-call runbooks + SLOs — `infra/observability/{alerts.yml,runbooks.md,slo.md}`
- [ ] Structured request logging with correlation ids (partial: pino)
- [x] Health/readiness probes beyond `/healthz` — `/readyz` is dependency-aware
      (backend health + DB reachability), returns 503 when not ready

## 7. Clients (mobile / web)

- [x] Camera streaming done right — view-only `camera` devices carry an RTSP source;
      `@supreme/cameras` resolves it to client-playable HLS/WebRTC through the bundled
      go2rtc engine (`/v1/cameras` register/list, `/v1/cameras/:id/stream`); clients
      never get a raw rtsp://. **Player UI shipped** with a **low-latency WebRTC path
      (WHEP) preferred, HLS fallback**: Flutter homeowner (snapshot tiles on the
      security screen → live view via `flutter_webrtc`, falling back to `video_player`
      HLS) + installer portal (Cameras tab: register + snapshot + WebRTC via WHEP/
      `RTCPeerConnection`, falling back to hls.js)
- [x] Flutter app compiles + analyzes; widget smoke test
- [ ] App-store build/signing pipeline (iOS/Android) + internal installer track
- [x] Push notifications (with on-LAN degrade) — token registration (`/v1/push/tokens`,
      persisted), a `PushService` that delivers each notification to registered device
      tokens through a provider seam (cloud relay holds FCM/APNs creds), and WSS stays
      the degrade path when no provider is configured. Event sensors (door **ring** /
      leak / smoke) auto-raise a notification on their rising edge → WSS + push, with no
      user-authored automation (closes the SIP door-station → phone loop). Client token
      source (firebase_messaging/APNs/service worker) is the remaining platform wiring
- [ ] Offline/error UX depth; reconnect/backoff on WSS
- [ ] Golden tests for Aureon widgets; accessibility + i18n
- [x] Web homeowner app — room-first React app (login, dashboard + quick scenes, room
      device tiles with live WSS + optimistic control, scenes, security with HLS/WebRTC
      camera players, energy). Served at the hub edge root; installer moved to
      `/installer/`. Verified against a live gateway

## 8. Optional cloud

- [x] Remote-access relay (`@supreme/relay`) — outbound-only WS tunnel (hub dials out,
      no inbound ports), off-LAN client requests routed to the hub which still enforces
      identity; hub↔relay e2e. Push fan-out (FCM/WebPush) in the same service. (mTLS +
      real FCM/APNs creds are deployment wiring)
- [x] Cloud plane deploy — `infra/cloud-compose` + Terraform IaC + CD images (the relay
      and fleet now have Dockerfiles + a compose to run them)
- [ ] Off-site backup service + driver-store mirror/CDN
- [~] Multi-home fleet deploy (HTTP API + Postgres-backed `SqlFleetStore` + portal
      ✓ page + cloud-compose service; needs managed DB wiring + migrations in prod)

---

## Critical path (recommended order)

1. **Security hardening (§1)** — fail-closed secrets, headers, CORS, rate limiting, token rotation.
2. **Real HA integration (§2)** — resilience tests, gated live-HA test, upgrade regression.
3. **Wire Redis/NATS + persist remaining state (§4/§5)** for real multi-process scale.
4. **Cloud IaC + CD + observability (§5/§6)**.
5. **Real drivers/protocols (§3)** and **remote-access relay (§8)**.
