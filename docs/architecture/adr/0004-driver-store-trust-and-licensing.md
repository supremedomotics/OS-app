# ADR 0004 — Driver Store trust model & offline licensing

- Status: **Accepted**
- Date: 2026-06-04
- Context: Phase 2 (Installer & Drivers) — §9, §12, §13.

## Decision

All driver bundles and license tokens are **Ed25519-signed** and verified on the
hub **offline**, rooted in `@supreme/crypto`:

- **Drivers.** A `SignedDriverBundle` = a `DriverManifest` + content hash + an
  Ed25519 signature over the canonical bundle, plus a `signingKeyId`. The hub's
  `DriverManager` installs a driver only after (1) verifying the signature against
  a **trusted publisher key** it holds for that `signingKeyId`, and (2) confirming
  any required SKU is entitled by the active license. It also enforces lifecycle
  (yanked versions refuse to install) and the **Matter opt-in** (ships disabled).
- **Licensing.** A `License` is a signed payload (`{ homeId, sku, seats, features,
  expiresAt }`). The hub validates it against the embedded Supreme licensing public
  key with **no network call**, binding it to the hub's `homeId` and honoring
  expiry — so an air-gapped install stays correctly licensed. SKU tiers expand
  (`estate ⊃ pro ⊃ essential`) when deciding driver entitlement.
- **Backups.** A backup is the full Supreme system-of-record dumped to JSON and
  signed with the hub backup key; restore verifies the signature before touching
  any data and inserts tables in FK-topological order.

In development (and tests) the gateway generates ephemeral keypairs and seeds a
self-signed first-party catalog, so the entire installer surface is exercisable
offline. Production injects the real Supreme store + licensing public keys at the
hub boot edge — exactly like the HA token.

## Rationale

- A luxury, local-first appliance cannot depend on the cloud to gate drivers or
  validate licenses; signatures give integrity + authenticity without connectivity.
- Confining backend knowledge to the SIL (ADR 0001) extends to drivers: a driver
  declares a Supreme **capability** manifest, so a Phase-1 driver that wraps an HA
  integration can be swapped for a native one with no change above the SIL.

## Consequences

- Key management matters: trusted publisher keys and the licensing public key are
  configuration; the certification pipeline (`lintManifest` → sandbox → scan →
  `signBundle`) holds the publisher private keys, never the hub.
- Cross-hub backup restore requires preserving the hub backup key (sealed store);
  cross-hub *migration* uses Project Export instead.
