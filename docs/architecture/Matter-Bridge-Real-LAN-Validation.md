# Matter Bridge — Real LAN Validation Procedure

> Phase 3/4 deliverable. Everything in this document requires a real Ubuntu SupremeOS install
> and a real LAN — none of it can be run from this development sandbox (the sandbox's network
> namespace blocks the mDNS socket `@matter/main` needs; confirmed directly via
> `real-server.persistence.test.ts` twice now — once for endpoint state, once for commissioning
> credentials — not assumed). Nothing below is claimed as done until a human actually runs it
> and records the result.

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

1. **Enable Matter Bridge.** Set `SUPREME_MATTER_BRIDGE_ENABLED=1` in `gateway.env`.
2. **Start/restart SupremeOS.** `sudo systemctl restart supreme-gateway`. Watch
   `sudo journalctl -u supreme-gateway -f` for a `matter-bridge: exposed <deviceId> as endpoint
   <n> (<name>)` line per onoff device, with no startup error. Confirm `curl -s
   http://127.0.0.1:8080/healthz` still returns 200 — the Bridge must not destabilize the
   gateway even if a later step fails.
3. **Locate Matter pairing information.** No UI exists for this yet (§ Phase 4 §6 — the backend
   contract is defined, not built). Today the only way to see the manual pairing code / QR
   payload is `@matter/main`'s own commissioning log line (NOTICE level, printed once per boot
   while uncommissioned — see § Security review below for why this is where it is, and why that
   is currently accepted, not overlooked). Record the manual pairing code and QR payload from
   that log line.
4. **Open commissioning window if necessary.** Not usually needed: `@matter/main` opens a basic
   commissioning window automatically on every boot while the node is not yet commissioned. If a
   window has since closed (e.g. a long-idle uncommissioned node), a restart (step 2) reopens it
   using the SAME persisted passcode — there is no separate "reopen" action in this SDK version
   reachable outside the boot path (§ Phase 4 §1 audit: the internal behavior that would do this
   is not part of `@matter/main`'s exported public surface at 0.17.9 — verified, not assumed;
   see `server.ts`'s `getCommissioningState` doc comment for the full account).
5. **Commission from a Matter controller.** Using the code from step 3.
6. **Verify bridge appears.** The controller should show one commissioned node.
7. **Verify On/Off Light appears.** Under that node: an Aggregator with one On/Off Light
   endpoint per bridged SupremeOS device.
8. **Test ON/OFF.** From the controller, send On then Off to one endpoint. Confirm the
   corresponding SupremeOS device actually changes state (check the physical device, or `GET
   /v1/devices/:id`) — not just that the Matter attribute flipped.
9. **Test physical/native state feedback.** Change the device's state via its native path (a
   wall switch, the SupremeOS app, another automation) and confirm the controller observes the
   updated On/Off attribute — the direction earlier phases could only prove with a fake
   transport; this is the first real proof.
10. **Restart SupremeOS.** `sudo systemctl restart supreme-gateway`.
11. **Verify the fabric remains.** The controller should NOT need to re-commission — same node
    identity, same fabric membership. Confirm via `getCommissioningState()`-equivalent output if
    a debug route exists by then, or simply that the controller still controls the device
    without a re-pair prompt.
12. **Verify the endpoint remains.** Each device is still the SAME endpoint number as before —
    cross-check against `/var/lib/supremeos/matter/bridge/endpoint-registry.json`.
13. **Disconnect Internet.** Keep the local LAN switch/AP up — this is NOT the same as
    disconnecting the LAN (do not conflate the two).
14. **Keep LAN active.**
15. **Repeat Matter command/state tests (steps 8-9).** Matter commands, feedback, and SupremeOS
    automations must all keep working with no internet path at all.

## Requires real Matter ecosystem hardware/account

Steps 3, 5, 6, 7 explicitly need a real controller (chip-tool/matter.js CLI is enough for basic
validation; Apple Home/Google Home/Alexa/SmartThings are needed only for real ecosystem-specific
behavior, which is out of scope until a dedicated ecosystem-testing phase). Steps 1, 2, 10 need
only the real Ubuntu machine — no ecosystem account required.

## Recording results

For each numbered step, record one of:

- **PASS** — observed directly, with the evidence noted (log line, controller screenshot, etc.)
- **FAIL** — observed directly, with the actual error
- **NOT RUN** — not attempted this session

Do not mark a step PASS from inference ("commissioning probably works because the mDNS
advertisement started") — only from direct observation on the real controller/ecosystem.

## Commissioning architecture — what this phase established (audited against real SDK source)

`RealMatterBridgeServer` (`services/protocols/src/matter-bridge/real-server.ts`) hands
`@matter/main` a `ServerNode` and lets the SDK own every commissioning primitive — no manual
PASE/CASE code exists in SupremeOS. Verified directly against the installed
`@matter/node@0.17.9` source (`behavior/system/commissioning/CommissioningServer.ts`), not
guessed:

- **Discriminator / passcode**: generated ONCE by the SDK (`PaseClient.
  generateRandomPasscode`/`generateRandomDiscriminator`) only when no persisted value exists —
  the field schema is marked non-volatile (`quality: "N"`), so `@matter/main`'s own storage
  persists them from then on. SupremeOS never sets or regenerates these — confirmed by a real
  (non-faked) test: `real-server.persistence.test.ts`'s "the SAME pairing credentials … survive a
  real ServerNode restart" proves this at the SDK-persistence layer (not yet at the real-LAN
  layer — that's this runbook's job).
- **Manual pairing code / QR payload**: computed on demand from the persisted passcode/
  discriminator + vendor/product id — available via `RealMatterBridgeServer.
  getCommissioningState().pairing`, whether or not the node is currently commissioned (the SAME
  code works to add a second admin fabric later, per the SDK's `allowBasicCommissioning()`
  reusing the persisted passcode rather than minting a new one).
- **Commissioning window**: opened automatically on `start()` whenever the node has zero
  fabrics; skipped once commissioned. No public, exported API in this SDK version reopens a
  window outside the boot path (see runbook step 4) — a real Matter controller's own
  "OpenCommissioningWindow" cluster command (issued BY an already-paired admin) is the
  spec-standard path for multi-admin instead, and needs no SupremeOS action.
- **Fabrics**: `@matter/main` supports multiple fabrics per node natively (Matter spec's
  multi-admin model) — `getCommissioningState().fabrics` lists every one. SupremeOS has no
  "one bridge = one ecosystem" assumption anywhere in this codebase; nothing needed building for
  this — it already works because the Bridge never special-cases a fabric.
- **Factory reset vs. restart**: `ServerNode.erase()` is the SDK's real factory-reset primitive
  — wipes node identity/fabrics/credentials. `RealMatterBridgeServer.factoryReset()` calls
  exactly this, and NOTHING in `start()`/`stop()` (restart) ever calls it — proven by
  `matter-bridge-persistence.test.ts`'s "restart never calls factoryReset" test. The SDK ALSO
  auto-triggers its own erase when the LAST fabric is removed by a controller
  (`CommissioningServer.handleFabricChange`) — a real, spec-driven behavior, not something
  SupremeOS built or can suppress.
- **Fabric persistence**: after commissioning, everything `@matter/main` writes lives under
  `/var/lib/supremeos/matter/bridge/` alongside (never mixed with) SupremeOS's own
  `endpoint-registry.json` — inspect and confirm both survive step 10's restart.

## Security review (§ Phase 4 §10)

- **Pairing code / QR payload**: sensitive by nature — anyone with it can commission the bridge.
  `getCommissioningState()` returns it as real data (never redacted at the driver layer — that
  would make the API useless for its one legitimate purpose); the REQUIREMENT this phase
  establishes for whoever builds the future gateway route is that it MUST be
  authenticated + RBAC-restricted (installer/owner only), never on an unauthenticated or
  homeowner-general diagnostics endpoint. No such route exists yet — nothing in this codebase
  currently exposes it over HTTP.
- **`@matter/main`'s own commissioning log line** (NOTICE level, prints passcode/discriminator/
  manual code/QR text) is a real, disclosed tension: it is the ONLY way to find the pairing code
  today (no UI/route yet), and it is genuinely necessary for a human to commission the device at
  all. It lands in `journalctl -u supreme-gateway`, which on native-linux is root/`adm`-group
  gated, NOT an unrestricted API — materially different from the "unrestricted API/log" case
  the brief warns against, but still worth tightening once a real, RBAC-gated API route exists:
  at that point, lower `@matter/main`'s commissioning logger verbosity in production and make
  the gateway route the sole intended way to retrieve it. Not done in this phase — flagged as a
  Phase 5 follow-up, not silently accepted as permanent.
- **Operational credentials / certificates / private keys**: never touched by SupremeOS code at
  all — `@matter/main` owns them entirely inside its own storage files; nothing in this codebase
  reads, logs, or copies them. `getCommissioningState()` deliberately exposes ONLY `commissioned`/
  `fabrics`/`pairing` — never credential/certificate bytes.
- **Filesystem permissions**: unchanged from Phase 2/3's audit — `/var/lib/supremeos/matter/`
  is `chmod 0750`, owned by the SupremeOS service user, and the process itself runs under
  systemd's `ProtectSystem=strict` with only that directory (+ secrets dir) writable.
- **Endpoint registry**: still holds only `deviceId`/`endpointNumber`/`deviceType` — no secret
  was ever added to it in this phase.
- **API authorization**: no new HTTP route was added this phase, so there is nothing new to
  authorize yet — the requirement above is for whoever adds one next.
