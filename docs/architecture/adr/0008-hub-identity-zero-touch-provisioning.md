# ADR 0008 — Hub cryptographic identity & zero-touch provisioning

- Status: **Accepted**
- Date: 2026-06-27
- Context: Enterprise cloud redesign — `supreme-cloud-blueprint.md` §3, §7, §17.

## Context

A hub with no cryptographic identity cannot participate in a zero-trust system: it can't
authenticate to the cloud with mTLS, can't be uniquely registered, can't be revoked, and can't
prove integrity. The Phase-1 hub authenticated to the relay with a shared bearer token — a
single secret with no per-hub identity, no rotation, and no revocation. Commercial deployment
also requires that an installer/owner never manually registers a hub or copies tokens.

## Decision

Every hub is a **cryptographic principal**:

- On first boot it generates a `hub_uuid` (UUIDv7) and an **Ed25519** device keypair
  (+ X25519 for key agreement), with the private key sealed by the hub secrets manager (and,
  in Phase 4, generated inside a TPM/secure element, non-extractable).
- It builds a **CSR** and performs **zero-touch enrollment** with the cloud Hub Registry,
  which (after verifying a provisioning secret or attestation) issues a **short-lived,
  auto-renewing X.509 device certificate** from the Supreme Hub CA.
- The hub then opens a persistent **mTLS QUIC** control channel to the Tunnel Broker using
  that certificate. It is now *provisioned but unclaimed*.
- **Ownership** is established separately by a human with proximity: an on-LAN **claim code**
  (or signed mDNS challenge) or a dealer pre-provisioning + transfer flow. The first claimant
  becomes Owner; the cloud creates the `home` + `membership(owner)`.

The enrollment payload carries an `attestation` envelope designed so Phase 1 accepts a
factory/installer signature and Phase 4 can require a TPM EK cert + quote + Secure Boot
measurement **without an API change** (Hardware Root of Trust).

## Consequences

- The shared `hubAuthToken` is **removed**; hubs authenticate with device-cert mTLS, keyed by
  `hub_id` from the client certificate.
- Device certs are short-lived with automated renewal over the authenticated channel;
  revocation (CRL + short TTL) gives fast effective revocation; renewal failure ⇒ re-enroll.
- Provisioning/claim is decoupled: the cloud can *reach* a hub it does not yet *belong* to
  anyone, so claiming is a deliberate, audited, proximity-gated act (anti-hijack).
- Existing deployed hubs enroll on upgrade (generate identity, auto-register); the owner
  re-claims once. No inbound ports, DDNS, VPN, or static IP are ever required (invariant I4).
