# ADR 0012 — HomeKit (Apple Home / Siri) via a local HAP accessory bridge

- Status: **Accepted**
- Date: 2026-06-28
- Context: blueprint §9 (voice/ecosystems), ADR 0010 (cloud-to-cloud voice), ADR 0001 (SIL).

## Context

Apple Home / Siri is a must-have for the luxury segment, but it does **not** fit the cloud-to-cloud
model used for Alexa and Google (ADR 0010). HomeKit is **local-first**: a home device is exposed to
Apple Home by an *accessory* that speaks the HomeKit Accessory Protocol (HAP) and is discovered over
mDNS on the LAN; pairing establishes long-term keys directly between the iPhone/Home hub and the
accessory. There is no cloud webhook to register.

## Decision

Add a **local HAP accessory bridge** that runs on the hub (opt-in, like Matter), exposing every
Supreme device as a HomeKit accessory behind one bridge:

- **`@supreme/homekit`** holds the deterministic, certifiable core: the capability↔HAP mapping
  (`hapServicesFor`, `commandFromCharacteristic`, `characteristicsFromState`, mired↔kelvin) and the
  `HapBridge` orchestration — it publishes accessories, turns a HomeKit characteristic write into a
  Supreme command, and pushes Supreme state changes back to HomeKit characteristics.
- The actual HAP server — **pairing/SRP, the accessory database, persistent long-term keys, and the
  mDNS advertisement** — sits behind the `HapTransport` seam, injected at the hub boot edge from a
  `hap-nodejs`-backed implementation. A fake transport drives the tests, so the whole bridge is
  unit- and e2e-testable without the real HAP stack (the same boundary discipline as the Matter
  controller in ADR 0011).
- **Identity/RBAC are still enforced locally**: a HomeKit write is translated to a Supreme
  `CapabilityCommand` and sent through the SIL exactly like any LAN command — HomeKit does not get a
  privileged side-channel. Home Assistant is never exposed.

## Consequences

- The gateway gains an opt-in (`SUPREME_HOMEKIT_ENABLED`) and, when a `HapTransport` is injected,
  builds the bridge in `AppContext.initWithHome`: every device is published as an accessory,
  characteristic writes route through `sil.command`, and `onBackendState` pushes state back so Apple
  Home reflects local changes. `GET /v1/homekit/status` surfaces enabled + accessory count.
- The only piece not runnable in CI is the real `HapTransport` (hap-nodejs + mDNS); everything above
  it — mapping, bridge, command routing, state push — is implemented and tested (an e2e pairs the
  demo home and drives a device via a faked transport).
- **Deferred, gated on the transport:** the hap-nodejs integration (pairing UX + HAP setup
  code/QR surfaced to the Home app), per-accessory firmware/identify metadata, and Television/media
  + vacuum services (no first-class HAP projection yet). Cloud `VoiceService`'s HomeKit vocabulary
  (used for nothing local) can be retired now that the real bridge owns Apple Home.
