# Supreme OS — Service Level Objectives (§6)

These SLOs frame what "healthy" means for a luxury home appliance and back the alert
rules in `alerts.yml`. They are starting targets to refine against real fleet data.

| SLO | Target (28-day window) | Measured by |
|-----|------------------------|-------------|
| **Hub control availability** | 99.9% | `/readyz` success ratio per hub (local control must not depend on cloud) |
| **Command latency (p95)** | < 1s end-to-end (tap → ack) | `supreme_http_request_duration_seconds` on `/v1/devices/:id/command` + WSS ack |
| **API success rate** | ≥ 99.5% non-5xx | `supreme_http_requests_total{status!~"5.."}` / total |
| **Realtime freshness** | state delta on WSS < 2s after device change | app-side instrumentation (future) |
| **Push delivery (when enabled)** | ≥ 99% accepted by FCM/APNs within 10s | relay dispatch outcome (future metric) |

## Error budget policy
- Control availability burns budget fastest; a sustained `HubDown`/`HubNotReady` is a
  page (critical). Latency/error SLOs are tickets unless they breach for >1h.
- The hub is local-first: **a total cloud outage must NOT breach hub control availability.**
  If it does, that's a design regression, not just an incident.

## Non-goals (intentionally not SLO'd yet)
- Camera stream uptime (best-effort; depends on third-party cameras).
- Heavy AI/assistant latency (optional, offloadable).
