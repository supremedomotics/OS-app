# ADR 0010 — Voice ecosystem integration: cloud-to-cloud over the Tunnel Broker

- Status: **Accepted**
- Date: 2026-06-28
- Context: `supreme-cloud-blueprint.md` §9 (voice), ADR 0007 (cloud sole IdP), ADR 0009 (broker).

## Context

Luxury buyers expect "Alexa, dim the living room" and the Google Home / Assistant equivalent.
Each ecosystem certifies a specific integration shape. We must add voice **without** exposing
Home Assistant, without putting the cloud on the critical path for local control, and without
forking the device model per assistant. Two integration styles exist:

1. **Cloud-to-cloud** — the assistant's cloud calls *our* cloud (OAuth2 account linking + a
   fulfillment webhook). Works from any device, anywhere; no hardware on the hub.
2. **Local fulfillment / local hub** — the assistant talks to an on-LAN endpoint (Alexa Local,
   Google Local Home SDK, an Apple HomeKit accessory bridge). Lower latency, needs a per-
   ecosystem agent/bridge running on the hub.

## Decision

Ship **cloud-to-cloud first** for Alexa and Google, built on the existing planes:

- **Supreme Cloud is the OAuth2 IdP** (ADR 0007). `cloud/voice` exposes `/oauth/authorize`
  (consent → Supreme login) and `/oauth/token` (authorization-code + refresh grants). Tokens are
  HMAC-signed, self-contained, and reference a server-side link record, so **revocation is one
  delete** and validation needs no DB round-trip. Authorization codes are single-use and short-
  lived; `redirect_uri` is allow-listed per client to prevent code theft / open redirects.
- **One capability model → every assistant.** A single `CanonicalIntent` is the waist: each
  webhook (`/voice/alexa`, `/voice/google`) parses its ecosystem's message format into a
  canonical intent, and a single `toHubCommand()` maps that to the Supreme `CapabilityCommand`
  the hub already validates. Discovery/SYNC project the Supreme capability set into Alexa
  interfaces / Google traits from one table.
- **The cloud never controls a device directly.** Every directive is forwarded to the owning
  hub over the **Tunnel Broker** (ADR 0009), carrying the link's hub-scoped Supreme token, so
  identity + RBAC are enforced **locally on the hub** exactly as on the LAN. The voice service
  is transport + protocol translation only; HA is never reachable.
- **Hub offline = transient assistant error**, never a hard failure of local control. Discovery
  degrades to an empty endpoint set; control maps to `ENDPOINT_UNREACHABLE` / `OFFLINE`.

## Consequences

- New package surface in `cloud/voice`: `oauth.ts` (IdP), `alexa.ts` + `google.ts` (pure payload
  mappers, unit-testable to each platform's contract), `hub-router.ts` (the broker seam +
  canonical→hub command), `server.ts` (Fastify webhooks), `main.ts` (boot). Deployed as an
  optional compose service; refuses logins until `authenticateUser` is wired to the Identity
  plane (fail-closed).
- The hub gains `GET /v1/devices` (flat, permission-filtered) so Discovery/SYNC enumerate a home
  in one tunnel round-trip.
- **Deferred to a follow-up:** (a) **HomeKit / Siri**, which is fundamentally *local* — it needs
  a HAP accessory bridge advertised on the LAN from the hub (mDNS + the HomeKit Accessory
  Protocol), not a cloud webhook; the cloud `VoiceService` already carries the HomeKit vocabulary
  for when that bridge lands. (b) **Local fulfillment** for Alexa/Google to cut latency once the
  cloud path is certified. (c) **Proactive state reporting** (Alexa `ChangeReport` / Google
  `ReportState`) once the hub→cloud event channel publishes state deltas upstream.
- The Supreme API contract is unchanged; voice is additive and fully removable.
