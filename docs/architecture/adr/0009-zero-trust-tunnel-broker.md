# ADR 0009 — Zero-trust tunnel broker (QUIC/mTLS) replaces the shared-token relay

- Status: **Accepted**
- Date: 2026-06-27
- Context: Enterprise cloud redesign — `supreme-cloud-blueprint.md` §7, §8, §18.

## Context

Phase-1 remote access used a relay where the hub dialed out over a WebSocket authenticated by
a shared `hubAuthToken`, keyed by `homeId`, forwarding raw HTTP. It met invariant I4 (hub
dials out, no inbound ports) but is not commercial-grade: no per-hub cryptographic identity,
no end-to-end auth, the relay sees forwarded bearer headers, no connection migration, no
multi-region routing, and a single shared secret is a systemic risk.

## Decision

Replace the relay with a **zero-trust Tunnel Broker**:

- **Transport:** hub→broker is a persistent **QUIC (HTTP/3)** connection with **mutual TLS**
  using the hub's device certificate (ADR 0008). QUIC gives multiplexed streams, 0-RTT
  resumption, and **connection migration** (the tunnel survives hub IP changes). WebSocket-
  over-TLS is the fallback where UDP/QUIC is blocked.
- **Identity:** the hub is identified by `hub_id` extracted from its client certificate, not a
  shared token. A client may only reach homes its account is a member of; the edge and broker
  enforce, and the **hub re-validates identity + RBAC locally** for every request.
- **Role:** the broker is a **transport, not a man-in-the-middle**. The client session and the
  hub establish an authenticated channel; the broker routes ciphertext it cannot read. The hub
  proxies to its own local gateway (`127.0.0.1`), so authorization happens exactly as on the
  LAN.
- **Scale & failover:** brokers are stateless beyond live connections; hubs shard across
  brokers by region + consistent hashing on `hub_id` and auto-reconnect (backoff + jitter) on
  broker loss. Presence/routing in Redis; multi-region with nearest-PoP client edges.

## Consequences

- `cloud/relay` is split: its tunnel becomes the **Tunnel Broker**; its push fan-out becomes
  the standalone **Notification** service. The shared `hubAuthToken` is deleted.
- The hub's `relay-tunnel.ts` becomes the **Hub Agent** connector (device-cert mTLS, QUIC
  control channel, request proxying, auto-reconnect).
- Replay protection (nonces + monotonic stream sequencing + short-TTL hub assertions) is
  mandatory; per-hub/per-account concurrency + rate limits prevent abuse.
- Latency target: remote first byte < 1 s, steady-state ≈ one RTT + local execution, because
  the control channel is already warm.
- The Supreme API contract clients depend on is unchanged — only the transport beneath it
  changes, so no client rewrite is required.
