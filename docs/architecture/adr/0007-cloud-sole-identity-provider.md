# ADR 0007 — Supreme Cloud is the sole off-LAN identity provider

- Status: **Accepted**
- Date: 2026-06-27
- Context: Enterprise cloud redesign — `supreme-cloud-blueprint.md` §1, §5, §6.

## Context

The Phase-1 design authenticated users against the hub's local identity service and treated
the cloud relay as a dumb transport with a single shared `hubAuthToken`. That cannot support
a commercial platform: there is no global account, no multi-home/multi-hub ownership, no
phishing-resistant auth, no remote device management, and no path to social login or
assistant account-linking. Home Assistant must also never be an identity provider for users
(invariant I3).

## Decision

Supreme Cloud becomes the **sole identity provider for off-LAN access**. Cloud Identity +
AuthN own accounts, login handles (email/phone/username), passkeys (WebAuthn), federated login
(Apple/Google/Microsoft via OIDC), MFA, and the token model (short-lived EdDSA-signed access
JWTs + rotating, device-bound refresh tokens with reuse-detection).

Crucially, identity and authorization are **split across planes**:

- The **cloud authenticates *who you are*** (off-LAN).
- The **hub authorizes *what you may do here*** — the hub remains the RBAC enforcement point,
  re-checking every command against its local membership/grant model.

On-LAN, a client may still authenticate directly to the hub's local identity service, so
in-home control has **zero cloud dependency** (invariant I1). Cloud identities map to a local
principal on the hub.

## Consequences

- The hub's `services/identity` is **kept and re-scoped** to on-LAN/local enforcement, not
  removed; `services/permissions` stays as the local PDP and is mirrored by cloud AuthZ.
- A cloud→hub identity assertion (short-lived, hub-audience) is required so the hub can
  authorize remote requests locally without trusting the broker.
- Token signing keys rotate with JWKS publication; refresh reuse triggers family revocation;
  remote logout must revoke a device's refresh family within seconds (Device Registry).
- HA is never in any auth path; the e2e proof asserts no HA auth surface is reachable.
- Air-gapped/offline operation must remain fully functional on local identity alone.
