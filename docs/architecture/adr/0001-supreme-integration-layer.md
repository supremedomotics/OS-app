# ADR 0001 — The Supreme Integration Layer is the only seam to the backend

- Status: **Accepted**
- Date: 2026-06-03
- Context: Phase 0 implementation of the founding blueprint (§2.2, §7, §16).

## Context

Supreme OS uses Home Assistant as a hidden automation backend for Phase 1, but
the product strategy requires that HA be **progressively replaceable** by
Supreme-native services without any homeowner, installer, or frontend ever
noticing. If HA knowledge leaks above a single layer, that migration becomes
impossible and the whole strategic bet fails.

## Decision

All backend knowledge is confined behind a single interface, `IBackendAdapter`,
owned by the Supreme Integration Layer (SIL):

- Domain services, the gateway, and both SDKs speak **only** the Supreme domain
  (`@supreme/domain-model`) and contracts (`@supreme/contracts`). They address
  resources by Supreme IDs and capabilities — never HA entity IDs.
- The SIL holds the **only** HA-aware code: the `HaAdapter`, the capability
  mapper, and the `EntityRegistryMirror` (the `ha_entity_map`).
- Migration = add `SupremeNativeAdapter` implementing the same interface, route a
  capability to it behind a feature flag, validate, retire the HA dependency.
  Nothing above the SIL changes.

The Phase-0 `MockAdapter` implements the identical interface, which is what lets
the full stack be exercised end-to-end with no HA or hardware (the exit proof in
`services/gateway/src/e2e.test.ts`).

## Consequences

- A contract/lint boundary must forbid importing anything HA-specific above the
  SIL. The e2e test additionally asserts no HA identifiers appear in serialized
  client payloads.
- The capability set (`onoff`, `brightness`, `color`, `temperature`, `position`,
  `media`, `lock`, `sensor`) becomes a stable contract; adding a backend or a
  native engine must map onto it rather than extend the client surface ad hoc.
- The SIL must be resilient to backend restarts/upgrades (reconnect, re-sync,
  command buffering, version detection) so an HA upgrade can never break clients.
