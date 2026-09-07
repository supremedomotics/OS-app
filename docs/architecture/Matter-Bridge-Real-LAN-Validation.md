# Matter Bridge — Real LAN Validation Procedure

> Phase 3 deliverable. Everything in this document requires a real Ubuntu SupremeOS install
> and a real LAN — none of it can be run from this development sandbox (§ Phase 3 audit: the
> sandbox's network namespace blocks the mDNS socket `@matter/main` needs; confirmed directly
> via `real-server.persistence.test.ts`, not assumed). Nothing below is claimed as done until
> a human actually runs it and records the result.

## Prerequisites

- A SupremeOS hub installed via `infra/native-linux/install.sh` (native Ubuntu, no Docker).
- `SUPREME_MATTER_BRIDGE_ENABLED=1` set in `/etc/supremeos/gateway.env` (or wherever
  `SUPREME_CONFIG_DIR` resolves on that install), then `sudo systemctl restart supreme-gateway`.
- At least one SupremeOS device with an `onoff` capability already commissioned (any native
  protocol — KNX, Casambi, MQTT, etc.) so there is something real for the Bridge to expose and
  for a controller command to actually reach.
- A Matter controller to test with — the reference `chip-tool`, `matter.js`'s own controller
  CLI, or a real ecosystem app (Apple Home / Google Home / Alexa / SmartThings) on the same LAN.

## Procedure

1. **Matter Bridge starts.** `sudo journalctl -u supreme-gateway -f` and confirm a
   `matter-bridge: exposed <deviceId> as endpoint <n> (<name>)` line per onoff device, with no
   startup error. Confirm `curl -s http://127.0.0.1:8080/healthz` still returns 200 (the Bridge
   must not destabilize the gateway even if this step fails — § Phase 3 failure handling).
2. **Matter endpoint created.** Same log evidence as (1) — one endpoint per bridged device.
3. **Matter commissioning is available.** From the controller, scan for commissionable Matter
   devices on the LAN. The bridge should appear (mDNS `_matterc._udp` advertisement).
4. **A Matter controller can discover the bridge.** Commission it using the pairing code/QR the
   Bridge advertises (§ Commissioning architecture below — record the actual discriminator/
   passcode behavior observed, since this sandbox could not verify it).
5. **The On/Off Light is visible.** After commissioning, confirm the controller lists the
   bridge's aggregator endpoint and, under it, one On/Off Light endpoint per bridged device.
6. **Matter ON reaches SupremeOS.** From the controller, send On to one endpoint. Confirm the
   corresponding SupremeOS device actually turns on (check the physical device or its state via
   `GET /v1/devices/:id`) — not just that the Matter attribute flipped.
7. **Matter OFF reaches SupremeOS.** Same as (6), Off.
8. **Physical/native state changes reach Matter.** Change the device's state via its native
   path (a wall switch, the SupremeOS app, another automation) and confirm the controller
   observes the updated On/Off attribute — this is the direction Phase 1/2 could only prove
   with a fake transport; this step is the first REAL proof.
9. **Restart preserves Matter identity.** `sudo systemctl restart supreme-gateway`. Confirm the
   controller does NOT need to re-commission — the same fabric/node identity should survive
   (§ Phase 2's `@matter/main` storage boundary, now exercised for real).
10. **Restart preserves endpoint identity.** After the same restart, confirm each device is
    still the SAME endpoint number as before (cross-check against
    `/var/lib/supremeos/matter/bridge/endpoint-registry.json`).
11. **Internet disconnected, LAN still active.** Disconnect the hub's WAN/internet uplink while
    keeping the local LAN switch/AP up. Repeat steps 6-8. Matter commands, feedback, and
    SupremeOS automations must all keep working — LAN disconnection (not tested here) is a
    different failure mode from internet disconnection (this step).

## Recording results

For each numbered step, record one of:

- **PASS** — observed directly, with the evidence noted (log line, controller screenshot, etc.)
- **FAIL** — observed directly, with the actual error
- **NOT RUN** — not attempted this session

Do not mark a step PASS from inference ("commissioning probably works because the mDNS
advertisement started") — only from direct observation on the real controller/ecosystem.

## Commissioning architecture — what to verify while running this

`RealMatterBridgeServer` (`services/protocols/src/matter-bridge/real-server.ts`) hands
`@matter/main` a `ServerNode` and lets the SDK own every commissioning primitive — no manual
PASE/CASE code exists in SupremeOS. What to record from a real run, since none of this is
verifiable in the sandbox:

- **Discriminator / passcode**: `@matter/main` generates these itself (`ServerNode.create()`
  with no explicit `commissioning` override) — record the actual values the SDK prints/exposes
  so a real pairing code can be derived, or set them explicitly in a future pass if a stable,
  installer-visible pairing code is wanted instead of a random one per boot.
- **mDNS advertisement**: confirm with `avahi-browse -a` (or equivalent) that
  `_matterc._udp`/`_matter._tcp` records appear on the LAN interface, not just localhost.
- **Fabric persistence**: after commissioning, inspect
  `/var/lib/supremeos/matter/bridge/` for the files `@matter/main` created — confirm they
  survive step 9's restart and are NOT the SupremeOS-owned `endpoint-registry.json` (that file
  is the only one SupremeOS itself writes into this directory — see `real-server.ts`'s storage
  boundary doc comment).
