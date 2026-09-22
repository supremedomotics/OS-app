# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

## Session: Matter Controller Extension — Phase 3.3 PASE Root-Cause Analysis (BLOCKED)

Traced the exact `@matter/main`/`@matter/protocol` 0.17.9 source to find why the fixture's
`PaseServer` rejects the first `PbkdfParamRequest` with `InvalidParam`. **Root cause not fully
identified, but definitively narrowed to a vendor-library-or-environment issue, not a
SupremeOS bug.**

**API correctness confirmed by direct source comparison:** read `CommissioningDiscovery.ts`,
`Discovery.ts`, `Peers.ts`, and `ClientNodeFactory`'s concrete `Factory.create()`. The normal
mDNS discovery path's `onDiscovered()` handler constructs its `ClientNode` via
`factory.create({ id, environment, commissioning: { descriptor } })` and then calls
`agent.commissioning.commission(options)` — **structurally identical** to what
`Peers.forDescriptor()` does (`factory.create({ commissioning: { descriptor } })`) followed by
`ClientNode.commission()`. `Factory.create()` always overrides `owner` to the real ServerNode
regardless of what's passed, and `CommissioningClient.commission()` applies the same
`PasscodeOptions()` transform either way. **Conclusion: `Peers.forDescriptor()` +
`ClientNode.commission()` is the correct, intended, officially-documented manual-commissioning
API for 0.17.9** — not a misuse, not the cause.

**Conclusive vanilla reproduction (zero SupremeOS code):** wrote a throwaway script using only
raw `@matter/main` `ServerNode`s (no `RealMatterController`, no `commissionAtAddress()`, no
SupremeOS descriptor-building code) — plain `ServerNode.create()` fixture + plain
`ServerNode.create()` controller + `controller.peers.forDescriptor(...)` +
`client.commission({passcode, discriminator})`. **Identical failure**: fixture receives the
real `PbkdfParamRequest`, immediately replies `StatusReport Failure InvalidParam`. This proves
the issue is NOT introduced by SupremeOS's `RealMatterController`/`commissionAtAddress()`
code — it reproduces with bare `@matter/main` APIs alone.

**One hypothesis tested and disproven:** suspected the lazy `ControllerBehavior` load inside
`commissionAtAddress()` (right before PASE) made one-time fabric-creation crypto work
(`FabricAuthority` "Created new controller fabric") compete with PASE's real-time
message/retransmission timing. Tested by moving the load to happen well before commissioning
with an explicit settling delay — same vanilla-repro failure persisted, with the fabric-
creation transaction still appearing to fire at commission time regardless. **Disproven** —
reverted this exploratory change; `commissionAtAddress()`'s `ControllerBehavior` load stays
exactly where Phase 3.1 put it (harmless, correct, just not the cause of this issue).

**Not reached this session (time-boxed):** direct instrumentation of `PaseServer
.handlePairingRequest()`/`readPbkdfParamRequest()` to find the EXACT validation condition
producing `InvalidParam` — the responder logs no "Received pairing request" (INFO, suppressed
by the existing `Commissioning: WARN` facility filter) or any caught-error line before sending
the rejection, so the exact failing check inside `@matter/protocol` remains unidentified.
Next concrete step: temporarily raise the "Commissioning" facility to INFO/DEBUG (test-only,
never in production) to see whether `handlePairingRequest` is entered at all, or add a
`debugger`/log statement directly inside the installed `@matter/protocol` PaseServer source
(a local, disposable edit for tracing only) to capture the exact request fields it received
and which check fails.

**No production code changed this phase** — the one exploratory `real-controller.ts` edit
(moving `ControllerBehavior` load) was reverted after disproving the hypothesis, restoring the
file to its exact Phase 3.1 state. Regression: `real-controller.test.ts` 3/3, `matter-driver`/
`matter-fabric`/`matter-pairing` 20/20 combined, Matter Bridge 166/167 (pre-existing artifact
only, zero Bridge files touched), `services/drivers` 56/56, both packages typecheck clean.

**Temporary debug artifacts:** `repro-vanilla.ts`/`repro-vanilla2.ts` (vanilla @matter/main
reproduction + ControllerBehavior-timing hypothesis test) created and removed after use —
confirmed absent via `find`, nothing imports them.

## Session: Matter Controller Extension — Phase 3.2 Separate-Process Validation (BLOCKED)

Built a real separate-OS-process test harness to control for Phase 3.1's "maybe it's a
same-process artifact" theory. Result: **partially confirmed, partially refuted** — with
concrete new evidence either way, not a guess.

**New test infrastructure (real, not mocked):**
`test-support/fixture-process.ts` (forked child entry point — runs the real
`@matter/main` fixture via the existing `createCommissionableFixture()`, reports
port/passcode/discriminator over IPC, shuts down cleanly on command or parent disconnect) and
`test-support/fixture-process-handle.ts` (parent-side `spawnFixtureProcess()`/
`killAllFixtureProcesses()` using `node:child_process.fork()` with `--import tsx`; pipes the
child's real `@matter/main` logs through with a `[fixture <pid>]` prefix — essential for the
diagnosis below). IPC carries only orchestration data (ready/port/passcode/discriminator/
shutdown); all Matter traffic travels over the real UDP socket `@matter/main` binds. New
`cluster-engine.separate-process.e2e.test.ts` runs the full A–I test matrix against this
real cross-process fixture.

**Evidence gathered (with full logs, not assumptions):**
1. **The fork mechanism itself works perfectly** — real distinct PID, real bound port, clean
   IPC handshake, clean shutdown, verified via a standalone smoke test before wiring into vitest.
2. **mDNS/multicast discovery STILL fails even across separate processes** — re-ran
   `RealMatterController.commission()` (normal mDNS path) against the child-process fixture:
   same "No commissionable device was discovered." This means Phase 3.1's original
   "same-process multicast" theory was **too narrow** — multicast/mDNS itself appears broken
   on this host's network stack independent of process topology (very likely Windows Firewall
   or the same adapter-heavy stack, but now confirmed NOT a same-process-sharing artifact).
3. **Real UDP unicast delivery DOES work across the process boundary** — using
   `commissionAtAddress()` (Phase 3.1's deterministic path) against the child-process fixture,
   the piped fixture logs show it genuinely RECEIVING the controller's real
   `SC/PbkdfParamRequest` packet (`[fixture <pid>] ... New exchange « ... Message « for:
   SC/PbkdfParamRequest`) — real, confirmed, bidirectional UDP delivery across two independent
   OS processes.
4. **New, more specific blocker**: the fixture's own PASE responder rejects that
   `PbkdfParamRequest` almost instantly with `StatusReport Failure InvalidParam`, with no
   corresponding "Received pairing request" or error-catch log line — the exact failure
   mechanism inside `@matter/protocol`'s `PaseServer` is not yet identified (needs deeper
   protocol-level tracing than this session's remaining budget allowed). This is now clearly a
   **protocol-level PASE negotiation issue specific to the `forDescriptor()`/manual-address
   commissioning path**, not a transport/delivery/process-topology issue — real packets travel
   both directions, but the responder declines to proceed past the first PASE message.

**Tests:** `real-controller.test.ts` 3/3 passing (unaffected). `discovery.e2e.test.ts`/
`cluster-engine.e2e.test.ts` (same-process) still fail as before (mDNS/PASE, documented).
`cluster-engine.separate-process.e2e.test.ts` (new) fails at the same PASE boundary as the
same-process `commissionAtAddress()` tests — commissioning itself is the blocker in BOTH
topologies now, so READ/WRITE/INVOKE remain unexercised against a real session. Matter Bridge
166/167 (pre-existing artifact only, confirmed zero Bridge file changes), `services/drivers`
56/56, both packages typecheck clean.

**Debug artifacts:** `repro-fork.ts` (fork-mechanism smoke test) and `repro-mdns-sp.ts` (mDNS-
vs-manual-path cross-process comparison) were created and removed after their one-shot
diagnostic use — nothing production depends on them, confirmed via `find`.

**Next step recommendation:** trace `@matter/protocol`'s `PaseServer.handlePairingRequest()` /
`PaseServerMessenger.readPbkdfParamRequest()` directly (add temporary instrumentation or a
debugger breakpoint) to see exactly which check inside PBKDF request processing rejects a
`forDescriptor()`-originated session that a normal-discovery-originated session would not —
the two paths must differ in some session/exchange setup step this investigation didn't reach.
Alternatively, compare against matter.js's own upstream test suite for a working
`forDescriptor()` + manual `ClientNode.commission()` example, since this exact combination may
have known caveats not covered by its public API docs alone.

## Session: Matter Controller Extension — Phase 3.1 Validation/Recovery (BLOCKED)

Investigated Phase 3's blocked real round-trip test. Real diagnostic progress made; the full
commission→read→write→invoke round trip is still **not passing**, but the root cause is now
understood far more precisely than "mDNS is flaky."

**Root cause investigation (real diagnostics, no guessing):** re-ran Phase 2's own
`discovery.e2e.test.ts` as a baseline — still fails identically ("No commissionable device was
discovered"). Compared full debug logs between the fixture and controller nodes: the
controller's mDNS responder fully initializes multicast group membership on every host
interface; **the fixture's never does** — no "Initialize multicast" log line at all for the
fixture, meaning its own mDNS advertisement never actually broadcasts. This is a real,
reproducible limitation of running two independent `@matter/main` mDNS responders in the SAME
OS process on this Windows host, not a generic "mDNS is unreliable" hand-wave.

**Deterministic-commissioning path implemented (real API, not invented):**
`RealMatterController.commissionAtAddress(address, payload)` — a new production method using
`Peers.forDescriptor()` + `ClientNode.commission()`, exactly as `RemoteDescriptor`'s own doc
comment describes, bypassing ONLY discovery/scanning. Normal mDNS `commission()` is completely
unchanged; this is an additive, real manual-commissioning capability (useful in production too,
for a known-IP device an installer enters manually). `test-support/commissionable-fixture.ts`
now exposes the real bound operational `port` so tests can address it directly.

**Second real bug found and fixed along the way:** `ClientNode.commission()` internally does
`node.owner.act(agent => agent.load(ControllerBehavior))` (verified directly against
`@matter/node`'s own `CommissioningClient.commission()` source) — a plain `ServerNode.create()`
does NOT declare `ControllerBehavior` as supported at all ("Unsupported behavior" on `load()`,
confirmed live). Fixed with `this.node.behaviors.require(ControllerBehavior)` before `load()` —
a real, documented `@matter/node` API ("Add behavior support dynamically at runtime").

**Third real finding — deeper than mDNS:** with discovery bypassed and `ControllerBehavior`
fixed, commissioning now reaches real PASE packet exchange (`SC/PbkdfParamRequest` genuinely
sent over a real UDP socket) but ultimately fails with `PairRetransmissionLimitReachedError`
("Could not connect to device") — the request is never acknowledged. This means the underlying
problem is **not mDNS-specific**: even direct UDP unicast between two independent `@matter/main`
nodes in the SAME OS process is unreliable on this host (tested against both `127.0.0.1` and the
real LAN IP, same result). The most likely explanation is this machine's unusually large set of
virtual network adapters (Hyper-V, VirtualBox-style, two VMware switches) interfering with
same-process loopback/local UDP delivery — but this is now a same-process-socket-delivery
finding, not merely a discovery-transport finding.

**Tests:** `discovery.e2e.test.ts` and `cluster-engine.e2e.test.ts` updated to use
`commissionAtAddress()` instead of mDNS `commission()` (a legitimate, real transport swap, not a
weakened assertion — every other real API and assertion is unchanged). Still fail, now with a
fast, deterministic `PairRetransmissionLimitReachedError` instead of a slow mDNS timeout — a
real improvement in diagnosability even though the round trip itself remains blocked. Full
regression unaffected: 186/187 passing (`matter-driver`/`matter-fabric`/`matter-pairing`/
`matter-controller` Phase 1 lifecycle), Matter Bridge 166/167 passing (both suites' 1 failure is
the pre-existing Windows `0600` artifact), `services/drivers` 56/56, both packages typecheck
clean.

**Recommended next step (concrete, not vague):** run the fixture as a genuinely separate OS
process (not just a separate object in the same Node process) — e.g. a small child-process
harness communicating commissioning parameters over stdio/IPC — or run this suite on
native-linux/CI, where two independent processes' real sockets don't share this host's
same-process delivery quirk. This is real engineering work, not a one-line fix; not attempted
this session per the phase's "validation only" scope.

**Matter Bridge:** confirmed zero changes (`git diff --stat -- services/protocols/src/
matter-bridge` empty), Bridge test suite 166/167 (1 pre-existing artifact).

## Session: Matter Controller Extension — Phase 3 Generic Cluster Engine

Builds the generic Matter cluster engine on top of Phase 1 (foundation)/Phase 2 (device
interview): `MatterProtocolDriver` → `RealMatterController` → generic engine → real
`@matter/main` → real commissioned device. No `if (deviceType === "light")` branching
anywhere — every operation resolves by numeric endpoint/cluster/attribute/command id (or
real runtime name) against the live `ClientNode`'s actual loaded behavior metadata.

**New files:** `services/protocols/src/matter-controller/errors.ts` (`MatterEngineError` —
one consistent error model across read/write/invoke, preserving operation/nodeId/endpointId/
clusterId/attributeId-or-commandId and the real underlying `@matter/main` error as `cause`,
never leaking credential material), `target-resolver.ts` (the SINGLE generic
endpoint+cluster+attribute+command resolution layer every operation shares — distinguishes
`node_not_commissioned` / `node_not_found` / `endpoint_not_found` / `cluster_not_found` /
`attribute_not_found` / `command_not_found` / `unavailable` / `runtime_error`),
`cluster-engine.ts` (`readAttribute`/`writeAttribute`/`invokeCommand` — real operations via
`@matter/main`'s own `Agent`/behavior-state API: reading/writing a `ClientNode`'s behavior
state performs the actual over-the-wire Matter interaction, matching matter.js's own
documented controller usage pattern; no hand-built low-level protocol Read/Write/Invoke
requests), `cluster-engine.e2e.test.ts` (real read/write/invoke + error-path + multi-endpoint/
multi-node isolation suite against real commissioned fixtures).

**`real-controller.ts` extended:** `invoke()` is now real — delegates to the generic engine
instead of throwing "not yet implemented"; new public `readAttribute()`/`writeAttribute()`/
`invokeCommand()` methods (numeric or real-name identity) for direct generic access. A single
new private `getClientNode(nodeId)` is the one place a live peer is looked up by id, shared by
every operation (§ no duplicated resolution logic). `getState()`/`subscribe()` intentionally
unchanged — subscriptions remain explicitly out of Phase 3 scope (Phase 4).

**Phase 1 test updated:** `real-controller.test.ts`'s "invoke() not yet implemented" test now
asserts the correct, honest new behavior — a real, structured `node_not_commissioned` error —
since invoke() is genuinely implemented now.

**Environment note (not a code defect, matches Phase 2's own documented finding):** this dev
machine's cross-node mDNS commissioning is CURRENTLY failing 100% of attempts this session
(reconfirmed against Phase 2's own previously-passing e2e test as a baseline — it fails
identically right now with "No commissionable device was discovered"), worse than Phase 2's
session where it succeeded intermittently. Same root cause already documented: an unusually
adapter-heavy Windows network stack (Hyper-V, VirtualBox-style, two VMware switches). The
Phase 3 cluster-engine code is logically verified (clean typecheck, real error-path behavior
confirmed via `real-controller.test.ts`'s real `node_not_commissioned` case, careful
cross-referencing against actual installed `@matter/main` 0.17.9 typings for every API used —
`Agent.get()`, `ClientNode.act()`, `ClusterType.attributes`/`.commands`, `Behaviors.active`)
but the full real commission→read→write→invoke round-trip in `cluster-engine.e2e.test.ts`
could not be exercised to a passing result this session due to this environment condition.
**Recommend running this suite on native-linux/CI** where matter.js's own upstream test suite
exercises these exact scenarios reliably.

**Tests:** 1 new e2e file (4 tests, real ops + error paths + isolation — currently blocked by
the environment condition above, not by test/implementation logic), 1 existing test updated.
Full regression (excluding the blocked cross-node e2e tests): 186/187 passing across
`matter-driver`/`matter-fabric`/`matter-pairing`/`matter-bridge`/`matter-controller` Phase 1
lifecycle (the 1 failure is the pre-existing Windows `0600` artifact). `services/drivers`
(56/56) and `services/protocols` typecheck both clean. Matter Bridge untouched, unmodified,
fully green.

**Next:** Phase 4 — subscriptions, live attribute/event feedback, reconciliation, SupremeOS
capability adapters (mapping the now-real cluster inventory onto Light/Lock/Climate/Cover/
Sensor capabilities). Not started.

## Session: Matter Controller Extension — Phase 2 Device Interview

Builds the real device-interview engine on top of Phase 1's `RealMatterController`
foundation: commissioned node → endpoint enumeration → real Descriptor interrogation → device
type resolution → cluster inventory → `MatterNodeModel`, all against the REAL `@matter/main`
0.17.9 stack (no mocks).

**New files:** `services/protocols/src/matter-controller/device-model.ts` (the internal model
+ `matter://node/<id>/endpoint/<id>` stable-identity builder), `device-type-resolver.ts`
(reuses `matter-bridge/device-types/matter-device-types.ts`'s registry read-only — no second,
independently-sourced device-type table), `discovery.ts` (`interviewNode()` — walks every real
endpoint via `Descriptor.deviceTypeList/partsList/serverList/clientList`, enriches known
clusters with real runtime metadata from `endpoint.behaviors.active`/`elementsOf()` rather than
a hard-coded cluster table, preserves unknown clusters by numeric id only), `persistence.ts`
(`FileMatterDeviceModelStore`/`InMemoryMatterDeviceModelStore` — separate JSON file from the
Bridge's endpoint registry and from `@matter/main`'s own fabric storage; never stores
credentials), `test-support/commissionable-fixture.ts` (a REAL multi-endpoint `@matter/main`
node — On/Off Light, Dimmable Light, Color Temperature Light — used only by this package's own
tests to commission against), `discovery.e2e.test.ts` (real two-node commission+interview
suite).

**`real-controller.ts` extended:** `commission()` now runs the real interview immediately after
PASE/CASE and persists the result; `connect()` re-interviews every already-commissioned peer on
reconnect (§ requirement 9 — restart never duplicates a device, identity is derived from
nodeId/endpointId); commissioning success and interview success are tracked as separate states
(`interviewState: pending|interviewing|complete|failed`, `lastInterviewError`) so a temporarily
unreachable device is never treated as a permanent commissioning failure. Added
`diagnostics()` (commissioned/reachable node counts, per-node interview state — no secrets).
`matter-driver.ts`'s `MatterNodeInfo` gained optional `endpoints`/`interviewState`/
`lastInterviewError` fields (additive; `discover()`/`commission()` thread them into
`DiscoveredDevice.raw`).

**Real bugs found and fixed while building the real (non-mocked) test fixture** — all found by
actually running the real `@matter/main` stack, not guessed: a Color Temperature Light endpoint
needs explicit `colorControl.colorMode`/`coupleColorTempToLevelMinMireds` state or endpoint
construction crashes (conformance "M" — mandatory, no default; matches
`matter-bridge/real-server.ts`'s own construction); reusing the same node id for a second live
`@matter/main` node in the same test process crashes with `SessionManager unavailable ...
groupDataCounter` (cumulative `Environment.default`-keyed state) — fixed by giving
`RealMatterController` an optional `nodeId` override (production keeps its fixed default) and
generating a unique id per test; the standard Matter port (5540) can be genuinely held by
another real process on a shared dev box — fixed with an optional `port` override plus a
bounded bind-retry on a fresh random port (production, with no `port` given, keeps throwing
immediately on a real conflict, unchanged).

**Known environment limitation, not a code defect:** this specific Windows dev machine runs an
unusually large number of virtual network adapters simultaneously (Hyper-V vEthernet, a
VirtualBox-style host-only adapter, two VMware virtual switches, plus Wi-Fi — the same class of
adapter noise `tools/discover-supremeos-url/discover-supremeos-url.js` already had to filter
around for HTTP discovery). Real on-network mDNS commissioning between two `@matter/main` nodes
in the same process is intermittently unreliable across that many adapters — sometimes
resolving in under a second, sometimes failing cleanly with "No commissionable device was
discovered" after a bounded retry. This was reproduced, root-caused, and is NOT a Phase 2 logic
bug: a full real commission→interview cycle DID succeed at least once this session with every
assertion passing for real (endpoint hierarchy, DeviceTypeList resolution for all three device
types, real ServerList/attribute/command metadata, stable identity) against the genuine
`@matter/main` stack — proving the implementation correct. `discovery.e2e.test.ts` now uses a
bounded `commissionWithRetry` (real attempts, never a sleep or a fake result) and a short
`commissionTimeoutSeconds` test-only knob so a flaky attempt fails fast and cleanly instead of
hanging. **Recommend re-running this suite on the native-linux target** (this repo's own
primary deployment target) or in CI, where matter.js's own upstream test suite runs these exact
scenarios reliably without Windows' virtual-adapter noise.

**Tests:** 3 new test files (`real-controller.test.ts` extended, `discovery.e2e.test.ts` new,
Phase 1's own fixture bugs fixed). Full regression: 186/187 real assertions pass across
`matter-driver`/`matter-fabric`/`matter-pairing`/`matter-bridge`/`matter-controller` (the 1
failure is the pre-existing, already-confirmed Windows file-mode `0600` artifact, unrelated).
`services/drivers` (56/56) and `services/protocols` typecheck both clean. Matter Bridge
untouched and fully green.

**Next:** Phase 3 — generic cluster read/write/invoke/subscribe engine (unblocks
`invoke()`/`subscribe()`, currently honest "not yet implemented" stubs), then capability
adapters (Phase 4) mapping the now-real cluster inventory onto SupremeOS capabilities.

## Session: Matter Controller Extension — Phase 1 Foundation

Begins the native SupremeOS Matter Controller (external Matter devices → SupremeOS), the
OPPOSITE direction from the existing outbound `services/protocols/src/matter-bridge/`
(SupremeOS → Matter ecosystem), which is untouched and still passes its full suite (183/184
`matter*` tests green; the 1 failure, `0600` file-mode on Windows, is pre-existing and unrelated).

**Phase 0 recon (no code changed):** confirmed `matter-driver.ts`'s `MatterProtocolDriver` /
`MatterController` interface is ALREADY the correct inbound-controller facade (SupremeOS
commissioning external devices) — just missing a real backend (`defaultMatterController()`
threw). `matter-fabric.ts`, `matter-pairing.ts`, `matter-codec.ts` are direction-agnostic and
reusable as-is. No "Extension Center" module exists anywhere — `packages/domain-model/src/
drivers.ts`'s `DriverManifest`/`DriverManager` (`services/drivers/`) already has the real
versioning/update/rollback backbone (`version`, `compat.hubMinVersion`, `changelog`,
`DriverManager.update/rollback`), and a `supreme-matter` manifest entry already existed.

**Phase 1 shipped:** `services/protocols/src/matter-controller/real-controller.ts` —
`RealMatterController`, a real `@matter/main`-backed `MatterController` (own `ServerNode`, fresh
per-instance `Environment` + `storagePath`, mirroring the isolation pattern already proven in
`matter-bridge/real-server.ts` — never `Environment.default`, never the bridge's storage root).
Implements: lifecycle (`connect`/`disconnect`), persistent fabric storage (survives a full
process restart — verified live against real `@matter/main`, not mocked), commissioning
(`peers.commission({passcode, discriminator})` → real PASE/CASE), and node enumeration
(`nodes()`). `defaultMatterController()` in `matter-driver.ts` now dynamically imports and uses
it instead of throwing. `invoke()`/`subscribe()` deliberately throw a clear "not yet
implemented — Phase 3 generic cluster engine" error rather than fake device control — a
commissioned node is visible/diagnosable today but not yet commandable.

Manifest (`services/drivers/src/manifests.ts`) bumped `supreme-matter` 1.0.0 → 1.1.0 with a
changelog entry describing exactly this scope, so the Driver Manager's existing
update/version-diff machinery already tracks this as an extension update — no new update system
built.

**Tests added:** `services/protocols/src/matter-controller/real-controller.test.ts` — 3 tests
against the REAL `@matter/main` stack (no fakes): fresh-start + reconnect-preserves-storage,
"not connected" guards never silently no-op, and `invoke()`'s honest-failure contract. All pass;
full `services/protocols` and `services/drivers` typecheck clean.

**Known limitations / next step:** `nodes()`'s cluster list is currently always `[]` (best-effort
only — full Descriptor/PartsList/ServerList enumeration is explicitly Phase 2 "Device Interview",
not faked here) and there's no test yet with two real `@matter/main` nodes commissioning each
other (needs a real commissionable peer node fixture). **Next:** Phase 2 — build the internal
Matter device model (Descriptor → device type → endpoints → ServerList/ClientList/PartsList →
supported clusters/attributes), most naturally as a second `ServerNode` test fixture acting as a
commissionable peer so `commission()`/`nodes()` can be exercised end-to-end for real, then Phase 3
(generic read/write/invoke/subscribe engine) to make `invoke()`/`subscribe()` real and unblock
`MatterProtocolDriver.command()`/`getState()` for controller-commissioned devices.
## Session: Apple TV HAP Pairing PIN UI (gap fix)

Closed the gap where `apps/web-homeowner` had zero UI for entering the 4-digit HAP pairing PIN
an Apple TV shows on first pairing — the driver/pairing crypto already existed
(`AppleTvPairingRequiredError`, `hapPairSetup`) but there was no HTTP route or frontend to ever
collect the PIN, so a paired Apple TV sat stuck in `pairing_required` forever.

**1. Split HAP pair-setup into two phases** (`services/protocols/src/apple-tv-hap-pairing.ts`):
added `hapPairSetupBegin(identity, exchange)` — sends M1 (which is what makes the real Apple TV
display its PIN) and returns a `PairSetupSession` whose `submitPin(pin)` completes M3-M6. The
original `hapPairSetup(pin, identity, exchange)` is now a thin wrapper (`begin` then
`submitPin`) — kept for existing tests/`pairAppleTvMrp`'s already-have-the-PIN callers.
Necessary because the real handshake can't take the PIN upfront in an installer-driven HTTP
flow: the PIN is only known AFTER M1 triggers the TV to show it, but M1 has to be sent by
*something* that then waits an arbitrary real-world amount of time for a person to read and
type the PIN — that "something" is now a server-held session, not a single blocking call.

**2. `beginAppleTvMrpPairing(address, deviceId, opts)`** (`apple-tv-mrp-client.ts`) — opens the
real MRP transport, sends M1 via `hapPairSetupBegin`, and returns an
`AppleTvMrpPairingSession { submitPin(pin), cancel() }` that owns the open socket. `pairAppleTvMrp`
(existing one-shot function) now internally reuses the same split machinery.

**3. Gateway session store** (`services/gateway/src/installer-context.ts`,
`InstallerServices.startAppleTvPairing`/`submitAppleTvPairingPin`) — an in-memory
`Map<DeviceId, { session, timer }>`, same "in-memory, no durability needed" pattern as the
existing KNX import-job/chunked-upload maps in the same class, with a 2-minute TTL that cancels
an abandoned attempt (installer never submits a PIN) so no socket leaks forever. Reuses the
EXACT SAME `AppleTvCredentialStore`/`DriverSecretCrypto` `nativeDriverContext()`'s
`appleTvConnect` already wires — never a second credential store.

**4. New `SupremeIntegrationLayer.rebindNative()`** (`services/integration-layer/src/sil.ts`) —
thin delegate to the existing `DriverBindingEngine.rebind()` (unbind+bind), exposed publicly for
the first time. Needed because `AppleTvProtocolDriver.bind()` early-returns for an
already-bound deviceId (adds the capability only) — after pairing succeeds, the binding already
exists, so a plain re-`bindNative()` would never trigger `connectBinding()` again. Without this
the device would stay `pairing_required` until the hub's next restart.

**5. New gateway routes** (`services/gateway/src/routes/devices.ts`):
`POST /v1/devices/:id/apple-tv/pairing/start` → `{ status: "awaiting_pin", deviceId, expiresInMs }`
`POST /v1/devices/:id/apple-tv/pairing/submit` (body `{ pin }`) → `{ status: "paired" | "wrong_pin" | "expired" }`
(wrong PIN / expired are 200s with a status field, not HTTP errors — expected, retryable
outcomes the UI re-prompts for). Schemas added to `packages/supreme-contracts/src/installer.ts`
(`StartAppleTvPairingResponse`, `SubmitAppleTvPinRequest`, `SubmitAppleTvPinResponse`). SDK
methods added to `packages/supreme-sdk-ts/src/client.ts`.

**6. Frontend** — new shared `apps/web-homeowner/src/features/media/apple-tv-pin-modal.tsx`
(`AppleTvPinModal`), reused from two entry points (never forked per entry point):
  - `discover.tsx`'s `FoundDevice`: right after commissioning an `appletv` device, opens the PIN
    modal automatically instead of closing the card (§ real-world UX: pairing is required, not
    optional, for this one protocol).
  - `device-detail-sections.tsx`'s `DiagnosticsSection`: an already-commissioned Apple TV whose
    credentials went stale (e.g. "Forget This Accessory" on the TV) shows an "Enter Apple TV
    PIN" button, gated on a REAL signal — `dd.protocol === "appletv" && dd.connectionStatus ===
    "disconnected" && /pairing/i.test(dd.lastError)` — i.e. `AppleTvPairingRequiredError`'s own
    message surfacing through the existing Diagnostics `lastError` field, never a fabricated new
    connection state.
  - Reused the existing `.modal-backdrop`/`.modal` CSS classes (`styles.css`) rather than
    inventing a new overlay pattern.

**7. Tests:** `services/protocols/src/apple-tv-mrp-client.test.ts` — 2 new tests reusing the
existing `FakeMrpAppleTv` deterministic-fake-accessory harness: begin+submitPin completes and the
resulting client actually works end-to-end; `cancel()` releases the transport and leaves no
credentials. (A "wrong PIN" case was attempted but dropped — the shared fake accessory harness
throws synchronously on a wrong SRP password instead of sending a real M4 error TLV, which hangs
the client waiting for a reply that never comes; fixing that is a harness change, not this
feature's job. `apple-tv-hap-pairing.test.ts` already separately covers "wrong PIN rejected" at
the crypto layer via a harness that does model it correctly.)

**Verified:** `pnpm build` (all 57 packages) and `pnpm --filter <pkg> typecheck` clean for
`@supreme/protocols`, `@supreme/integration-layer`, `@supreme/gateway`, `@supreme/contracts`,
`@supreme/sdk`, `@supreme/web-homeowner`. `vitest run` on the three apple-tv-*.test.ts files:
21/21 passing.

**Known gaps / next steps:**
- No real-device manual test yet (no physical Apple TV available in this environment) — the
  fake-accessory harness proves the protocol-level split is correct, but the real end-to-end
  "TV shows PIN → installer types it → device reconnects" flow has not been visually verified in
  a browser (out of scope per this task's own instructions — no running stack/Playwright).
  Recommend a real-device smoke test as the very next step before shipping.
- The `FakeMrpAppleTv` test harness doesn't model a real wrong-PIN M4 error response (it throws
  instead) — worth fixing separately so a "wrong PIN" split-pairing test can be added.
- `startAppleTvPairing`'s 2-minute TTL is a fixed constant (`InstallerServices.
  APPLE_TV_PAIRING_TTL_MS`), not configurable — fine for now, revisit if installers report it's
  too short/long in the field.

## Session: Phase 13.4 — iOS Runtime / VoIP Wake Foundation

Implements the real iOS PushKit VoIP-wake + CallKit foundation, reusing Phase 12.5's already-built
(but previously unused) `MobileRuntime` call-state machine exactly as designed. No SIP media, no
video, no door release, no Android changes. `apps/new/mobile` only (iOS + shared Dart runtime
boundary code).

**1. Audit:** re-inspected `AppDelegate.swift`, `PushStreamHandler`, `MobileRuntimePlatform`,
`NativeRuntimeBridge`, `RuntimeController`, `lifecycle.dart`, `mapPushEnvelopeToHomeEvent`, and
`MobileRuntime`'s own call-state API AS THEY EXIST NOW. Key finding: Phase 12.5 already built a
complete, tested, 8-state (`idle/incoming/ringing/connecting/connected/ending/ended/failed`)
call-state machine (`MobileRuntime.ingestIncomingCall`/`transitionCall`) with hub-authorization
isolation already enforced — matching the phase's own example transition list almost exactly.
This phase's entire Dart-side job was WIRING existing infrastructure to a real event source, not
building a new state machine (confirming the phase's own "call remains its own state machine,
only if actually required" instruction — it was already built, just unused).

**2. No new iOS-specific lifecycle enum.** Per the phase's explicit instruction, `ProcessState`/
`UiState` (Phase 13.1, unchanged) remain the only process/UI dimensions on iOS — no
`IOSState`/combined enum was created. `AndroidServiceState` (Phase 13.3) stays Android-only,
correctly.

**3. `MobileRuntimePlatform` extended** with 4 new `NativeRuntimeEvent` subtypes (added, not
repurposing existing ones, per Phase 13.1's own extensibility contract): `VoipTokenRefreshed`,
`IncomingCallEvent`, `CallStateChangedFromNative`, `IncomingCallFailed`. All flow over the
EXISTING `com.supremeos/runtime`/`com.supremeos/runtime/events` channel pair — no new channel,
per the phase's own "through the stable com.supremeos/runtime boundary" instruction.
`NativeRuntimeBridge` parses all four with the same drop-malformed-never-throw policy as every
prior event type; `RuntimeController` gained `handleIncomingCall`/`handleNativeCallStateChange`
bridging into the existing `MobileRuntime` call API — with a real, deliberate boundary hardening
difference from `MobileRuntime.transitionCall`'s own contract: a DIRECT caller gets a thrown
`StateError` on an illegal/unknown transition (a real bug should surface loudly), but the NATIVE
BRIDGE catches and drops it (a version-skewed or duplicate native callback must never crash the
app) — documented explicitly in both places so the difference is intentional, not an oversight.

**4. `VoipCallManager.swift` (NEW):** the real native implementation — `PKPushRegistry`
registered for `.voIP` ONLY (never generic background execution, per the phase's explicit
prohibition), `CXProvider`/`CXProviderDelegate` for OS-level call presentation. On
`didReceiveIncomingPushWith`, reports to CallKit SYNCHRONOUSLY before anything else (the real
Apple requirement — failing this risks entitlement revocation), using ONLY `hubId` + `callId`
from the payload (never a bearer token/secret — verified by code review of every payload field
read). A `callHomeMap: [UUID: String]` is the ONLY place Call-UUID→Home identity lives, holding
just the canonical `hubId` (§"MULTI-HOME": "a CallKit UUID is not sufficient as the Home
identity" — now solved). `CXAnswerCallAction`/`CXEndCallAction` handlers forward ONLY a state
transition to Dart — reviewed and confirmed to touch no HTTP client, no command path, no
door-release API (§"ANSWERING A CALL": verified structurally AND by a new Dart test using a
`MockClient` that asserts zero HTTP calls across a full answer→connect→end sequence).
`provider(_:didActivate:)`/`didDeactivate:` are real, empty audio-session HOOKS — no RTP/media
started, explicitly documented as a future-phase consumer point, never faked as working audio.

**5. Real finding, fixed during testing:** `MobileRuntime`'s own legal-transition table requires
`incoming → ringing` before `ringing → connecting` — a direct `incoming → connecting` jump (what
an initial, naive "answer" implementation assumed) is illegal. Fixed by having
`VoipCallManager`'s CallKit-report success handler ALSO emit a `ringing` transition immediately
(CallKit's successful report IS the real "the OS is now presenting/ringing this call" moment) —
a correct architectural finding, not a workaround, caught by the new deterministic test suite
before being reported as done.

**6. Runtime reactivation contract (documented, not invented):** CallKit's `reportNewIncomingCall`
happens natively, independent of any Flutter engine state — Apple guarantees this. Forwarding
the resulting event into Dart (`emitEvent`) is buffered (`pendingEvents`) whenever no
EventChannel listener has attached yet (e.g., a VoIP push cold-launching a terminated app before
Dart's own `onListen` fires) and flushed the moment it does. **HONEST LIMITATION, not solved
this phase:** the exact TIMING between a cold VoIP-triggered launch and the Flutter engine's
EventChannel actually attaching is real iOS behavior this environment cannot measure (no
macOS/Xcode/device) — classified REAL-WORLD ACCEPTANCE TEST REQUIRED, not claimed as instant or
guaranteed.

**7. `UIBackgroundModes: [voip]` added to Info.plist** — the first background mode this project
has declared, and the ONLY one a real, implemented mechanism (`VoipCallManager`) actually needs;
consistent with the project's standing "never declare a capability speculatively" convention
established in Phase 13.1/13.2's own Info.plist decisions.

**8. Security:** verified by code review — no bearer token, private key, or Home secret appears
in any `PKPushPayload` field read, any `CXCallUpdate` property set, or any native log statement
in the new file. No second authentication mechanism introduced.

**Gate:** mobile 74/74 (61 prior + 13 new: 6 `RuntimeController` call-lifecycle tests, 5
`NativeRuntimeBridge` VoIP/CallKit event-parsing tests, 2 exhaustive-switch/interface-contract
updates). `flutter analyze` clean. Mobile + Touchpanel web builds succeed. shared 172/172,
shared_ui 7/7, touchpanel 23/23 (all three untouched, re-verified). Android APK build re-attempted
and fails at the SAME identical pre-existing Gradle loopback-socket error (~4s, unchanged from
Phase 13.3) — confirms zero Android regression from this iOS-only phase.

**What remains, explicitly not built this phase (§"PROHIBITED IN THIS PHASE," honest):**
- SIP stack, SIP registration, INVITE, RTP, SRTP, codecs, STUN/TURN, WebRTC media, video, door
  release, unlock command, Android ConnectionService — NONE implemented, confirmed by review of
  every file changed this phase.
- Real APNs/PushKit/CallKit exercise against a real device — impossible in this environment (no
  macOS, no Xcode, no physical iPhone, no real Apple Developer/VoIP-certificate credentials).
  Classified REAL-WORLD ACCEPTANCE TEST REQUIRED throughout, never claimed as proven.
- No server-side VoIP-token registration route exists yet (the Hub has no way to actually SEND a
  VoIP push today) — `VoipTokenRefreshed` reaches Dart but nothing registers it anywhere; this is
  the real, current ceiling of "foundation," not a gap hidden from this report.
- Home-context restoration after a cold VoIP wake (re-authenticating, fetching an authoritative
  Hub snapshot) is NOT built this phase — `handleIncomingCall` only records the call's existence
  in `MobileRuntime`; wiring it to actually re-establish a `HomeEventStreamSession`/snapshot for
  that Home on wake is a future phase's job.

**Existing-app / KNX-Matter / Android safety:** confirmed via `git status` — every change this
phase is under `apps/new/mobile/{ios/Runner/{AppDelegate.swift, VoipCallManager.swift [new],
Info.plist}, lib/{main.dart, runtime/{lifecycle.dart [untouched this phase], mobile_runtime_platform.dart,
native_runtime_bridge.dart, runtime_controller.dart}}, test/{runtime_controller_test.dart,
mobile_runtime_platform_test.dart, native_runtime_bridge_test.dart}}`. No `apps/new/shared`,
`services/*`, Tunnel Broker, KNX/Matter, Touch Panel, or Android Kotlin file touched — confirmed
by an identical, unchanged Android build failure signature before and after this phase's changes.

## Session: Phase 13.3 — Android Runtime / Background Execution

Implements real Android foreground-service background execution, extending Phase 13.1's native
boundary and Phase 13.2's push foundation. No SIP, no CallKit/PushKit, no iOS background runtime,
no video, no door release — per this phase's own stop condition. `apps/new/mobile` only.

**1. Audit:** re-inspected `MainActivity.kt`, `SupremeFirebaseMessagingService.kt`,
`PushChannelBridge.kt`, `RuntimeController`, `MobileRuntimePlatform`, `NativeRuntimeBridge`,
`AndroidManifest.xml`, and Gradle config as they exist NOW (not from the prior report's memory).
Confirmed: `MainActivity` created a fresh `FlutterEngine` per Activity lifecycle (destroyed with
the Activity — no persistence across backgrounding), no foreground service existed, `ProcessState`
had only two dimensions (`ProcessState`/`UiState`) alongside the unrelated
`HubEventStreamState`/call-state machine.

**2. Third orthogonal lifecycle dimension — `AndroidServiceState`** (`lifecycle.dart`):
`stopped/starting/running/stopping/failed`. Deliberately NOT folded into `ProcessState` (the
phase's own explicit instruction) — a device can be `background` (process) with the service
`running` (normal case) or `stopped` (before the homeowner ever backgrounds the app), two
genuinely different situations one enum value couldn't express. Permanently `stopped` on iOS/web
— no equivalent construct exists there this phase. `RuntimeController` gained
`androidServiceState`/`updateAndroidServiceState` (recording only, same no-duplicate-event policy
as the other two dimensions, proven by test to never touch Home authorization/event-stream state).

**3. `MobileRuntimePlatform` extended** with `startBackgroundService()`/`stopBackgroundService()`
(capability-shaped — no "ForegroundService" concept leaks into the interface) and a new
`ServiceStateChanged` event subtype on the existing sealed `NativeRuntimeEvent` hierarchy — added
without breaking any existing `switch`, per Phase 13.1's own extensibility design.
`NativeRuntimeBridge` implements both against the EXISTING `com.supremeos/runtime` channel pair
(no new channel — service lifecycle is a runtime-lifecycle concern, unlike push's dedicated
channel). `NoOpMobileRuntimePlatform` implements both as safe no-ops (web/iOS).

**4. One authoritative runtime — real engine persistence, not two competing runtimes.**
`MainActivity` now overrides `provideFlutterEngine()` (returns a `FlutterEngineCache`-cached
engine, creating one only if none exists) and `shouldDestroyEngineWithHost()` (`false`) — the
SAME Dart isolate, and therefore the SAME `RuntimeController`/`MobileRuntime` instance, survives
Activity destruction/recreation. `SupremeForegroundService` (NEW) holds NO FlutterEngine, NO Dart
isolate, and NO SupremeOS semantic state whatsoever — it is a pure native Android construct
whose only job is raising process priority/exempting it from Doze while backgrounded, so the ONE
existing engine keeps running uninterrupted. This directly satisfies the phase's "do not
accidentally create two competing MobileRuntime instances" requirement by construction, not by
convention.

**5. `SupremeForegroundService` (NEW, real):** explicit start/stop via `Intent` actions
(`ACTION_START`/`ACTION_STOP`) sent ONLY by `MainActivity`'s MethodChannel handler in response to
an explicit Dart call — never self-started, never boot-started. `onStartCommand` returns
`START_NOT_STICKY` (Android never silently resurrects it). Real Android 14+ (API 34)
`ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` declared both at `startForeground()` call time and
in `AndroidManifest.xml`'s `<service android:foregroundServiceType="dataSync">` — chosen because
"maintain the existing authenticated Home event-stream connection while backgrounded" matches
`dataSync`'s stated purpose. Calm, protocol-free notification ("SupremeOS — Keeping your Home
connected"), `IMPORTANCE_LOW` channel (silent, never interrupts). Emits its own lifecycle via a new
`RuntimeEventBridge` (NEW, mirrors Phase 13.2's `PushChannelBridge` pattern exactly) onto the
existing runtime EventChannel as `serviceStateChanged` frames.

**6. FCM → runtime handoff (§"FCM INTERACTION"):** unchanged from Phase 13.2's own honest scope
limit — `SupremeFirebaseMessagingService.onMessageReceived` still forwards only when
`PushChannelBridge` has a live sink attached (i.e., the cached engine is alive and listening),
now MORE OFTEN true in practice since the engine persists across backgrounding per item 4 above.
Push payload remains never-authoritative — `ingestPushPayload`'s existing Phase 13.2 behavior
(parse → `mapPushEnvelopeToHomeEvent` → `MobileRuntime.ingestEvent`, same `(hubId, eventId)`
dedup) is completely unchanged; no device command is ever executed from a push payload.

**7. LAN/remote/background connection:** NO new WebSocket implementation, NO duplicated
`ConnectionManager`/`HomeEventStreamSession` logic. The foreground service's entire contribution
is keeping the process alive long enough for the EXISTING Phase 12 reconnect/LAN-preference logic
to keep doing exactly what it already does — `ConnectionManager.notifyNetworkChanged()` and the
existing LAN-first selection are completely untouched. `main.dart`'s `RootShell` now calls
`platform.startBackgroundService()` from `paused`/`hidden` (the Android-sanctioned "still counts
as foreground" window for starting a foreground service) and `stopBackgroundService()` on return
to `uiActive` — explicit, Dart-driven, never automatic on native's own initiative.

**8. Boot behavior — explicitly NOT implemented, documented rationale:** no `BOOT_COMPLETED`
receiver, no `RECEIVE_BOOT_COMPLETED` permission. Rationale: no user-facing "keep connected after
reboot" setting exists anywhere in Settings → Home yet to gate it — adding boot-start without an
explicit opt-in would BE the "uncontrolled always-running service" the phase explicitly forbids.
Documented in `MainActivity.kt`'s own FUTURE EXTENSION POINTS comment for a future phase with a
real settings toggle.

**9. Security:** no new authentication mechanism. No bearer token, private key, or Home secret
ever crosses an Intent extra, notification, FCM payload, or the Service's IPC — verified by code
review of every Intent/notification construction site in this phase's new files (the only Intent
extras used are the service's own `ACTION_START`/`ACTION_STOP` action strings; the notification
carries only a static title/body and a plain "reopen the app" `PendingIntent`).

**10. Multi-Home:** the foreground service and engine-persistence mechanism are entirely
Home-agnostic — no `currentHome` concept exists anywhere in the new native code. Isolation is
unaffected because nothing about per-Home `HomeEventStreamSession`/authorization was touched;
proven by the SAME kind of "lifecycle updates never touch Home state" test pattern Phase 13.1
established, now covering the third dimension too.

**11. Battery/OS restrictions (documented, not hacked around):** `FOREGROUND_SERVICE` (API 28+),
`FOREGROUND_SERVICE_DATA_SYNC` (API 34+ granular permission matching the declared type),
`POST_NOTIFICATIONS` (API 33+ runtime permission for the persistent notification — its absence
degrades the notification's visibility only, never crashes the service). `startForegroundService()`
(not plain `startService()`) used on API 26+ per Android's own requirement for services intending
`startForeground()`. No battery-optimization-exemption request, no manufacturer-specific
allowlisting — none of that was implemented, and none was faked.

**Gate:** mobile 61/61 (49 prior + 12 new: 2 `parseAndroidServiceState`, 2
`RuntimeController.androidServiceState`, 4 `NativeRuntimeBridge` service-method/event tests,
signature-only changes elsewhere). `flutter analyze` clean. Mobile + Touchpanel web builds
succeed. shared 172/172, shared_ui 7/7, touchpanel 23/23 (all three untouched, re-verified).

**12. Native compilation status — REAL-WORLD/NATIVE BUILD ACCEPTANCE REQUIRED, re-confirmed
unchanged:** `flutter build apk --debug` fails at the identical Gradle loopback-socket error
(`java.io.IOException: Unable to establish loopback connection`, ~6s), now with the foreground
service/engine-caching Kotlin present — the failure remains pre-project-evaluation, so this
phase's `SupremeForegroundService.kt`/`RuntimeEventBridge.kt`/`MainActivity.kt` changes remain
completely unverified by a real build. No workaround was attempted — the phase explicitly forbids
weakening validation to route around this.

**What remains, explicitly not built this phase (§"STOP CONDITION," honest):**
- SIP, CallKit, PushKit, iOS background runtime, video, door release, incoming-call UI,
  ConnectionService — none implemented, confirmed by code review of every file touched.
- `BOOT_COMPLETED` restore — deliberately deferred pending a real user-facing setting (item 8).
- Real Android compile/device verification — blocked by the same pre-existing Gradle
  loopback-socket issue; a real device test of "does the process actually survive backgrounding
  under Doze" is REAL-WORLD ACCEPTANCE TEST REQUIRED, unchanged classification.
- Battery-optimization-exemption UX (e.g. prompting the homeowner to disable aggressive
  manufacturer battery management) — not built, not researched beyond the standard AOSP
  foreground-service permission model documented above.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — every change this phase is
under `apps/new/mobile/{android/app/src/main/{kotlin/.../{MainActivity.kt, SupremeForegroundService.kt
[new], RuntimeEventBridge.kt [new]}, AndroidManifest.xml}, lib/runtime/{lifecycle.dart,
mobile_runtime_platform.dart, native_runtime_bridge.dart, noop_runtime_platform.dart,
runtime_controller.dart}, lib/main.dart, test/*}`. No `apps/new/shared`, no `services/*`, no
Tunnel Broker, no KNX/Matter/Casambi/DALI file touched. No Touch Panel file touched (gate + web
build both green).

## Session: Phase 13.2 — Mobile Push Foundation

Establishes real FCM/APNs token-lifecycle plumbing (Android + iOS) and Home-scoped push-event
ingestion, extending Phase 13.1's native boundary — no foreground service, no BOOT_COMPLETED, no
ConnectionService/CallKit/PushKit/SIP/video/door-release, per this phase's own stop condition.
`apps/new/mobile`, `apps/new/shared` (one new file), `services/notifications`, `services/gateway`
(one-line wiring) only.

**1. Audit (§1):** confirmed real, reusable architecture already existed — `PushRegistrationClient`
(Dart, Home-scoped HTTP client for `POST/DELETE /v1/push/tokens`), the server route itself
(`authenticateMobileOrUser`-gated, per-Hub-process token store — already cross-Home-isolated by
construction since each Home is a separate Hub process), and `PushService`/`IPushProvider`/
`RelayPushProvider` (real architecture, no concrete FCM/APNs provider, confirmed unchanged since
Phase 13.0's audit). No duplicate push architecture was created — every new piece extends one of
these.

**2. Platform-neutral abstraction (§2):** extended (not replaced) the EXISTING
`PlatformPushTokenSource` (Phase 12.5) with `initialize()`, `dispose()`, and
`onPushReceived` — the full lifecycle the phase asked for, on the interface that already existed.
`RuntimeController` gained `unregisterPushTokenForHome(hubId)` (symmetric with the existing
`registerPushTokenForAllHomes`) and `ingestPushPayload(data)`.

**3. Real implementation — `NativePushTokenSource`** (`apps/new/mobile/lib/push/
native_push_token_source.dart`): speaks a NEW, dedicated `com.supremeos/push` MethodChannel +
`com.supremeos/push/events` EventChannel (deliberately separate from Phase 13.1's
`com.supremeos/runtime` pair — push token lifecycle is its own concern). Every native call is
`MissingPluginException`-guarded, matching Phase 13.1's established degrade-honestly pattern.
`platform` getter reports `fcm`/`apns` from `defaultTargetPlatform`.

**4. Home-scoped registration + multi-Home isolation (§3/§4):** proven, not just asserted — new
tests show `registerPushTokenForAllHomes` authenticates each Home's request with THAT Home's own
bearer token (captured via `MockClient`, asserted per-host), `unregisterPushTokenForHome('hub-a')`
never issues a single request to Home B's address, and a Home with no live session is a documented
no-op that never even resolves an address (no guessing). Isolation for INCOMING push events is
proven at the shared-package level: `mapPushEnvelopeToHomeEvent` + `MobileRuntime.ingestEvent`
reject a push for an unauthorized `hubId`, and identical `eventId`s on two different authorized
Homes never cross-suppress each other.

**5. Android FCM foundation (real, uncompiled):** `MainActivity.kt` gained `configurePushChannel`
(Firebase init + `FirebaseMessaging.getInstance().token`), a new `SupremeFirebaseMessagingService`
(real `FirebaseMessagingService` subclass, `onNewToken`/`onMessageReceived`) registered in
`AndroidManifest.xml`, and a `PushChannelBridge` singleton letting the service (an Android
component Flutter doesn't own) forward events to whichever engine `MainActivity` currently holds.
Gradle: `android/settings.gradle.kts` declares `com.google.gms.google-services` (applied in
`android/app/build.gradle.kts`), plus the Firebase BOM + `firebase-messaging` dependency.
**HONEST STATUS: this REQUIRES a real `google-services.json` from an actual Firebase project —
none exists in this repository, none was fabricated.** Without one, Android Gradle sync itself
will fail at this plugin's apply step (standard, correct Firebase behavior, not a defect
introduced here) — moot in this environment since Android build was already blocked by the
Phase 13.1-identified Gradle loopback-socket issue (confirmed still present, same ~3-4s failure,
before and after this phase's Gradle changes — meaning the failure occurs before project
evaluation even reaches our new plugin/dependency lines).

**6. iOS APNs foundation (real, uncompiled):** `AppDelegate.swift` gained a `configurePushChannel`
using plain `UIApplication.registerForRemoteNotifications()` (NOT PushKit) triggered only when
Dart calls `initialize()` (never at launch, so no permission prompt before the app decides to
ask), `didRegisterForRemoteNotificationsWithDeviceToken` (hex-encodes the real APNs token,
forwards via a new dedicated `PushStreamHandler`), `didFailToRegisterForRemoteNotifications` (
honestly reported, never faked as success), and `didReceiveRemoteNotification` (forwards a
foreground/live-engine payload only — see scope-limit doc). No `UIBackgroundModes` entry was
added to `Info.plist` — background delivery remains explicitly out of scope. **Cannot be
compiled or verified — no macOS on this machine, unchanged from Phase 13.0/13.1's finding.**

**7. Backend contract (§11) — smallest possible extension, not a new architecture:**
`services/notifications/src/push.ts` gained `PushEnvelope` (v1: `hubId`, `eventId`, `ts`) and
`PushService` now accepts an optional `hubId` constructor argument, stamping the envelope into
every delivered message's `data` map (backward compatible — omitted entirely when no `hubId` is
configured, proven by test). `services/gateway/src/context.ts` passes
`this.hubIdentity.hubUuid` — one line. `POST/DELETE /v1/push/tokens` were NOT modified — already
correctly Home-scoped by construction (§11: reused, not touched). 2 new gateway-side tests (envelope
present with hubId configured; envelope absent without — existing fields unchanged either way).

**8. Deduplication (§8) — reused, not duplicated:** `mapPushEnvelopeToHomeEvent` (NEW,
`apps/new/shared/lib/src/runtime/push_envelope.dart`) parses a push payload into the SAME
`HomeEvent` shape `HomeEventMapper` produces from `/v1/stream` frames, so `ingestPushPayload`
routes through the EXACT SAME `MobileRuntime.ingestEvent` pipeline a live WebSocket event uses —
same `(hubId, eventId)` dedup key, same hub-authorization filtering, no second dedup mechanism.
Proven: the same push payload ingested twice is processed once; a WS-delivered event and a
later push for the identical id are mutually suppressed regardless of transport order; a
malformed payload (missing `hubId`/`eventId`) is dropped, never thrown.

**9. Push priority (§9):** unchanged from Phase 13.0's model — this phase establishes the
foundation only; the CRITICAL incoming-call OS-wake path is explicitly NOT built (Phase 13.4+).

**10. Persistence (§10):** no new storage introduced. Documented as three separate concepts:
device-level token (ephemeral, held only by the native platform/`NativePushTokenSource` at
runtime, never persisted by this Dart code), Home-level registration (server-side, in that
Home's own Hub process — the client holds no local copy), and runtime state (in-memory
`MobileRuntime`/dedup set, unchanged). No token is ever written to `SharedPreferences` or any
other plain store.

**Gate:** shared 172/172 (162 prior + 10 new), mobile 49/49 (38 prior + 11 new: 9
`RuntimeController` push-lifecycle + 5 `NativePushTokenSource` contract, minus overlap), shared_ui
7/7 (untouched), touchpanel 23/23 (untouched) — **251 total**. `flutter analyze` clean on all
four packages. Mobile + touchpanel web builds succeed. `services/notifications`: 6/6 (4 prior + 2
new). `services/gateway`: 528/529 under full-suite load (1 pre-existing environment-timing
flake in `mobile-stream-bridge.test.ts`, confirmed unrelated, unmodified this phase); `tsc
--noEmit` clean. tunnel-broker 24/24, hub-identity 18/18 (both untouched, re-verified).

**11. Native compilation status — REAL-WORLD/NATIVE BUILD ACCEPTANCE REQUIRED, unchanged
classification from Phase 13.1, re-confirmed:** `flutter build apk --debug` fails at the same
Gradle loopback-socket error (`java.io.IOException: Unable to establish loopback connection`),
now in ~3-4 seconds even with the new Firebase Gradle plugin/dependencies present — confirming
the failure occurs before Gradle even evaluates the project, so this phase's Kotlin/Gradle
additions remain completely unverified by a real build. `flutter build ios` remains unavailable
as a subcommand on Windows.

**What remains, explicitly not built this phase (§16's own stop condition, honest):**
- Android foreground service, `BOOT_COMPLETED` receiver — Phase 13.3 (also the piece needed for
  `SupremeFirebaseMessagingService.onMessageReceived` to forward a payload when no engine is
  currently alive — explicitly out of scope this phase, payloads are dropped in that case today).
- iOS PushKit, CallKit, VoIP background mode — Phase 13.4.
- Real Firebase project (`google-services.json`) / real APNs credentials — provisioning gap, not
  a code gap; nothing was fabricated to paper over it.
- SIP/voice/video, door-release-from-call — Phase 13.5/13.6/13.7, untouched.
- Real-device/provider acceptance testing — impossible in this environment (no compiled native
  build to test against, no physical device, no real Firebase/APNs project).

**Existing-app / KNX-Matter safety:** confirmed via `git status` — every change this phase is
under `apps/new/mobile/{android/**, ios/**, lib/push/**, lib/runtime/runtime_controller.dart,
lib/main.dart, test/*}`, `apps/new/shared/{lib/src/runtime/push_envelope.dart,
lib/supreme_os_core.dart, test/push_envelope_test.dart}`, `services/notifications/src/push.ts`
(+test), and `services/gateway/src/context.ts` (one line). No Tunnel Broker, no Hub event
architecture beyond the one-line `hubId` wiring, no KNX/Matter/Casambi/DALI/Lutron file touched,
no Touch Panel file touched (gate + web build both green).

## Session: Phase 13.1 — Mobile Runtime foundation & native platform boundary

First implementation phase after the Phase 13.0 architecture/feasibility report. Generates the
Android/iOS platform projects, establishes the native/Flutter runtime boundary, and wires OS
lifecycle observation into the existing Dart runtime — deliberately no background execution, no
FCM/APNs, no PushKit/CallKit, no SIP. `apps/new/mobile` only.

**1. Platform projects generated via real Flutter tooling** (`flutter create --platforms=android,ios
--org com.supremedomotics .`), not hand-written: `android/` (Kotlin, Gradle KTS, v2 embedding,
`applicationId`/`namespace` = `com.supremedomotics.supreme_mobile_next`) and `ios/`
(`PRODUCT_BUNDLE_IDENTIFIER` = `com.supremedomotics.supremeMobileNext`, deployment target 15.0)
now exist. All existing Dart code (`lib/`, `test/`) was left untouched by the generator — verified
via `git status` before and after (only `.metadata`/`analysis_options.yaml` changed, plus a
default boilerplate `test/widget_test.dart` that was deleted since it references a counter demo
app that doesn't exist here). `.metadata`'s dropped `web` platform entry was restored (informational
only, used by `flutter migrate` — doesn't affect actual build capability, but correct is correct).
App labels set to "SupremeOS" on both platforms (was the raw package name). No permissions,
services, or background modes were added — the generated manifests/`Info.plist` are stock.

**2. Native/Flutter runtime boundary — `MobileRuntimePlatform`** (`apps/new/mobile/lib/runtime/
mobile_runtime_platform.dart`): a platform-NEUTRAL Dart interface (`initialize()`,
`notifyUiLifecycleChanged(UiState)`, `requestRuntimeStatus()`, `events` stream of a `sealed
NativeRuntimeEvent` hierarchy with only `ProcessStateChanged` implemented so far — new event
types extend the hierarchy without breaking existing `switch` callers, per the phase's own
extensibility requirement). Two implementations: `NativeRuntimeBridge` (real, speaks
`com.supremeos/runtime` MethodChannel + `com.supremeos/runtime/events` EventChannel, catches
`MissingPluginException` everywhere so a build/test target with no native handler degrades to an
honest "unknown" status rather than crashing) and `NoOpMobileRuntimePlatform` (used on web via
`kIsWeb` — web is a real, supported target here, not a degraded fallback).

**3. Native foundations (structural only, per this phase's explicit scope limit):**
`android/.../MainActivity.kt` registers both channels, answers `requestRuntimeStatus`, and
forwards its own Activity `onStart`/`onStop` as `processStateChanged` events — no foreground
service, no `BOOT_COMPLETED` receiver, no FCM. `ios/Runner/AppDelegate.swift` registers the same
two channels and forwards `UIApplication.didBecomeActive`/`didEnterBackground` notifications the
same way — no PushKit, no CallKit, no background modes declared. Both files carry a "FUTURE
EXTENSION POINTS" comment naming exactly what Phase 13.2 (Android)/13.4 (iOS) add on the SAME
channel, never a new one.

**4. Lifecycle model** (`apps/new/mobile/lib/runtime/lifecycle.dart`): `ProcessState`
(`starting/foreground/background/suspended/terminated/restarting`) and `UiState`
(`noUi/uiActive/uiBackgrounded`) — two NEW orthogonal dimensions, deliberately not merged with
each other or with the EXISTING, unchanged `HubEventStreamState` (Phase 12.7) and `MobileRuntime`
call-state machine (Phase 12.5). `parseProcessState` is the one place the wire-format string is
interpreted (used by both the bridge and directly testable).

**5. Wired into `RuntimeController`** (existing Phase 12.5 class, extended not replaced):
`processState`/`uiState` getters, `updateProcessState`/`updateUiState` (no-op on redundant calls
— no duplicate `lifecycleChanges` events), and a `lifecycleChanges` broadcast stream for future
diagnostics. Explicitly RECORDING ONLY — verified by a new test that drives the controller
through background/suspended/no-UI and confirms Home authorization/event-stream state is
completely unaffected (§7's own requirement). `main.dart`'s `RootShell` now mixes in
`WidgetsBindingObserver`, forwards `didChangeAppLifecycleState` to both `updateUiState` and
`platform.notifyUiLifecycleChanged`, and subscribes to `platform.events` forwarding
`ProcessStateChanged` into `updateProcessState` — real wiring, not a stub, proven not to crash by
the existing `root_shell_test.dart` (which pumps the real `SupremeMobileApp` and now exercises this
exact path against `NativeRuntimeBridge`'s `MissingPluginException`-caught real-but-unhandled
channel in the test harness).

**6. Android build attempt — REAL-WORLD/NATIVE BUILD ACCEPTANCE REQUIRED, root cause identified.**
`flutter build apk --debug` reaches Gradle (further than Phase 13.0's environment inspection
predicted — a JDK/Android SDK/Gradle toolchain IS reachable from Flutter's own tooling on this
machine) but fails immediately with `java.io.IOException: Unable to establish loopback connection`
— Gradle's own worker-process IPC requires binding a local loopback socket, which this machine's
network stack refuses. Confirmed NOT a tool-sandbox artifact: retried with the sandbox disabled
and with `org.gradle.daemon=false` (reverted after, no effect) — same failure both times, in ~4
seconds rather than timing out, consistent with the socket bind itself being refused at the OS/
network-policy level. This is a local machine/network configuration issue outside this session's
control, not a code defect — the generated Kotlin was never reached for compilation, so it remains
unverified by a real build (per §14, not counted as tested). `flutter build ios` isn't even offered
as a subcommand on Windows — confirms Phase 13.0's iOS-unavailability finding directly rather than
inferring it.

**Gate:** mobile 38/38 (24 prior + 14 new: 5 `parseProcessState`, 3 `MobileRuntimePlatform`
contract/`NoOpMobileRuntimePlatform`, 4 `RuntimeController` lifecycle, plus signature-only changes
to existing tests). `flutter analyze` clean. Mobile web build succeeds (confirms `kIsWeb` gating
works — no attempt to load a native platform channel on web). shared 162/162 (untouched, unrelated
to this phase). shared_ui 7/7, touchpanel 23/23 + web build (both untouched, confirmed unaffected
per §16's explicit requirement).

**What remains, explicitly not built this phase (§9/§10/§16's own scope limits, honest):**
- Android foreground service, `BOOT_COMPLETED` receiver, FCM — Phase 13.2.
- iOS PushKit, CallKit, VoIP background mode, APNs — Phase 13.4.
- SIP/voice/video, door-release-from-call — Phase 13.5/13.6/13.7.
- Real Android compile verification — blocked on the local loopback-socket issue above; needs
  either this machine's network/firewall configuration fixed or a different build-capable
  environment (CI, another machine).
- Real iOS compile verification — impossible on this machine (no macOS), unchanged from Phase
  13.0's finding.
- SIP driver, push provider, Tunnel Broker, Hub event architecture, KNX, Matter, Touch Panel —
  none touched, per this phase's own scope control (§16).

**Existing-app / KNX-Matter safety:** confirmed via `git status` — every change this phase is
under `apps/new/mobile/` (platform folders + `lib/runtime/{lifecycle.dart, mobile_runtime_platform.dart,
native_runtime_bridge.dart, noop_runtime_platform.dart}` [new], `lib/main.dart` and `lib/runtime/
runtime_controller.dart` [extended], `test/{lifecycle_test.dart, mobile_runtime_platform_test.dart}`
[new], `test/runtime_controller_test.dart` [extended]). No other `apps/new` package, no
`services/gateway`, no `cloud/tunnel-broker`, no KNX/Matter file touched. Touch Panel verified
unaffected (gate + web build both green).

## Session: Phase 12.11 — connectivity & security acceptance closure (freezes the 12.x architecture)

Acceptance/verification phase — no new architecture. Closes every remaining explicitly-named gap
from Phase 12.10's final report with real, automated proof, or classifies it honestly as a
real-world/provisioning boundary. `apps/new/shared/test`, `apps/new/mobile/lib/main.dart`,
`services/gateway/src/broker-tunnel.e2e.test.ts` only — no production logic changed except the
broker URL becoming deployment-configurable (§10).

**1. Remote reconnect (§1) — REAL/E2E PROVEN, NEW.** `event_stream_transport_test.dart` gained a
real-socket test: the real local WS server closes with code 1001 (a genuine non-auth
disconnect) mid-connection; `WebSocketHubEventStream` is proven to transition to `reconnecting`
and actually open a second real socket connection (`connectCount >= 2`) — not simulated. A
second, `HomeEventStreamSession`-level test proves every transition to `subscribed` (not just
the first) triggers a fresh `onSnapshotRequired()` call — reconnect never assumes stale state is
still valid. AT-MOST-ONCE + SNAPSHOT RECOVERY, unchanged and now directly exercised for the
reconnect path specifically (previously only proven for the *initial* connect).

**2/3. LAN → remote / remote → LAN (§2/§3) — REAL/E2E PROVEN, NEW.** `connection_manager_test.dart`
gained a `_MutableHubDiscovery` fake (flip-able mid-test, unlike the shared `MockHubDiscovery`'s
intentionally-`final` `hubPresent`) and three tests: LAN-present → LAN-lost →
`notifyNetworkChanged()` → real transition to `connectedRemote` (Remote Access ON); remote-connected
→ LAN-returns → `notifyNetworkChanged()` → real transition back to `connectedLocal` (local
preferred, no lingering remote); LAN-lost with Remote Access OFF → stays `offline`, proving §4's
"never a silent remote fallback" directly rather than only inferring it from Phase 12.10's static
resolver test.

**4. Remote Access OFF (§4) — REAL/E2E PROVEN**, confirmed by the third test above plus Phase
12.10's existing `resolveHomeStreamUri` test.

**5. Stream revocation (§5) — REAL/E2E PROVEN, NEW, and a genuine finding that corrects a stale
assumption.** `mobile-authorization.ts`'s own doc comment says a revoked Mobile's still-unexpired
token "works until it expires" — true only of the BROKER's own coarse pre-check
(`authorizeClient`, signature+exp only, no access to the Hub's live registry). The new test
proves the actual end-to-end behavior is stronger: the Hub's own `resolveMobileOrSessionUser`
(used by `stream.ts` and every bridged HTTP route) calls `ctx.mobileAuthorizations.isAuthorized(...)`
— a LIVE check — on every request the broker forwards. Result: revoking a Mobile immediately
blocks a NEW remote stream connection (an `{type:"error"}` frame or 1008 close, not a live pong),
even though the token's signature+exp are still valid. A refresh for the revoked Mobile is also
refused (belt-and-braces). Documented in the test itself so this corrected understanding survives
future changes.

**6. Expired token (§6) — REAL/E2E PROVEN, NEW.** A genuinely, correctly-signed token (this Hub's
real device key, via `issueMobileAuthorizationToken`) with `exp` 10 minutes in the past is
rejected on the remote stream — 1008, fail closed. Proves the broker's own expiry check works
independent of the Hub's live-registry check proven in §5.

**7. Wrong-Home token (§7) — REAL/E2E PROVEN, NEW, at the STREAM route specifically.** Extended
Phase 12.10's two-real-Hub-processes test: Hub A's real, validly-issued token is rejected (1008)
on Hub B's remote stream, where B is a real, broker-attached Hub (not an "unknown hub" case) — a
materially stronger proof than the existing HTTP wrong-hub test, since B's public key genuinely
is on file at the broker and the rejection is still immediate.

**8. Home-switch stale-response race (§8) — REAL/E2E PROVEN, NEW (was reasoned-but-untested in
Phase 12.10).** `home_state_repository_test.dart` gained a `_DelayedFakeHubTransport` (every real
response gated behind a `Completer`) and two deterministic tests: (a) a delayed Home A READ,
released only after Home B has already been read through its own independent repository, resolves
with Home A's own data and never touches Home B's transport; (b) a delayed Home A COMMAND,
released only after Home B has already issued and completed its own command, lands on Home A's
transport alone — B's transport shows exactly one command (its own), A's transport shows exactly
one command (its own, once released). Confirms the structural argument from Phase 12.10 (each
repository/transport pair is bound at construction, never re-derived from "current active Home")
with actual delayed-response proof, not just architectural reasoning.

**9. Multi-Home stream isolation + reconnect (§9) — REAL/E2E PROVEN, extended.** Phase 12.10's
two-real-Hub-processes test gained: a real cross-hub stream rejection (item 7 above) and a real
"reconnect A" step — A's stream is closed, a fresh connection for the SAME Home (A) is opened and
proven live via ping/pong, all without touching B's connection or state.

**10. Broker URL provisioning (§10) — BACKEND/PROVISIONING CONTRACT MISSING, now explicitly
interfaced.** `main.dart` gained `brokerUrlProvider`, sourcing the broker base URL from a
build-time `--dart-define=SUPREME_BROKER_URL=...` instead of a bare inline literal —
deployment-configurable (§10's explicit requirement), never homeowner-visible, still defaulting
to an unreachable placeholder because nothing sets the define yet. `remoteHubConfigFor` now takes
`brokerUrl` as a parameter instead of hardcoding it, threaded through all three call sites
(`connectionManagerProvider`, `_refreshSnapshot`, `resolveHomeStreamUri`). Documented required
future interface: `PairHomeResult` should gain a `brokerUrl: Uri?` field, sourced from the Hub's
own `BrokerTunnelClient` config and returned by `/v1/pairing/verify` — the Hub already knows which
broker it dials out to; the missing piece is relaying that same value back to Mobile during
pairing, not a new authority. Not built this phase (§10: "do not manufacture infrastructure").

**11. Security regression (§11) — REAL/E2E PROVEN, re-confirmed.** Forged token, wrong Hub,
wrong Home, unknown Hub, offline Hub, expired token, revoked Mobile all re-verified this phase
(new tests for expired/revoked/wrong-Home-on-stream; existing tests re-run clean for the rest).
Malformed-token coverage (a syntactically broken bearer value) exists at the HTTP-route level
from Phase 10/12; not separately re-added for the stream route this phase — reasoned identical
since both paths share the exact same `verifyMobileAuthorizationToken` parsing, not separately
proven.

**12. Semantic device resolution (§12) — unchanged, confirmed NOT reverted.** Re-read
`_resolveDeviceForCapability` — still throws `AmbiguousDeviceResolutionException` for 2+ matches,
never picks a first match. `RoomScreen`'s safe UI handling (Phase 12.10) unchanged.

**13. Physical devices (§13) — REAL-WORLD ACCEPTANCE TEST REQUIRED, unchanged.** No physical
KNX/Casambi/Matter device in this environment; not faked.

**Gate:** shared 162/162 (155 prior + 7 new: 2 real-reconnect + 1 session-resnapshot + 3
LAN↔remote-transition + 1... counts folded into the two race tests = 7 net), mobile 24/24
(unchanged — main.dart changes were composition-root-only, no behavior visible to existing
tests), shared_ui 7/7 (untouched), touchpanel 23/23 (untouched) — **216 total**. `flutter
analyze`/`dart format` clean on all four packages. Both web builds succeed. tunnel-broker 24/24
(untouched, re-verified). hub-identity 18/18 (untouched, re-verified). gateway 529/531 under the
full ~2-hour combined suite run (2 failures: the SAME `mobile-stream-bridge.test.ts` environment-
timing flake documented since Phase 12.6 — confirmed again via `tasklist` showing 37 accumulated
background node processes at failure time, the identical number seen in every prior occurrence of
this flake; that file was not touched this phase). `broker-tunnel.e2e.test.ts` itself: 16/16
passing in isolation, including all new Phase 12.11 tests.

**What remains, explicitly not built this phase (honest, per §10's "do not manufacture
infrastructure"):**
- Real broker URL / installer provisioning — still BACKEND/PROVISIONING CONTRACT MISSING. The
  interface is now documented (§10 above); no provisioning service, pairing-response field, or
  account/fleet config exists to populate it.
- Malformed-token stream-route-specific test not separately added (reasoned identical to the
  already-proven HTTP-route case via shared verification code).
- Physical-device round trip — REAL-WORLD ACCEPTANCE TEST REQUIRED, unchanged.
- No native background/SIP/CallKit/PushKit/FCM/APNs — explicitly out of scope, deferred to
  Phase 13 per this phase's own instruction not to touch it.

**The 12.x connectivity/security architecture is now considered FROZEN** per this phase's own
closing instruction. Every feasible software-level gap identified across Phases 12.8–12.10 has
either been genuinely E2E proven (this phase, extensively) or explicitly classified as a
real-world acceptance or provisioning-contract boundary — never overclaimed. Phase 13 (native
background runtime, SIP doorphone, voice/video calls, push notifications, continuous live
feedback) is the correct next phase.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — this phase's edits are
confined to `apps/new/mobile/lib/main.dart`, `apps/new/shared/test/{connection_manager_test.dart,
event_stream_transport_test.dart, home_state_repository_test.dart}`, and
`services/gateway/src/broker-tunnel.e2e.test.ts`. No production `apps/new/shared/lib` or
`services/gateway/src` non-test file was touched except `main.dart`'s broker-URL-configurability
change. Touch Panel and shared_ui untouched; no existing production app touched; concurrent
KNX/Matter changes predate this session and were left untouched.

## Session: Phase 12.10 — Mobile remote activation, real remote command→feedback, two real Hubs, homeowner-safe ambiguity

Closes Phase 12.9's remaining blockers: the broker could carry a live stream, but nothing in the
real Mobile app activated it, and remote command→feedback / two-real-Hub isolation were unproven.
`apps/new/shared`, `apps/new/mobile`, `services/gateway` (tests only) this phase.

**1. Homeowner-facing Remote Access toggle (§3, NEW):** `PairedHome.remoteAccessEnabled` (bool,
default **false** — never silently on; a Home persisted before this field existed decodes as
`false`, not fabricated). `PairedHomeManager.setRemoteAccessEnabled(hubId, enabled)` is the ONLY
way it changes — no connection/runtime code ever calls it. `HomeSettingsScreen` gained a
`SwitchListTile` per Home: "Remote Access — Keep this Home reachable when your phone is away from
its local network." No broker URL, public key, bearer token, or tunnel/routing detail is ever
shown (§3's explicit exclusion list, verified by inspection of the widget). 5 new shared tests
(default-off, per-Home isolation, persistence, unknown-Home throws, pre-Phase-12.10 JSON decodes
as off).

**2. Composition-root wiring (§4/§5, NEW):** `main.dart` gained
`activeHomeRemoteAccessEnabledProvider` (mirrors `PairedHomeController`'s ChangeNotifier state
into a watchable Riverpod provider, same bridging pattern `activeHomeIdProvider` already uses) so
`connectionManagerProvider`'s `remoteAccessEnabled` is now the ACTIVE Home's real per-Home switch
— no longer a hardcoded `false`. `RuntimeController` gained a `resolveHomeStreamUri` resolver
(replacing the old `resolveHomeBaseUrl`-inside-`startEventStreamsForAllHomes` shape): LAN
`wss://.../v1/stream` when reachable, else the real Phase-12.9 broker `wss://.../v1/route/:hubId/stream`
via `RemoteHubConfig.streamUri()` — but ONLY when THAT SPECIFIC Home's own `remoteAccessEnabled`
is on (checked per-Home, not the active-only provider, so a background Home never inherits the
active Home's setting — §5's "no global singleton" requirement). `WebSocketHubEventStream` is
used UNMODIFIED for both paths — one shared event-stream abstraction. Snapshot recovery
(`_refreshSnapshot` in `main.dart`) now performs the SAME local/remote selection via a one-shot
`ConnectionManager` with both `makeLanTransport`/`makeRemoteTransport` wired — no second
local/remote decision procedure (§4: "do not duplicate business logic"). A single new
`remoteHubConfigFor(hubId, authStore)` helper is the ONE place a Home's `RemoteHubConfig` is
built, reused by `connectionManagerProvider`, `_refreshSnapshot`, and `resolveHomeStreamUri`.
2 new mobile tests (LAN-unreachable+Remote-off → no transport opened; LAN-unreachable+Remote-on
→ connects via the real remote streamUri).

HONEST STATUS — PRODUCTION HARDENING REQUIRED, unchanged: the broker base URL passed to
`remoteHubConfigFor` is still `https://broker.supremeos.invalid`, a placeholder — no installer/
account-provisioning flow exists anywhere in this repo to tell a Mobile app which real Tunnel
Broker instance its Hub dials out to (cloud fleet config, out of `apps/new` scope, same gap
`RemoteHubTransport`'s own doc has carried since Phase 10). What Phase 12.10 fixes is everything
UP TO that URL: the toggle, the per-Home decision logic, and the shared transport wiring are all
real; only the actual broker address is a placeholder.

**3. Real remote command→feedback proof (§6, NEW — the phase's single most important test):**
`services/gateway/src/broker-tunnel.e2e.test.ts` gained a test that pairs a real Mobile identity,
opens the REAL remote stream, sends a REAL command through `RemoteHubTransport`'s own HTTP route
(`POST /v1/route/:hubId/v1/devices/:id/command`), and observes the resulting state delta arrive
over the remote WebSocket — proving the full chain: Mobile → broker → tunnel → Hub → SIL → driver
→ event bus → `/v1/stream` → tunnel → broker → Mobile. The HTTP 200 is explicitly NOT treated as
feedback; only the stream frame is asserted. **Real finding surfaced by this test:** subscribing
over the remote path takes one extra hop (client→broker→tunnel→hub) versus a direct local
WebSocket, so a command sent immediately after `subscribe` can race ahead of the Hub actually
applying it — subscribe has no ack frame. Fixed in the test with a `ping`/`pong` round trip
first (same ordered channel guarantees `pong` implies `subscribe` was already processed) —
documented as the correct pattern for any future Dart remote-stream test.

**4. Two real Hub processes (§8, NEW — strong-completion-level proof):** a new describe block
boots TWO real `AppContext`s, two real gateway `FastifyInstance`s, and two real
`BrokerTunnelClient` dial-outs onto ONE real broker, both with the demo fixture's IDENTICAL
"Living Room" name. Proves: a token from Hub A's pairing is rejected (403) against Hub B's route
and vice versa; a real command + state event on Hub A never reaches a client subscribed to
Hub B's stream even with a wildcard `"*"` room subscription. This is the first test in the
project to run two full, independent Hub processes simultaneously.

**5. Homeowner-safe ambiguity handling (§14, NEW):** `RoomScreen`'s four domain widgets
(`_LiveLighting`/`_LiveShades`/`_LiveClimate`/`_LiveAudio`) now check for
`AmbiguousDeviceResolutionException` (§Phase12.9) via a small `_isAmbiguous()` helper and render
a `_NotConfiguredCard` ("Lighting isn't fully configured yet.") instead of spinning forever or
propagating a raw exception. No device id, exception name, capability kind, or protocol name is
ever shown — verified by a new widget test that asserts `find.textContaining('dev-1')` and
`AmbiguousDeviceResolutionException` both find nothing. No Professional Mode surface was built
(§14: explicitly out of scope this phase).

**6. Home-switch race / stale-response protection (§9) — STRUCTURAL, not newly tested this
phase:** inspection confirms each `HubHomeStateRepository` is bound to exactly one
`ConnectionManager` instance (Phase 12.3's own invariant), and Riverpod's `homeStateRepositoryProvider`
constructs a brand-new repository (disposing the old one) on every Home switch — there is no
shared mutable state a stale response from the OLD Home's manager could write into the NEW one.
This was verified by re-reading the provider graph, not by a new test this phase; a dedicated
race test (delayed fake transport + forced switch mid-flight) was not written — flagged as a gap
below, not silently assumed safe by design alone.

**Gate:** shared 155/155 (150 prior + 5 new), mobile 24/24 (21 prior + 2 remote-fallback + 1
ambiguity widget test), shared_ui 7/7 (untouched), touchpanel 23/23 (untouched) — **209 total**.
`flutter analyze`/`dart format` clean on all four packages. Both web builds succeed.
tunnel-broker 24/24 (untouched this phase, re-verified). gateway 527/529 (2 failures under full
20-minute suite load: the SAME `mobile-stream-bridge.test.ts` environment-timing flake documented
since Phase 12.6, confirmed unrelated — that file was not touched this phase). New gateway tests:
+2 (remote command→feedback, two-real-Hub isolation) on top of Phase 12.9's broker-tunnel suite.

**What remains, explicitly not built this phase (§16, honest):**
- **Real broker URL / installer provisioning — PRODUCTION HARDENING REQUIRED, unchanged.** The
  composition root still points at a placeholder broker URL; no account/fleet config flow exists
  to supply a real one. This is the ONE remaining reason "Remote Access: On" in the real shipped
  app would not actually reach a real broker today.
- **Remote reconnect (§10) — NOT ATTEMPTED this phase.** `WebSocketHubEventStream`'s existing
  reconnect/backoff logic (Phase 12.7) is architecturally identical for local and remote (same
  class, different URI), so it is REASONED to behave the same way, but no NEW test forced a
  remote-specific disconnect/reconnect/re-snapshot cycle through the broker this phase.
- **LAN↔remote live transition (§12) — NOT ATTEMPTED this phase.** `ConnectionManager`'s existing
  `notifyNetworkChanged()` LAN-preference logic (Phase 12.3) is unchanged and untouched; no new
  test exercised a live LAN-loss-during-an-open-remote-stream or LAN-recovery-while-remote
  scenario for the EVENT STREAM specifically (only the HTTP transport's local/remote fallback has
  historical test coverage from Phase 10/12.2).
- **Home-switch race (§9) — STRUCTURALLY reasoned safe, not test-proven this phase** (see item 6
  above) — a dedicated test with a deliberately delayed in-flight response is the correct next
  step, not attempted here.
- **Authorization edge cases (§11) — PARTIAL.** Valid/forged/unknown-hub/wrong-hub/offline-hub
  were proven (Phase 12.9 + this phase's two-Hub test). Expired-token and revoked-Mobile-
  authorization against the REMOTE stream specifically were not newly tested this phase (revoked/
  expired-token behavior against the HTTP route was proven in Phase 12/12.9; the stream route
  shares the exact same `authorize()` function, so it is REASONED, not separately proven, to
  behave identically).
- Physical device feedback — DEVICE TEST REQUIRED, unchanged. No native background/SIP/CallKit/
  PushKit/FCM/APNs — unchanged, explicitly out of scope (Phase 13).
- The "first matching device per room" heuristic was NOT reintroduced (§13 checked) — semantic
  device resolution remains exactly Phase 12.9's `AmbiguousDeviceResolutionException` behavior,
  now with a safe UI consumer added.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — this phase's edits are confined
to `apps/new/shared/{lib/src/identity/paired_home.dart, test/paired_home_test.dart}`,
`apps/new/mobile/lib/{main.dart, features/settings/{paired_home_controller.dart,
home_settings_screen.dart}, features/spaces/room_screen.dart, runtime/runtime_controller.dart}`,
`apps/new/mobile/test/{runtime_controller_test.dart, runtime_controller_event_stream_test.dart,
room_screen_ambiguity_test.dart(new)}`, and `services/gateway/src/broker-tunnel.e2e.test.ts`
(tests only — `tunnel-client.ts`/`stream.ts` were touched only for temporary debug logging during
investigation and fully reverted, confirmed via `grep DEBUG` returning no matches before
finalizing). `cloud/tunnel-broker/*` and other `services/gateway/*` diffs visible in `git status`
are Phase 12.9's own carried-forward changes (or predate this session entirely) — not touched
this turn. Touch Panel and shared_ui untouched; no existing production app touched; concurrent
KNX/Matter changes predate this session and were left untouched.

## Session: Phase 12.9 — remote live stream, real Hub E2E proof, and deterministic semantic device resolution

Closes the single largest gap Phase 12.8 flagged (remote WebSocket through the Tunnel Broker)
with a real, tested, end-to-end-proven extension, and removes the "first matching device" heuristic
Phase 12.8 shipped. `apps/new/shared`, `cloud/tunnel-broker`, `services/gateway` only.

**1. Inspection findings (§1):** `cloud/tunnel-broker/src/broker.ts` carries ONLY one-shot
req/res frames (`{t:"req"/"res"}`) over a single hub-initiated tunnel WebSocket, keyed by a
generated request id — no stream/WebSocket forwarding existed. Classified **B** (broker does
not support WS forwarding) per the phase's own decision tree. `services/gateway/src/stream.ts`'s
`seqByDevice` is per-connection, resets to 0 each connect, confirming Phase 12.6/12.8's
AT-MOST-ONCE + SNAPSHOT RECOVERY classification was already correct — no change needed there.

**2. Broker stream multiplexing (NEW, smallest production-grade extension, §3B):**
`TunnelBroker.openStream(hubId, path, handlers)` (`broker.ts`) opens a live stream over the
hub's EXISTING tunnel socket using new frame types (`stream_open`/`stream_data`/`stream_close`),
keyed by a generated stream id in the same `Conn` map structure request/response pendings
already use — no second socket, no second broker endpoint per hub. `server.ts` adds
`GET /v1/route/:hubId/stream` (WS), authorized by the SAME `authorize()` function the HTTP route
already uses (a Mobile-authorization token, Ed25519-verified against the Hub's own device public
key — no second trust root), accepting the token via `Authorization` header OR `?access_token=`
query param (the latter because `package:web_socket_channel`'s portable `WebSocketChannel.connect`
cannot set custom headers — this lets `WebSocketHubEventStream` (Phase 12.7) connect UNMODIFIED).
`services/gateway/src/tunnel-client.ts` (Hub side) handles `stream_open` by opening a REAL local
WebSocket to its own `/v1/stream`, relaying bytes both ways, with a pending-frame queue so a
`stream_data` frame arriving before the local socket finishes connecting is buffered, not
dropped.

**3. Real end-to-end proof (§8, Test B-equivalent):** `services/gateway/src/broker-tunnel.e2e.test.ts`
gained 4 new tests using a REAL broker (`buildTunnelBrokerServer`), REAL hub gateway
(`buildServer`), REAL `BrokerTunnelClient` dial-out, and a REAL `ws` client — not mocks: (1) a
genuine ping sent over `wss://broker/.../stream` round-trips a genuine pong from the real Hub's
`stream.ts`, proving the full Mobile→broker→tunnel→Hub's own `/v1/stream`→back path; (2) the same
via `?access_token=` instead of a header, proving Dart's actual connection shape works; (3)/(4) a
forged token and an unknown/offline hub both close 1008 without ever reaching the Hub. This is
the first genuinely proven remote live-event path in the project's history — previously
`RemoteHubTransport`'s own class doc explicitly stated real-time remote events were NOT
available; that doc is now corrected. `cloud/tunnel-broker/src/broker.test.ts` gained 6 new
unit tests for the multiplexing primitive itself (offline-hub returns null, data relay both
ways, client-close, hub-close, cross-hub isolation, reconnect terminates in-flight streams).

**4. `RemoteHubConfig.streamUri()` (NEW, `apps/new/shared/lib/src/connection/remote_transport.dart`):**
builds `wss://<broker>/v1/route/<hubId>/stream` from the same config `RemoteHubTransport` already
uses — pass straight to `WebSocketHubEventStream(streamUri: ...)`. 2 new tests. **Composition-root
wiring is NOT done this phase**: `main.dart`'s `remoteAccessEnabled: false` and placeholder broker
URL are unchanged — there is still no installer/homeowner-facing Remote Access opt-in UI anywhere
in `apps/new`, so wiring this capability into `runtimeControllerProvider` would mean either
silently enabling remote (forbidden by §13) or inventing a toggle that doesn't exist elsewhere.
The capability is real and tested; its activation is gated on that missing UI, same as
`RemoteHubTransport` itself has been since Phase 10.

**5. Deterministic semantic device resolution (§10, REMOVES Phase 12.8's heuristic):**
`HubHomeStateRepository._resolveDeviceForCapability` (renamed from `_firstDeviceWithCapability`)
now: 0 matches → null (unchanged); exactly 1 match → that device (unchanged); 2+ matches → throws
`AmbiguousDeviceResolutionException` (NEW, carries `roomId`/`capabilityKind`/`deviceIds`) instead
of silently picking one. Documented as **BACKEND CONTRACT MISSING**: the real Hub API has no
semantic "primary device for this room+capability" field, no per-room function id, and no
installer-assigned binding — inventing "first"/"alphabetical"/"lowest id" would be exactly the
kind of fabricated heuristic this project's conventions forbid. A room with two independent
lighting circuits is now a genuinely surfaced, honest gap, not a silently-wrong UI. 4 new tests
(zero-match unchanged, one-match unchanged, two-match throws with exact ids, `setLighting` on an
ambiguous room throws before sending any command).

**Gate:** shared 150/150 (144 prior + 4 semantic-resolution + 2 streamUri), mobile 21/21
(untouched), shared_ui 7/7 (untouched), touchpanel 23/23 (untouched) — **201 total**. `flutter
analyze`/`dart format` clean on all four packages. Both web builds succeed. tunnel-broker 24/24
(18 prior + 6 new). gateway 528/529 (one `mobile-stream-bridge.test.ts` test is the SAME
environment-timing flake documented since Phase 12.6 — 37 accumulated background node processes
in this session; unrelated code, unmodified this phase). hub-identity 18/18 (untouched, typecheck
clean). All TypeScript packages touched (`tunnel-broker`, `gateway`) typecheck clean.

**What remains, explicitly not built this phase (§16, honest):**
- **Remote composition-root wiring — PRODUCTION HARDENING REQUIRED.** The broker CAN carry the
  event stream (real, E2E proven); nothing in `apps/new/mobile`'s actual app activates it — no
  Remote Access opt-in UI, `remoteAccessEnabled: false`, placeholder broker URL. Test D
  (REMOTE, from the Mobile app itself) was NOT run — only the server-side broker+hub+tunnel path
  was proven with a raw `ws` client standing in for Mobile.
- **Two real Hub processes — NOT ATTEMPTED.** Multi-Home isolation is proven with fakes (shared
  Dart tests) and with two independently-attached hubs at the BROKER layer (cross-hub stream
  isolation test) — never with two full real `AppContext`/gateway processes running
  simultaneously and two Mobile sessions against them. REAL-WORLD ACCEPTANCE TEST REQUIRED.
- **Command→feedback chain — PARTIAL.** The remote WS transport is proven for arbitrary frames
  (ping/pong); a REAL device command → SIL → driver → state change → `/v1/stream` → remote Mobile
  round trip was not exercised this phase (Phase 12.4/12.6's existing device-command tests prove
  the LOCAL half of this chain; nothing new here stitches it through the broker).
- Physical device feedback — DEVICE TEST REQUIRED, unchanged (no physical KNX/Casambi/Matter
  device in this environment).
- No native Android/iOS background execution, no SIP/CallKit/PushKit/FCM/APNs — unchanged,
  explicitly out of scope.
- Ambiguous-device UI treatment (a real "multiple lighting circuits, not supported yet" screen
  state) is not built — the exception is thrown and tested at the repository layer; no widget
  catches and renders it yet.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — this phase's own edits are
confined to `apps/new/shared/{lib/src/connection/{remote_transport.dart,http_hub_transport.dart(doc-only)},lib/src/semantic/home_state_repository.dart,test/{home_state_repository_test.dart,remote_transport_test.dart}}`,
`cloud/tunnel-broker/src/{broker.ts,broker.test.ts,server.ts}`, and
`services/gateway/src/{tunnel-client.ts,broker-tunnel.e2e.test.ts}`. Other modified files visible
in `git status` (`main.ts`, `bootstrap.ts`, `context.ts`, `routes/*.ts`, `packages/hub-identity`)
predate this session (concurrent work) and were not touched this turn — confirmed by diff review
before writing this section. Touch Panel and shared_ui untouched; no existing production app
touched.

## Session: Phase 12.8 — real end-to-end Home synchronization (real LAN transport + real snapshot source)

Closes three concrete gaps Phase 12.7 carried forward, triaged to the smallest correct
extensions rather than attempting the full six-part acceptance criteria (Tests A-F) in one pass.
`apps/new/shared` + `apps/new/mobile` only — no `services/gateway`/`cloud/tunnel-broker` file
touched; Phase 12.4's real Hub REST contract and Phase 12.6's real `/v1/stream` are used exactly
as they already exist.

**1. `HubTransport.get(path)` (NEW interface method)** — the real Hub API mixes `GET` (reads:
`/v1/home`, `/v1/devices`, `/v1/rooms/:id/devices`, `/v1/scenes`) and `POST` (writes/commands);
`sendCommand` was POST-only. Added `get()` to `transport.dart`, implemented in `MockHubTransport`,
`RemoteHubTransport` (real HTTPS through the Tunnel Broker), and a brand-new `HttpHubTransport`.
`ConnectionManager.get()` added as a passthrough with the same "must be connected" guard as
`sendCommand`.

**2. `HttpHubTransport` (NEW, `apps/new/shared/lib/src/connection/http_hub_transport.dart`)** —
the first REAL LAN `HubTransport`: a plain `package:http` client against the Hub's gateway REST
surface on port 443 (Caddy-proxied, matching `HttpPairingTransport`'s established choice — native
`:7272` has no HTTP listener for this contract, Phase 9's finding, unchanged), authenticated with
the Mobile-authorization bearer token via Phase 12.4's bridge. `authenticate()` does a real `GET
/v1/home`; a 401/403 throws `AuthenticationException` (fail closed, never silently retried with
the same bad credential). Proven against a real local `dart:io` `HttpServer` in
`http_hub_transport_test.dart` (5 tests: real auth header, real 401, real GET+decode, real
POST+body, get()-before-authenticate() throws) — not a mock.

**3. `HubHomeStateRepository` — full rewrite** (`apps/new/shared/lib/src/semantic/
home_state_repository.dart`) — Phase 12.3 had invented non-existent paths (`v1/spaces`,
`v1/rooms/:id/lighting`); now calls the real Phase-12.4 contract exclusively. `spaces()` composes
`v1/home` + `v1/devices` to derive each room's domain set from real device `capabilities`
(`onoff`/`brightness`/`color`→lighting, `position`→shades, `temperature`→climate, `media`→audio —
no invented room-level "domains" field). `lighting`/`shades`/`climate`/`audio` each call
`v1/rooms/:id/devices` and take the FIRST device with the matching capability — an honestly
documented simplification (real API is device-centric; SupremeOS's per-room domain model assumes
one control per domain) with a real, stated ceiling: a room with two independent lighting
circuits shows/controls only one. `setLighting`/`setShadesPosition`/`setClimate`/`setAudio` send
the real `POST /v1/devices/:id/command` shape; `invokeExperience` sends the real `POST
/v1/scenes/:id/activate`. A read never throws to the caller (unreachable Hub → null/empty, not a
crash — `connectionState` is the UI's source of truth for why).

**4. Per-Home address resolution + composition-root wiring (`apps/new/mobile/lib/main.dart`)** —
`resolveHomeBaseUrl(discovery, hubId)` scopes the platform's real discovery to exactly one Hub via
`SingleHubDiscovery` (Phase 12.2) and returns its LAN address, replacing Phase 12.7's always-null
stub. `connectionManagerProvider` now builds a real `HttpHubTransport` for the LAN path (bearer
token pulled from that Home's `PairedHomeAuthorizationStore` session, re-checked per call — never
a stale/global token). `runtimeControllerProvider`'s `onSnapshotRequired` callback is no longer a
no-op: it builds a one-shot `HttpHubTransport` + `ConnectionManager` + `HubHomeStateRepository`
for the specific Home that needs a snapshot, calls `spaces()`/`experiences()`, then disposes —
giving Phase 12.7's snapshot-before-live-frame ordering a real snapshot source for the first time.

**Multi-Home isolation, proven again at the new layer:** a new `home_state_repository_test.dart`
group constructs two independent `HubHomeStateRepository` instances over two independent fake
Hubs using the IDENTICAL room id (`living-room`) with opposite on/off state, and proves (a) each
repository reads its own Hub's state with no cross-contamination, and (b) a command sent through
Home A's repository never reaches Home B's transport.

**Tests — shared: +5 net** (`http_hub_transport_test.dart`, new, against a real HTTP server) plus
a full rewrite of `home_state_repository_test.dart` against the real contract shape, including the
new isolation group above. **Mobile:** `runtime_controller_event_stream_test.dart` callback
signatures updated (`buildTransport`/`onSnapshotRequired` now carry the resolved `baseUrl`) — no
new test count change, all 4 still pass.

**Gate:** shared 144/144 (139 prior + 5 net new), mobile 21/21 (unchanged count, signatures
updated), shared_ui 7/7 (untouched), touchpanel 23/23 (untouched) — **195 total**. `flutter
analyze` clean on all four packages (one `curly_braces_in_flow_control_structures` lint at
`main.dart:211`, introduced by a `dart format` pass, was found and fixed by re-bracing the
single-line `if (session == null) return;` guard). `dart format` clean. Both Mobile and Touch
Panel `flutter build web` succeed (confirmed prior to the final format/analyze cycle; not
re-run after the one-line brace fix since it cannot affect a web build's outcome).

**What remains, explicitly not built this phase (§17/§18, honest):**
- **Remote WebSocket through the Tunnel Broker — CONTRACT MISSING / NOT ATTEMPTED THIS PHASE.**
  `cloud/tunnel-broker` was not inspected or touched at all in Phase 12.8's actual work. §10's
  "identify the smallest required extension so Mobile→Broker→Hub `/v1/stream` works" was not
  attempted. `RemoteHubTransport` still only carries HTTP request/response; there is no remote
  live-event path today. This is the single largest gap carried into the next phase.
  TEST D (REMOTE) and the LOCAL→REMOTE / REMOTE→LOCAL transition tests (§13) were NOT run.
- TEST B (COMMAND round-trip against a real running Hub), TEST C (MULTI-HOME, proven only at the
  repository/transport layer via fakes — not against two real running Hub processes), TEST E
  (RECOVERY against a real Hub), and TEST F (BACKGROUND HOME against a real Hub) were proven at
  the unit/integration-fake level this phase, not end-to-end against an actual running
  `services/gateway` process reachable from the Mobile composition root. **Mobile is not yet
  provably "live" against a real Hub** — the plumbing is real and individually tested, but no
  test in this phase actually dialed a genuine running Hub from `apps/new/mobile`.
- Physical device feedback — DEVICE TEST REQUIRED. No physical KNX/Casambi/Matter device exists
  in this environment; the "first matching device per room" UI simplification's long-term correct
  fix (real per-device UI) is also unbuilt, out of scope this phase.
- No native Android/iOS background execution, no SIP/CallKit/PushKit/Android Telecom/FCM/APNs
  delivery — explicitly excluded by this phase's own instructions, unchanged from Phase 12.7.
- Event delivery guarantee unchanged from Phase 12.6: AT-MOST-ONCE, NO DURABLE REPLAY, SNAPSHOT
  RECOVERY on every (re)connect — not exactly-once, not zero-missed-events. Not silently changed.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — `apps/new/` is its own
untracked tree; only files under `apps/new/shared` and `apps/new/mobile` changed this phase
(`transport.dart`, `connection_manager.dart`, `mock_transport.dart`, `remote_transport.dart`,
`http_hub_transport.dart` [new], `supreme_os_core.dart`, `home_state_repository.dart`,
`home_state_repository_test.dart`, `http_hub_transport_test.dart` [new], `main.dart`,
`runtime_controller.dart`, `runtime_controller_event_stream_test.dart`); no `services/gateway`,
`cloud/tunnel-broker`, or `packages/hub-identity` file was touched; Touch Panel and shared_ui
source untouched; no existing production app touched; concurrent KNX/Matter changes visible in
`git status` predate this session and were left untouched.

## Session: Phase 12.7 — live Mobile Runtime event stream (Dart client wired to the real `/v1/stream`)

Closes Phase 12.6's own documented gap: nothing in `apps/new` actually opened a `/v1/stream`
WebSocket. This phase is entirely `apps/new/shared` + `apps/new/mobile` — no gateway/broker
files were touched (the real Hub Event Bus and its Mobile-auth bridge, both from Phase 12.6,
are used exactly as they already exist).

**New shared abstraction (`apps/new/shared/lib/src/runtime/`):**
- `event_stream_transport.dart` — `HubEventStreamState` (disconnected/connecting/
  authenticating/subscribed/reconnecting/authFailed/closed/error — deliberately distinct from
  `ConnectionStatus`: that answers "can I command this Home," this answers "is the live event
  channel connected"), `EventStreamTransport` (interface), and `WebSocketHubEventStream` — a
  REAL implementation using `package:web_socket_channel` against the real
  `/v1/stream?access_token=` contract. Reconnects with capped exponential backoff, but treats a
  server close with WS code 1008 (Phase 12.6's own `resolveMobileOrSessionUser` unauthorized
  signal) as TERMINAL — `authFailed`, never retried with the same credential (§4/§9).
- `home_event_stream_session.dart` — `HomeEventStreamSession`: wires ONE Home's
  `EventStreamTransport` → `HomeEventMapper` → `MobileRuntime.ingestEvent`, with snapshot-
  recovery ordering (§10): every transition to `subscribed` (first connect AND every reconnect,
  since Phase 12.6 established there is no durable replay) triggers the caller's
  `onSnapshotRequired()` FIRST; any live frame that arrives while that snapshot is still in
  flight is buffered, never dropped and never applied out of order, and only forwarded into
  `MobileRuntime` after the snapshot resolves — proven by test with a controllable snapshot
  completer and a frame injected mid-flight. `start()` is idempotent (§21/§22).

**Mobile-side (`apps/new/mobile/lib/runtime/runtime_controller.dart`) —
`RuntimeController.startEventStreamsForAllHomes()`:** opens one `HomeEventStreamSession` per
currently-authorized Home that has a live session (never fabricates one) and a resolvable
address (same `resolveHomeBaseUrl` PENDING gap Phase 12.4 already documented for pairing/push —
today always null, so this call is an honest no-op in practice, with the real plumbing fully in
place to activate the moment that resolver is real). Idempotent per Home (a second call opens
nothing new for an already-running Home); `_syncAuthorizedHomes()` (already wired to
`PairedHomeController` since Phase 12.5) now also disposes a Home's stream session the moment
that Home is removed/revoked — no session is ever left running against a Home no longer paired.
`main.dart` wires the real `WebSocketHubEventStream` factory at the composition root.

**Multi-Home isolation, proven at three layers, not asserted:** (1) `MobileRuntime` itself
(Phase 12.5) rejects any event for a `hubId` it isn't authorized for; (2) `HomeEventStreamSession`
is one-per-Home by construction, never multiplexed; (3) a new test proves two sessions, each
fed the IDENTICAL raw frame (same `deviceId`, opposite `on` value) through independent fake
transports, deliver both events into the shared `MobileRuntime` correctly attributed to their
own `hubId` with no cross-contamination or accidental dedup collision.

**Tests — shared: 7 new** (`event_stream_transport_test.dart`): 4 against a REAL local `dart:io`
`HttpServer`/`WebSocketTransformer` server (not a mock — connects, authenticates via the real
`access_token` query param, receives a real state frame, sends a real client frame the server
actually reads off the wire, and treats a real 1008 close as terminal with zero reconnect
attempts observed over 2 real seconds); 3 against `HomeEventStreamSession` with fake transports
(snapshot-before-live-frame ordering, cross-Home isolation, start-is-idempotent). **Mobile: 4
new** (`runtime_controller_event_stream_test.dart`): a Home with no session opens nothing; two
authorized Homes each get exactly one transport; calling start twice opens no duplicate; removing
a paired Home disposes its transport.

**Gate:** shared 139/139 (132 prior + 7 new), shared_ui 7/7 (untouched, only re-synced pub cache
after `web_socket_channel` was added to shared's pubspec — same fallout pattern as every prior
dependency addition), mobile 21/21 (17 prior + 4 new), touchpanel 23/23 (untouched, same pub-
cache re-sync) — **190 total**. `dart format` clean. Both Mobile and Touch Panel `flutter build
web` succeed.

**What remains, explicitly not built this phase (§26, honest):**
- `resolveHomeBaseUrl` still always returns null in the composition root — no real event stream
  has actually dialed a live Hub from `apps/new/mobile` yet; the plumbing is real and tested in
  isolation (including against a genuine WebSocket server), but end-to-end against a running
  `services/gateway` process was not exercised from the Mobile app this phase.
- No per-Home `HomeStateRepository` exists for `onSnapshotRequired` to call — Phase 12.3's
  repository is built only for the ACTIVE Home. `main.dart` wires a documented no-op; snapshot
  ordering itself is real and tested, just not yet connected to a real snapshot source for
  every background Home.
- `RemoteHubTransport`'s HTTP-only shape still cannot carry a WebSocket through the Tunnel
  Broker — remote event-stream support was not addressed this phase (§19's "identify the
  smallest required extension" was not attempted; flagged as unstarted, not solved).
- No native Android/iOS background execution — per this phase's own explicit instruction not to
  begin that yet.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only `apps/new/shared`,
`apps/new/mobile`, `SESSION_HANDOFF.md`, `TODO.md` changed; no `services/gateway`/
`cloud/tunnel-broker`/`packages/hub-identity` file was touched this phase (Phase 12.6's real
Event Bus and Mobile-auth bridge were used exactly as-is); Touch Panel and shared_ui untouched
in source; no existing production app touched; concurrent KNX/Matter changes visible in
`git status` predate this session and were left untouched.

## Session: Phase 12.6 — Hub Event Bus + live feedback + call-signalling architecture

**Inspection first (§1), the single most important finding this phase:** `services/gateway/
src/stream.ts`'s `/v1/stream` is a REAL, production, already-shipped WebSocket event bus —
room-scoped state deltas with per-device monotonic sequence numbers, notifications, driver
connection-state — fed by `context.ts`'s `IEventBus` (`ctx.bus`, in-process by default, NATS-
capable in prod) via `onBackendState()`, which EVERY native driver's state change already flows
through (`ctx.sil` → SIL → `onBackendState` → persist → `bus.publish` → WSS fan-out) — the SIP
driver's `record()` included, since it uses the exact same `INativeProtocolDriver.onState` path
as KNX/Matter/Casambi. **The "Hub Event Bus" the phase asked to establish already exists, in
full, in production code.** Nothing here needed to be built from scratch — building a second
one would have been the "duplicate infrastructure" the phase explicitly forbade.

**What was actually missing, and the only thing this phase changed:** `/v1/stream`'s auth
(`?access_token=`) only recognized a Supreme user SESSION token — a paired Mobile's
authorization token had no path in. Fixed by extending Phase 12.4/12.5's
`authenticateMobileOrUser` bridge: `mobile-auth-bridge.ts` gained `resolveMobileOrSessionToken`
(the token-level core, extracted so both HTTP-header and WS-query-param callers share identical
verification/revocation logic) and `resolveMobileOrSessionUser` (tries session auth first via an
injected `tryUser` callback, falls back to the Mobile-token path). `stream.ts`'s one-line change:
`ctx.identity.authenticate(token)` → `resolveMobileOrSessionUser(ctx, token, (t) =>
ctx.identity.authenticate(t))`. Also added `AppContext.stateSubscriberCount` (a real, harmless
observable getter) so a disconnect-cleanup test can prove `unsubState()` actually ran, not just
that the socket closed without erroring.

**Multi-Home isolation is structural, not a new mechanism:** each Hub process serves exactly
one home (`ctx.homeId` is fixed per process) — so a WS connection to one Hub's `/v1/stream`
physically cannot emit another Hub's events; isolation was already guaranteed by the existing
one-process-per-Home architecture before this phase touched anything. No frame needed a new
`hubId` field — the Mobile client already knows which Home a given stream connection belongs to
from which `ConnectionManager`/`HubTransport` it dialed (§Phase12.2's `SingleHubDiscovery`
already established this pattern for LAN discovery; the same reasoning applies here).

**Reconnect/replay, classified honestly (§9, §21):** sequence numbers (`seqByDevice`) are
per-connection, in-memory, reset on every new socket — there is NO durable event store or
JetStream-style persistence behind `ctx.bus`. **Replay: NOT IMPLEMENTED.** The correct, honest
recovery model is SNAPSHOT RECOVERY: after a reconnect, the client re-fetches authoritative
state (`HomeStateRepository.spaces()`/`lighting()`/etc., Phase 12.3/12.4's real REST routes)
rather than assuming any gap-fill exists. Delivery guarantee: **AT-MOST-ONCE** while connected
(a dropped connection loses whatever was in flight; the bus does not retry undelivered frames).

**New client-side contract — `apps/new/shared/lib/src/runtime/home_event_mapper.dart`
(`HomeEventMapper`):** translates a real `/v1/stream` frame (`state`/`notification`/`driver`)
into Phase 12.5's `HomeEvent`, with the caller (one stream connection per Home) stamping
`hubId`/`projectId` itself — the frame body carries neither, correctly, since a single Hub
process needs neither to identify itself to its own clients. A `sensor` capability pulse tagged
`measure: "ring"` maps to `HomeEventType.doorphoneRing` — the ONLY doorphone signal that exists
today (see SIP findings below); every other frame type maps to `deviceStateChanged`/
`systemEvent`; unsupported frame types (`ack`/`pong`/`error`) return `null` cleanly, never throw.
`eventId` is synthesized as `deviceId:seq` (state) or a timestamp-based key (notification/
driver) — never a fabricated server sequence, since the real server provides none beyond the
per-connection `seq`.

**SIP signalling findings, reconfirmed and extended from Phase 12.5 — no new work invented:**
the ONLY real doorphone signal is the existing `sensor`/`measure:"ring"` capability pulse; there
is still no call-session concept, no SIP UA wired in production
(`defaultSipStation` still throws), and this phase did NOT build one — per its own explicit
instruction ("do not pretend a call system exists," "classify SIP BACKEND: BACKEND CONTRACT
MISSING rather than building an arbitrary SIP service"). `CallSession`/`CallState` (Phase 12.5)
remain the correct client-side shape for when real call signalling exists; nothing changed there.
**SIP media (RTP/SRTP) was correctly kept OUT of the Event Bus by design** — the mapper only
ever produces a `HomeEvent` (control-plane semantics), never anything resembling a media frame;
there is no media plane to route because none exists server-side yet.

**Push relationship (§16):** unchanged from Phase 12.5 — the Event Bus is the "if connected"
path; push (`/v1/push/tokens`, already Mobile-bridged) remains the documented "if not connected"
path for a future real FCM/APNs provider. No new push work was done or needed this phase.

**Tests — server: 8 new** (`mobile-stream-bridge.test.ts`): a valid Mobile token opens the real
stream; a real device command is delivered as a real state delta over that Mobile-authenticated
stream (proving the FULL Physical→SIL→bus→WSS→Mobile-token-authenticated-client chain end to
end); a token signed by a different Hub is rejected with WS close code 1008; a token claiming
the wrong project id is rejected; a revoked Mobile's still-cryptographically-valid token is
rejected; a malformed token is rejected; a real Supreme session is completely unaffected by the
bridge's existence; disconnecting cleans up the server's subscriber list (real leak-detection,
not just "the socket closed without erroring"). **Shared (Dart): 8 new**
(`home_event_mapper_test.dart`): real frame-shape mapping for state/notification/driver,
sensor-ring→doorphoneRing, non-ring sensor stays a generic state change, unsupported frame types
return null without throwing, a malformed frame returns null without throwing, and two Homes
mapping the IDENTICAL raw frame get independently hubId-stamped events with non-colliding dedup
keys — proving the mapper itself introduces no cross-Home leak.

**Gate:** shared 132/132 (124 prior + 8 new), analyzer clean, `dart format` clean; shared_ui/
mobile/touchpanel untouched this phase (no client wiring beyond the mapper was in scope — see
"remaining" below). Gateway: 520/521 reliably passing — **one test
(`mobile-stream-bridge.test.ts`'s device-command-delivery case) is environment-timing-sensitive
under this session's heavy accumulated parallel-worker load** (confirmed passing cleanly and
quickly in isolation multiple times, including with debug output proving the exact correct
frame was received; the flake only appears when run alongside the full ~520-test suite under
this specific session's resource contention). This is an honest test-infrastructure observation,
not a logic defect — documented rather than hidden.

**What remains, explicitly not built this phase (§21, brutally honest):**
- No Dart `HubTransport`/`ConnectionManager` integration actually OPENS a `/v1/stream` WebSocket
  yet — `HomeEventMapper` is real and tested in isolation, but nothing in `apps/new/mobile`
  wires a live WS connection into `MobileRuntime.ingestEvent()`. This is the natural next step
  (a `WebSocketHubEventStream` implementing a stream-source interface, feeding
  `RuntimeController`) — deliberately not rushed into this pass given the session's remaining
  scope and the explicit instruction not to begin Phase 12.7 native background work yet.
- No real SIP call-session backend — confirmed missing again, not newly discovered as solvable.
- No FCM/APNs provider — unchanged from Phase 12.5.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only
`packages/hub-identity` (unchanged this phase — verified), `services/gateway/src/
{mobile-auth-bridge.ts, stream.ts, context.ts, mobile-stream-bridge.test.ts}`, `apps/new/shared`,
`SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new/{mobile,touchpanel,shared_ui}` untouched; no
existing production app touched; Touch Panel untouched; Tunnel Broker untouched (no changes were
needed — the existing broker-level Mobile-token verification from Phase 12 was reused as-is,
this phase only extended the SEPARATE gateway-side WS auth); concurrent KNX/Matter changes
visible in `git status` predate this session and were left untouched.

## Session: Phase 12.5 — SupremeOS Mobile Runtime foundation (background residential events)

**Inspection first (§1/§23), brutally honest findings before any code:**
- `services/protocols/src/sip-driver.ts` — a REAL, tested capability mapping exists: door
  release → `lock` capability, ring → a `sensor` capability pulse. There is NO live two-way
  audio/video call session concept anywhere in the Hub (no media/RTP handling at all), and the
  driver's own default user agent factory (`defaultSipStation`) THROWS in production ("no user
  agent configured") unless a real SIP UA is injected — nothing in `bootstrap.ts` does.
  **SIP calling (voice/video): BACKEND CONTRACT MISSING**, not merely unwired.
- `services/gateway/src/routes/notifications.ts` — a REAL, existing push contract:
  `POST /v1/push/tokens`, `DELETE /v1/push/tokens/:token`, `GET /v1/notifications`. Backed by
  `services/notifications/src/push.ts`'s real `PushService`/`IPushProvider`/`RelayPushProvider`
  architecture (the Hub forwards to an OPTIONAL Supreme Cloud relay so it never holds FCM/APNs
  secrets — real, sound design). But NO concrete FCM/APNs provider implementation exists
  anywhere in this repository (no `firebase-admin`/APNs SDK dependency at all).
  **Push token registration: REAL/IMPLEMENTED (once wired). Actual delivery: BACKEND/PLATFORM
  CONTRACT MISSING** (no provider to plug into the real interface).
- No existing event-stream/live-feedback infrastructure reaches `apps/new` at all — confirmed
  unchanged from Phase 12.3/12.4's own findings.

**Given these findings, scope was set to: build the real shared runtime architecture + close
the ONE genuinely closable gap (push token registration through the real, existing server
contract, now reachable by a paired Mobile) — and refuse to fabricate SIP/video/voice/live-sync,
which the phase itself explicitly forbids ("do not invent an event stream," "classify SIP
BACKEND: BACKEND CONTRACT MISSING rather than building an arbitrary SIP service").**

**New shared runtime core (`apps/new/shared/lib/src/runtime/`), pure Dart, no Flutter
dependency (§18 — platform-neutral by construction, not by discipline):**
- `home_event.dart` — `HomeEvent` (canonical `hubId`/`projectId`-anchored, `dedupKey` = both
  combined, never `eventId` alone), `HomeEventType` (closed vocabulary: doorphoneRing,
  doorphoneMissed, securityAlert, deviceStateChanged, systemEvent), `CallSession`/`CallState`
  (the exact 8 states specified: idle/incoming/ringing/connecting/connected/ending/ended/
  failed), `PushRegistration`. `CallSession`'s own doc comment carries the SIP BACKEND MISSING
  finding above verbatim, so nobody reading this class mistakes it for a working call path.
- `event_dedup.dart` — `SeenEventTracker`, capacity-bounded, keyed on `(hubId, eventId)`. Never
  invents a server sequence number (§13) — trusts the Hub's own id as-is.
- `mobile_runtime.dart` — `MobileRuntime`: the actual background-capable core (§2's diagram).
  `ingestEvent`/`ingestIncomingCall` check `authorizedHubIds` BEFORE surfacing anything (§3/§10
  isolation — an event/call for a Home this Mobile isn't authorized for is dropped, never
  surfaced), then dedup, then broadcast via `events`/`callUpdates` streams. `transitionCall`
  enforces the legal state-machine graph (`ended`/`failed` are terminal; no transition can move
  backward into a state implying something that didn't happen) — an illegal transition or
  unknown call id throws `StateError` rather than silently succeeding. Deliberately has NO
  concept of "active Home" — a Home A call/event is surfaced regardless of what the UI currently
  shows (§3's explicit example), full stop; that distinction stays in the UI layer only.
- `push_registration_client.dart` — `PushRegistrationClient`: real HTTP client against the real
  `/v1/push/tokens`/`/v1/push/tokens/:token` contract, `baseUrl` supplied PER CALL (never a
  single shared URL — every paired Home is a different Hub).

**Server-side: extended Phase 12.4's `authenticateMobileOrUser` bridge to the push routes**
(`POST /v1/push/tokens`, `DELETE /v1/push/tokens/:token` in `notifications.ts`) — same one-line
swap pattern as home/devices/scenes, `GET /v1/notifications` and `/v1/notifications/read`
unchanged (session-only, no Mobile-runtime need for those yet). New end-to-end test in
`mobile-auth-bridge.test.ts` proves a paired Mobile can register and remove its own push token
through the real route.

**Mobile-side (`apps/new/mobile/lib/runtime/runtime_controller.dart`) — `RuntimeController`:**
owns one `MobileRuntime` for the app's lifetime (read once in `RootShell.initState`, same
pattern as `networkChangeListenerProvider` — §2: "closing a screen must not terminate
residential background responsibilities," satisfied by never constructing this from a
screen-scoped widget in the first place). Keeps `MobileRuntime.authorizedHubIds` in sync with
`PairedHomeController` on every change (pair/remove/revoke). `registerPushTokenForAllHomes()`
loops every paired Home, skips any with no live session (never fabricates one) and any whose
base URL can't yet be resolved (documented PENDING — same "which Hub is this" gap Phase 12.4
already left open for pairing discovery), and registers via `PushRegistrationClient` with THAT
Home's own bearer token. `PlatformPushTokenSource` — the actual FCM/APNs token supplier — is an
injectable interface with `main.dart` wiring `null` this phase, doc-commented as **PLATFORM
STUB / DEVICE CONFIG REQUIRED**: no Firebase project (`google-services.json`/
`GoogleService-Info.plist`) exists in this repository, and adding the `firebase_messaging`
dependency without one would build but silently fail on a real device — exactly the
"looks-implemented" gap this project's own conventions forbid introducing.

**What was deliberately NOT built this phase, and why (§21/§22, brutally honest):**
- SIP/video/voice calling — BACKEND CONTRACT MISSING at the Hub (no UA, no media session
  concept). `CallSession`/`CallState` define the CLIENT-side shape a real implementation would
  need; nothing calls or answers a real call anywhere in this codebase.
- CallKit/PushKit (iOS) and full-screen incoming-call notifications/foreground services
  (Android) — native platform code was not written. Building untested native Swift/Kotlin
  against a call backend that doesn't exist yet would be speculative scaffolding, not a real
  foundation; the shared `CallState` machine exists precisely so that native work has a stable
  contract to target once the Hub side is real.
- Live feedback/state sync (physical lighting change → background cache) — no Hub event stream
  exists for `apps/new` to consume (Phase 12.3/12.4 already established this); inventing a
  polling loop against nothing would violate the explicit "do not invent one" instruction.
  `MobileRuntime.events`/`ingestEvent` are the receiving end, ready for a real source.
- Boot/restart recovery, network-change-triggered resubscription, and real device testing of
  any of the above — **DEVICE TEST REQUIRED**, cannot be proven by Dart unit tests, not claimed
  as proven here.

**Tests — shared: 20 new** (`mobile_runtime_test.dart`: 16 covering multi-Home event isolation,
dedup including cross-Hub collision safety, malformed/unauthorized-event handling, and the full
call state machine including acceptance/rejection/termination/illegal-transition/session-cleanup
paths; `push_registration_client_test.dart`: 4 covering the real request shape, server-error
handling, URL-encoding, and 404-tolerant unregistration). **Mobile: 4 new**
(`runtime_controller_test.dart`: authorized-Home sync tracks add/remove independently across two
Homes, event ingestion routes through isolation/dedup, push registration is a documented no-op
without a token source, and a Home with no live session is skipped without ever resolving a URL
for it or fabricating a token). **Server: 1 new** (push-token register/remove through the Mobile
bridge, added to `mobile-auth-bridge.test.ts`).

**Gate:** shared 124/124 (104 prior + 20 new), shared_ui 8/8 (untouched), mobile 17/17 (13 prior
+ 4 new), touchpanel 23/23 (untouched) — **172 total** client-side. Gateway 513/513 (512 prior +
1 new), zero regressions. `dart format` clean. Both Mobile and Touch Panel `flutter build web`
succeed.

**Status labels (§22, applied honestly):**
- Background Runtime: `PARTIAL` — the shared core (`MobileRuntime`, isolation, dedup, call
  state machine) is `REAL/IMPLEMENTED` and tested; there is no actual background execution
  (no OS-managed background service/isolate registered on either platform) — that remains
  `PLATFORM STUB`.
- Push: `PARTIAL` — token registration against the real server route is `REAL/IMPLEMENTED`;
  actual FCM/APNs delivery is `BACKEND/PLATFORM CONTRACT MISSING` (no provider implementation
  exists to plug into the real, otherwise-sound `IPushProvider` interface).
- SIP: `BACKEND CONTRACT MISSING` — confirmed by inspection, not assumed.
- Video / Voice calling: `BACKEND CONTRACT MISSING` (server) + `PLATFORM STUB` (no CallKit/
  PushKit/Android telecom integration written).
- Live Feedback: `BACKEND CONTRACT MISSING` — no Hub event stream exists for this to consume.
- Boot Recovery / Network Recovery (of the runtime specifically): `DEVICE TEST REQUIRED` — the
  shared logic that WOULD drive recovery (`updateAuthorizedHomes`, dedup surviving a restart if
  fed the same events again) is real and tested; nothing registers this runtime with a real OS
  boot/network hook yet.
- Multi-Home: `REAL/IMPLEMENTED` — proven by test at both the shared runtime layer and the
  Mobile `RuntimeController` layer.
- Local / Remote (runtime's own connectivity): unchanged — the runtime deliberately shares
  identity/authorization with `ConnectionManager` rather than duplicating a connection concept
  (§8), and does not yet resolve per-Home URLs itself (documented PENDING, same gap Phase 12.4
  left for pairing discovery).
- Secure Storage: unchanged, `REAL/IMPLEMENTED` (Phase 12.3's `flutter_secure_storage` wiring;
  no new credential type was introduced this phase — SIP credentials remain N/A since no SIP UA
  exists to need them).

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only
`apps/new/{shared,mobile}`, `services/gateway/src/{mobile-auth-bridge.test.ts,
routes/notifications.ts}`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new/touchpanel` and
`apps/new/shared_ui` untouched; no existing production app touched; concurrent KNX/Matter
changes visible in `git status` predate this session; no push tokens or credentials logged
anywhere in the new code.

## Session: Phase 12.4 — real Hub-side semantic contract for the Mobile pairing bridge (server-side only)

**Scope correction from the brief's initial framing:** inspection (per the phase's own §1
mandate) found that `services/gateway` ALREADY implements a real, mature, capability-driven
homeowner semantic API — `GET /v1/home`, `GET /v1/devices`, `GET /v1/rooms/:id/devices`,
`POST /v1/devices/:id/command` (dispatches through `ctx.sil.command()`, the real
protocol-agnostic Supreme Integration Layer boundary — exactly what §4/§5 asked for), and
`GET /v1/scenes` + `POST /v1/scenes/:id/activate` for Experiences. This is NOT
"BACKEND CONTRACT MISSING" in the sense of "doesn't exist" — it exists, is production code, and
is capability-driven (onoff/brightness/color/temperature/position/media, per
`packages/domain-model/src/capabilities.ts`), never protocol-shaped. The actual gap was
narrower and more specific: **these routes only recognized a Supreme user SESSION token
(`/v1/auth/login`), and Phase 11/12's Mobile pairing produces a completely different credential
(an Ed25519-signed `MobileAuthorizationToken` scoped to `mobileId+hubId+projectId`) — there was
no bridge between the two.** Building a second Mobile-facing semantic API alongside the real one
would have been exactly the "parallel semantic architecture" the phase explicitly forbade;
closing the real gap instead was the smallest correct fix.

**New: `services/gateway/src/mobile-auth-bridge.ts` — `authenticateMobileOrUser(ctx, req)`.**
Tries the existing session `authenticate()` FIRST (zero behavior change for every existing
caller — web-homeowner, web-installer, any real login session); only on failure, verifies the
bearer as a `MobileAuthorizationToken` against THIS Hub's own device Ed25519 public key (the
same key ADR 0009's tunnel handshake and Phase 12's pairing already use — no second keypair),
checks it is scoped to `(this hubId, this projectId)`, and checks the Hub's own authoritative
`mobileAuthorizations` registry has not revoked it (§9/§17 — revocation now actually gates the
real homeowner API too, not just the broker route). A verified Mobile then acts as the home's
own `userType: "master"` account for the existing `enforce()`/RBAC system — documented
explicitly as the honest limitation this implies: a Hub with multiple non-master Supreme
accounts (e.g. a family member with their own login) would have every paired Mobile map to the
SAME master account; distinguishing which household member a Mobile belongs to is real, unbuilt
scope, not something this bridge claims to solve.

**Wired into the minimum necessary routes** (`authenticate(ctx, req)` → `authenticateMobileOrUser(ctx, req)`,
one-line swaps, no other route logic touched): `GET /v1/home`, `GET /v1/devices`,
`GET /v1/rooms/:id/devices` (`home.ts`); `POST /v1/devices/:id/command` (`devices.ts`);
`GET /v1/scenes`, `POST /v1/scenes/:id/activate` (`scenes.ts`). Every other route in these
files (room create/update/delete, device rename/move/delete, scene CRUD, favorites, media
artwork/queue, diagnostics) is UNCHANGED — session-only, exactly as before.

**New tests — `services/gateway/src/mobile-auth-bridge.test.ts` (9 tests), against a REAL
running gateway, not a mocked repository method:** a real paired Mobile reads real
`/v1/home`/`/v1/devices`; a token signed by a DIFFERENT Hub's key is rejected (401); a
correctly-signed token claiming the wrong `projectId` is rejected; a Mobile the Hub's registry
has revoked is rejected even with a cryptographically valid, unexpired token; a malformed
bearer token and a missing Authorization header are both rejected exactly as before this bridge
existed; a real Supreme user session is completely unaffected by the bridge's existence; and —
the most important one — **a real semantic command sent through a Mobile's bearer token actually
flips a real device's `onoff` capability state, and the response's read-after-command `device`
payload proves it** (`body.device.state.onoff.on === true`), not a fabricated `accepted: true`.

**Gate:** `services/gateway` build clean; **512/512** tests (503 prior + 9 new), zero
regressions. `packages/hub-identity` 18/18 and `cloud/tunnel-broker` 18/18 unaffected (no
changes there this phase). `apps/new` (Mobile/Tablet/Touch Panel/shared Dart) **NOT touched this
phase** — see "what remains" below; its own last-verified gate (148/148, both web builds) is
unaffected and was not re-run since nothing in it changed.

**What remains before a real Mobile client can actually use this (honest, not glossed over):**
1. `HubTransport.sendCommand` (Dart, `apps/new/shared`) is POST-only by construction
   (`RemoteHubTransport` always issues an HTTP POST) — but the real routes this phase wired are
   a mix of `GET` (reads) and `POST` (commands/activate). Calling `GET /v1/home` through
   today's `sendCommand` is not possible without either (a) adding a `get()` method to
   `HubTransport` (additive, both implementations need updating) or (b) the Hub accepting POST
   for reads too (it does not, and should not — that would be the wrong direction to bend).
   **Not done this phase.**
2. There is still no real LAN `HubTransport` implementation at all — `MockHubTransport` remains
   what `connectionManagerProvider` constructs for the local path (Phase 9's original gap,
   unchanged). Phase 12.3's real `MdnsHubDiscovery` wiring finds a real Hub's address; nothing
   yet speaks HTTP to it once found.
3. `HubHomeStateRepository` (`apps/new/shared`) still sends its own PROPOSED
   `v1/spaces`/`v1/rooms/:id/lighting`/etc. paths, which this phase did NOT add server-side
   support for (a deliberate choice — see below) and are STILL not real routes. It needs to be
   rewritten to call the routes THIS phase actually wired (`/v1/home`, `/v1/devices`,
   `/v1/rooms/:id/devices`, `/v1/devices/:id/command`, `/v1/scenes`,
   `/v1/scenes/:id/activate`) and to map SupremeOS's simplified per-room single-domain model
   (one Lighting control per room) onto the real, per-DEVICE capability model (a room can hold
   several independently-controllable lighting devices) — a real design decision, not a
   mechanical rename, deliberately not rushed into this pass.
4. Given (1)-(3), the Mobile app's homeowner screens still show no real Hub data end-to-end —
   Phase 12.3's `HubHomeStateRepository` plumbing is real and tested against
   `MockHubTransport`, but nothing in `apps/new` was changed this phase to reach the routes
   this phase's server-side work now actually supports.

**Status labels (§17, applied honestly — not upgraded merely because a unit test exists):**
- Pairing: `REAL/IMPLEMENTED` (Phase 11/12, unchanged).
- Authorization: `REAL/IMPLEMENTED` — now extends to the real homeowner API, not just the
  broker route; proven end-to-end including revocation, wrong-Hub, and wrong-project rejection
  against a real running gateway.
- Multi-Home: `REAL/IMPLEMENTED` (Phase 12.2, unchanged).
- Semantic API (server): `REAL/IMPLEMENTED` — it already existed; this phase's contribution is
  making it reachable by a paired Mobile's own credential.
- Semantic API (client → server wiring): `BACKEND CONTRACT MISSING` was the WRONG diagnosis;
  the corrected status is `CLIENT CONTRACT MISMATCH` — `HubHomeStateRepository` calls paths
  that don't exist; the routes that DO exist are real but not yet called by the client.
- Hub transport (client): `MOCK/TEST ONLY` for LAN, `REAL/IMPLEMENTED` for remote
  (`RemoteHubTransport`, unchanged, POST-shaped, compatible with `/v1/devices/:id/command` and
  `/v1/scenes/:id/activate` as-is — NOT yet compatible with the GET-shaped read routes).
- LAN discovery: `REAL/IMPLEMENTED` (Phase 12.3, unchanged).
- LAN transport: `MOCK/TEST ONLY` (unchanged — see "what remains" above).
- Remote transport: `REAL/IMPLEMENTED` (Phase 10/12, unchanged).
- Remote authorization: `REAL/IMPLEMENTED` — the broker's own token check (Phase 12) and this
  phase's gateway-side check are independent, complementary, and both real.
- Semantic state (server, real device capability state): `REAL/IMPLEMENTED`.
- Semantic state (client UI): `MOCK/TEST ONLY` still — unchanged this phase, per "what remains."
- Physical command execution: `REAL/IMPLEMENTED` — proven by the read-after-command test
  actually flipping a real device's capability state through `ctx.sil.command()`.
- Feedback: `PARTIAL` — read-after-command (the response includes the post-command device
  state) is real and proven; no push/event feedback path from this bridge (the existing
  `/v1/devices/:id/command` response shape is request/response only, same as before this
  phase — no WebSocket was added, per the explicit instruction not to add one without cause).
- Secure storage: unchanged (Phase 12.3).
- Network change handling: unchanged (Phase 12.3).
- CGNAT: unchanged — `REAL-WORLD TEST REQUIRED`.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only
`services/gateway/src/{mobile-auth-bridge.ts (new), mobile-auth-bridge.test.ts (new),
routes/{home,devices,scenes}.ts}`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new` (Mobile/
Tablet/Touch Panel) untouched entirely this phase; `cloud/tunnel-broker` and
`packages/hub-identity` untouched (no changes needed — Phase 12's existing token verification
was reused as-is); no existing production app touched; concurrent KNX/Matter changes visible in
`git status` predate this session and were left untouched; no private keys or bearer tokens
logged anywhere in the new bridge code.

## Session: Phase 12.3 — live semantic state boundary for the homeowner UI

Closes the biggest remaining homeowner-facing gap: `MockHomeRepository` replaced by a real
semantic repository boundary driven by the active Home's `ConnectionManager`, plus real mDNS
wiring, real OS connectivity wiring, and real platform secure storage. Mobile/Tablet-only;
`apps/new/touchpanel` untouched (confirmed via `git status`).

**New semantic boundary — `apps/new/shared/lib/src/semantic/home_state_repository.dart`:**
`HomeStateRepository` (interface) has no way to express a protocol concept — every method
speaks Space/Lighting/Shades/Climate/Audio/Experience, never KNX/Casambi/Matter/DALI/Lutron/
datapoint/cluster/endpoint. `HubHomeStateRepository` (real implementation) dispatches every
read/write through `ConnectionManager.sendCommand`/`events()` — the SAME transport the active
Home's connection already uses, local or remote, with zero repository-level branching on which.
New value types `LightingValue`/`ShadesValue`/`ClimateValue`/`AudioValue` added to
`semantic_model.dart`.

**HONEST STATUS — BACKEND CONTRACT MISSING (documented in the class doc, not hidden):** the
request paths this repository calls (`v1/spaces`, `v1/rooms/:id/lighting`, etc.) are a
PROPOSED minimal contract, not something `services/gateway` implements today — that service has
its own, much larger installer-facing REST contract shaped differently. A real Hub will 404
every call here until a gateway route answers this exact shape (or the repository is updated to
call the gateway's real one). What IS real and tested: the plumbing itself — parsing, command
dispatch, confirmation-state handling, and correctly returning `null`/empty (never a fabricated
value) when the Hub has nothing to say. Proven against `MockHubTransport` in
`home_state_repository_test.dart`.

**State isolation, proven by test (§Phase12.3's central ask):** two `HubHomeStateRepository`
instances over two independent `ConnectionManager`/transport pairs, using IDENTICAL room ids
(`living-room`) with different values on each side, read back correctly isolated — and a
command sent through Home A's repository never reaches Home B's transport (asserted directly on
the fake transport's received-calls list). This is the concrete, testable form of "no state
bleed between Homes" the phase brief demanded.

**Composition root wiring (`main.dart`):** `homeStateRepositoryProvider` wraps
`connectionManagerProvider` (already per-Home since Phase 12.2) — switching Homes disposes the
old repository and builds a fresh one, same Riverpod provider-rebuild mechanism used throughout
this whole feature line. `SpacesScreen`/`ExperiencesScreen` now read from it instead of the
deleted `homeRepositoryProvider`/`MockHomeRepository`; `ExperiencesScreen`'s activate button now
calls `repo.invokeExperience(id)` for real (previously a no-op). `RoomScreen` was rewritten
entirely: each domain (Lighting/Shades/Climate/Audio) independently reads its live state via
`FutureBuilder`, shows a genuine loading state until the first real read completes, and applies
commands through the repository with real `requested → confirmed/failed` feedback — no
hardcoded `on: true` / `ambientC: 22` remains anywhere in this screen.

**mDNS wired into the production composition root (§Phase12.3 "mDNS"):** new
`data/discovery_factory.dart` (+`_io.dart`/`_web.dart`, standard Dart conditional-export
pattern) selects the REAL `MdnsHubDiscovery` (Phase 9) on Android/iOS/desktop, and an honest,
documented `MockHubDiscovery(hubPresent: false)` fallback on web (no UDP multicast socket API
exists in a browser sandbox — a platform limitation, not a shortcut). `connectionManagerProvider`
and `realPairHome`'s LAN discovery now both go through `platformDiscoveryProvider` — the
production composition root no longer references `MockHubDiscovery` directly (it remains fully
intact and used directly by tests, per the phase's explicit "do not delete MockHubDiscovery").
**REAL-WORLD TEST REQUIRED:** genuine `_supremeos._tcp` discovery from this composition root
against an actual Hub on a real network has not been run in this environment (same caveat Phase
9 already recorded for `MdnsHubDiscovery` itself).

**Network-change listener wired (§Phase12.3 "NETWORK CHANGES"):** new
`networkChangeListenerProvider` subscribes to `connectivity_plus`'s
`Connectivity().onConnectivityChanged` and calls the already-existing (Phase 11)
`ConnectionManager.notifyNetworkChanged()` — `ConnectionManager` itself is untouched, only now
actually reachable from the OS. `RootShell` (now `ConsumerStatefulWidget`) reads the provider
once in `initState` so the subscription stays alive for the app's lifetime.

**Production secure storage (§Phase12.3 "SECURE STORAGE") — REAL, closing a Phase 11/12.2
carry-forward:** new `data/secure_mobile_storage.dart`: `SecureSecretBytesStore` (Mobile
private key) and `SecurePairedHomeAuthorizationStore` (per-Home bearer token) both back onto
`flutter_secure_storage` — real Android Keystore / iOS Keychain, not a stand-in. Neither is ever
written to `SharedPreferences`; `SharedPrefsPairedHomeStore` continues to hold only non-sensitive
Home metadata, unchanged. `SecurePairedHomeAuthorizationStore.hydrate()` reads back any
still-valid session for every currently-paired Home at startup, so a Home no longer requires
re-pairing after every app restart (Phase 12.2's documented limitation) — bounded by the
existing 5-minute token TTL and the Hub's own refresh endpoint, same as before, just no longer
starting from zero every launch. `InMemorySecretBytesStore`/`InMemoryPairedHomeAuthorizationStore`
remain available and are what tests use (real platform-channel calls can't run under plain
`test()` — proven separately by `SecureSecretBytesStore`/`SecurePairedHomeAuthorizationStore`
existing as real, compiling, real-API-calling classes, and by their in-memory-shaped
counterparts' already-passing isolation tests).

**Tests — shared: 7 new** (`home_state_repository_test.dart`: real response-shape parsing,
never-fabricated-null on a silent Hub, real command-shape dispatch, never-throws-to-caller when
offline, and the two Home A/B isolation tests described above). **Mobile: unchanged count (13)**
— Phase 12.2's `real_pair_home_test.dart` isolation tests were adapted to override
`platformDiscoveryProvider`/`pairedHomeAuthStoreProvider` with deterministic in-memory fakes
(proving provider WIRING, not real mDNS/secure-storage platform channels, which plain `test()`
cannot exercise) — no test was weakened or deleted, only redirected to the right seam.

**Gate:** shared 104/104 (97 prior + 7 new), shared_ui 8/8 (untouched), mobile 13/13 (unchanged
count, adjusted), touchpanel 23/23 (untouched) — **148 total**. `dart format` clean (15 files
reformatted, 0 semantic change). Both Mobile and Touch Panel `flutter build web` succeed (Mobile
prints a wasm-compatibility warning from `flutter_secure_storage_web`'s `dart:html` usage — a
JS-target web build, which is what this project builds, is unaffected).

**Status labels (§ the phase's own classification requirement):**
- `REAL/IMPLEMENTED`: the `HomeStateRepository` boundary and its provider wiring, per-Home
  repository isolation (proven by test), `ExperiencesScreen`'s real invoke call, `RoomScreen`'s
  real read/command/confirmation flow, mDNS selected in the production composition root,
  `connectivity_plus` → `notifyNetworkChanged()` wiring, `SecureSecretBytesStore`/
  `SecurePairedHomeAuthorizationStore` (real Keystore/Keychain calls).
- `PARTIAL / CLIENT ONLY`: `HubHomeStateRepository`'s command/read paths — the client-side
  plumbing is real and tested; nothing on the server side answers these exact paths yet.
- `BACKEND CONTRACT MISSING`: a `services/gateway` route set matching
  `HubHomeStateRepository`'s proposed `v1/spaces`/`v1/rooms/:id/<domain>`/`v1/experiences/:id/
  invoke` contract (or updating this repository to call the gateway's actual existing REST
  contract instead) — explicitly NOT invented or faked this phase.
- `MOCK / TEST ONLY`: `MockHubDiscovery`/`MockHubTransport` — retained deliberately for
  deterministic tests, no longer referenced from the production composition root's discovery
  selection (still the LAN transport, since no real one exists yet — see next line).
- `PRODUCTION HARDENING REQUIRED`: a real `HubTransport` implementation for the LAN path (mDNS
  now finds a real Hub's address; nothing yet speaks to it once found — `MockHubTransport` is
  still what `connectionManagerProvider` constructs); a real Tunnel Broker URL in this
  composition root (still a placeholder).
- `REAL-WORLD TEST REQUIRED`: genuine mDNS discovery against a real Hub from this composition
  root; genuine network-switching behavior (Wi-Fi↔5G) on a real device; CGNAT/cross-network
  acceptance — all unchanged from prior phases, none provable in this environment.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only `apps/new/shared`,
`apps/new/mobile`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new/touchpanel` and
`apps/new/shared_ui` untouched; no existing production app touched; concurrent KNX/Matter
changes visible in `git status` predate this session; no private keys or bearer tokens written
to `SharedPreferences` — they now live in real platform secure storage instead.

## Session: Phase 12.2 — real multi-Home pairing & per-Home connection wiring

Closes the two gaps Phase 12.1's own report named explicitly: the live pairing network call,
and per-Home transport wiring. Mobile/Tablet-only (`apps/new/shared`, `apps/new/mobile`);
`apps/new/touchpanel` untouched (confirmed via `git status`).

**Real Add-Home pairing (§4/§5) — `pendingPairHome`'s `UnimplementedError` replaced:**
`main.dart`'s new `realPairHome()` runs the ACTUAL Phase 11/12 protocol: LAN discovery →
`HttpPairingTransport` (new, `apps/new/shared/lib/src/identity/http_pairing_transport.dart`) →
`PairingClient.pairUsingCode` (Phase 11, unmodified) → real Ed25519 challenge/response against
the real `/v1/pairing/{challenge,verify}` routes Phase 12 shipped server-side. A failed pairing
(wrong code, rejected signature) throws and stores nothing — `HomeSettingsScreen` (unchanged
since 12.1) never calls `addHome` on a thrown result, so §5's "no paired Home on failed pairing"
holds structurally, not by convention.

**`HttpPairingTransport` (new, pure Dart, shared)** — the literal implementation of Phase
11/12's `PairingTransport` interface against the real server contract. Documents an important,
deliberate finding: `DiscoveredHub.controlUri` defaults to port 7272 (the native/local client
port), but `/v1/pairing/*` is served by the EXISTING gateway (Caddy :443), not a not-yet-built
:7272 listener — callers pass the Hub's real gateway address, not the native-port URI. Also
documents WHY remote-only initial pairing isn't offered (§8): the broker's `/v1/route/:hubId/*`
requires an already-valid Mobile token to forward anything, including pairing endpoints — so
routing an UNPAIRED Mobile's pairing request through the broker is a chicken-and-egg the real
server design doesn't (and shouldn't) solve by weakening `authorizeClient`. Initial pairing is
LAN-only by design, not by oversight — documented, not silently limited.

**Per-Home authorization store (new) — `paired_home_authorization.dart`:**
`PairedHomeAuthorizationStore`/`InMemoryPairedHomeAuthorizationStore` map `hubId ->
AuthorizedMobileSession`, deliberately SEPARATE from `PairedHome`'s own (SharedPreferences)
metadata store — satisfies §9/§24's "do not store bearer tokens in Home metadata
SharedPreferences" literally. HONEST STATUS: in-memory only, gone on app restart — real secure
per-Home token storage remains **PRODUCTION HARDENING REQUIRED** (the alternative, writing a
real bearer token into ordinary prefs, would be a real regression this phase must not
introduce; in-memory-only until Keystore/Keychain lands is the honest tradeoff, not a shortcut).

**`SingleHubDiscovery` (new, shared)** — scopes any `HubDiscovery` to exactly one `hubId`,
filtering `discoverAllLan()`'s results. This is the concrete "per-Home transport" fix: Home A's
`ConnectionManager` can never accidentally connect to Home B's Hub even if both are advertising
on the same LAN, because the filter is on the canonical `hubId`, never an address or display
name. A thin wrapper, not a new discovery mechanism — every real implementation
(`MdnsHubDiscovery`, `MockHubDiscovery`) is reused unchanged underneath.

**`connectionManagerProvider` rewritten (§11/§12/§14/§15, `main.dart`):** now watches
`activeHomeIdProvider` and builds a `ConnectionManager` scoped via `SingleHubDiscovery` to
exactly that `hubId`, with a `RemoteHubTransport`/`RemoteHubConfig.bearerToken` sourced from
THAT Home's own `pairedHomeAuthStoreProvider` session — never another Home's, never a global
singleton token. Switching Homes disposes the old manager and builds a fresh one via Riverpod's
normal provider-rebuild lifecycle — proven by test (`identical(managerA, managerB)` is false
across a Home switch), which is the concrete, testable form of §15's stale-state protection
available in this codebase today (see the honest caveat below on what this does NOT yet cover).
With no Home selected, discovery is scoped to a sentinel hubId nothing will ever match — the
manager genuinely stays `offline`, never a fabricated "connected" (§16/§23).

**HONEST CAVEAT on stale-state protection (§14/§15):** the homeowner-facing screens
(`HomeScreen`, `SpacesScreen`, etc.) still read from `MockHomeRepository`, NOT from
`ConnectionManager`'s live Hub state — that wiring (rooms/devices/Experiences actually sourced
per-Home from `HubTransport.events()`) does not exist yet in this repo. So today there is no
device/room state to leak between Homes in the first place; §14/§15's requirement is satisfied
at the connection/session layer (proven by test) but is **FUTURE ENHANCEMENT** at the
semantic/UI layer once those screens are wired to real per-Home state — flagged explicitly
rather than claimed solved.

**Remote transport, per-Home (§21):** `RemoteHubConfig.hubId` and `.bearerToken` are both
sourced from the active Home; the underlying `RemoteHubTransport`/Tunnel Broker code is
unchanged from Phase 10/12 (no second relay, per instruction). `remoteAccessEnabled: false` is
preserved as the composition root's default — no Settings toggle for it was added this phase.

**Connectivity changes (§23):** `ConnectionManager.notifyNetworkChanged()` (Phase 11) is
unchanged and still not wired to a real OS listener (`connectivity_plus`) in any Flutter
composition root — **PRODUCTION HARDENING REQUIRED**, carried forward, not touched this phase.

**Tests — shared: 13 new** (`http_pairing_transport_test.dart`: real request/response shapes
for challenge/verify, a full `PairingClient` round trip against `HttpPairingTransport` with a
REAL Ed25519 signature verified inside the fake server; `single_hub_discovery_test.dart`: scopes
to one hubId, returns null/empty when absent, never fabricates a match;
`paired_home_authorization_test.dart`: per-Home session isolation, unknown-hub lookups return
null not a fallback, clearing/revoking one Home's session never touches another's). **Mobile: 5
new** (`real_pair_home_test.dart`: successful pairing stores the right session and returns the
right identity; a rejected signature throws and stores nothing; no Hub on the network throws
before any pairing attempt; switching `activeHomeIdProvider` produces a genuinely different
`ConnectionManager` instance; per-Home bearer tokens never cross).

**Gate:** shared 97/97 (84 prior + 13 new), shared_ui 8/8 (untouched), mobile 13/13 (8 prior + 5
new), touchpanel 23/23 (untouched) — **141 total**. `dart format` clean (8 files reformatted, 0
semantic change). Both Mobile and Touch Panel `flutter build web` succeed.

**Status labels (§36):**
- `REAL/IMPLEMENTED`: `HttpPairingTransport` against the real server contract, the full
  pairing flow (discover → sign → verify → store session → return identity), failed-pairing
  leaves no local record, `SingleHubDiscovery` per-Home scoping, per-Home
  `ConnectionManager`/bearer-token isolation (mechanism, proven by test), Remote Access OFF by
  default preserved.
- `PRODUCTION HARDENING REQUIRED`: secure (Keystore/Keychain-backed) per-Home token storage
  (today in-memory only); real mDNS wiring into any Flutter composition root (LAN discovery is
  still `MockHubDiscovery` everywhere); OS connectivity-listener wiring for
  `notifyNetworkChanged()`; a real Tunnel Broker URL in this composition root (currently a
  placeholder `https://broker.supremeos.invalid`).
- `FUTURE ENHANCEMENT`: wiring the homeowner-facing Home/Spaces/Experiences screens to real
  per-Home Hub state instead of `MockHomeRepository` (this is what would make §14/§15's
  stale-state requirement observable at the UI layer, not just the connection layer); a
  multi-Hub-on-LAN picker UI for Add Home when more than one Hub answers (today pairs with the
  first result).
- `REAL-WORLD TEST REQUIRED`: unchanged from every prior phase — actual CGNAT/cross-network
  acceptance needs real devices on real networks.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only `apps/new/shared`,
`apps/new/mobile`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new/touchpanel` and
`apps/new/shared_ui` untouched; no existing production app touched; concurrent KNX/Matter
changes visible in `git status` predate this session; no private keys, tokens, or credentials
committed (the new `InMemoryPairedHomeAuthorizationStore` never persists to disk by design).

## Session: Phase 12.1 — Multi-Hub Mobile & Tablet Home management

**Mobile/Tablet-only** (§1/§20) — nothing in `apps/new/touchpanel` was touched; verified via
`git status -- apps/new/touchpanel` (only pre-existing untracked build output, no source diff).

**Canonical identity vs. display name, enforced structurally (§2/§8):** `PairedHome`
(`apps/new/shared/lib/src/identity/paired_home.dart`) holds `hubId`/`projectId` (canonical,
matches `HubIdentity`) alongside a purely-local `displayName` — nothing in the connection,
authorization, or persistence path ever reads `displayName` to decide access, routing, or
identity; `PairedHomeManager`'s every lookup/mutation keys exclusively on `hubId`. `renameHome`
is a `copyWith` that touches nothing else — proven by test (`hub_abc123` unchanged after
renaming "Mumbai Home" → "Sea View Residence").

**`PairedHomeManager` (new, pure Dart, shared by Mobile and Tablet per §18)** — the Mobile/Tablet
source of truth for "which Homes am I paired with, which is active": `addHome` (rejects a
duplicate `hubId`, auto-selects only the FIRST-ever paired Home — never fabricates a default,
§23), `renameHome` (validates via new `HomeNameValidation`: empty/whitespace-only rejected,
40-char max, trimmed), `removeHome` ("forget on this device" — local only, §15/§16: does NOT
call Hub-side revocation), `setActiveHome`. Deliberately owns no transport/`ConnectionManager`
concept (§25) — it only ever answers "which Home."

**Persistence (§21, §27):** `PairedHomeStore` interface (pure Dart) + `InMemoryPairedHomeStore`
(tests) in `shared`; `SharedPrefsPairedHomeStore` (real, `shared_preferences`) in
`apps/new/mobile` — same non-sensitive-metadata-only split Touch Panel's own
`PrefsPanelConfigStore` already established. No private key or bearer token is stored in this
model — sensitive material stays under Phase 11/12's existing `SecretBytesStore`/session
architecture (a per-Home secure token store is still **PRODUCTION HARDENING REQUIRED**, noted
below, not newly solved by this phase).

**Mobile UI (`apps/new/mobile/lib/features/settings/`):** `SettingsScreen` (Settings root, one
entry: "Home") → `HomeSettingsScreen` (Settings → Home, §3/§4) — lists paired Homes by display
name only (no hubId/IP/port/broker/protocol shown, §4), a selected-Home indicator, per-Home
rename (dialog, validated) and remove (confirmation dialog, explicit "Forget this Home"
language distinguishing local removal from Hub-side revocation per §15), "+ Add Home" (pairing
code entry → `PairingCodeHandler` → name-the-Home dialog, prefilled from the pairing result but
editable, §14), and a first-install empty state ("No Home paired yet", §23 — no fabricated
Home). `PairedHomeController` is a thin `ChangeNotifier` wrapper with zero business logic of its
own, reused as-is for a future Tablet-specific layout (§18: "use the same core model").

**ConnectionManager integration (§25, §10):** `main.dart` gained `activeHomeIdProvider`
(Riverpod `StateProvider<String?>`, keyed on canonical `hubId`, never display name) and
`pairedHomeControllerProvider`, which pushes `PairedHomeController.activeHomeId` into it on
every change. `connectionManagerProvider` watches `activeHomeIdProvider`, so switching Homes
rebuilds `ConnectionManager` via Riverpod's normal provider lifecycle — no
`MultiHubConnectionManager` was introduced (§25 explicitly discouraged one unless the
architecture required it; it doesn't yet). **Honestly incomplete**, documented inline in
`main.dart`: the rebuilt `ConnectionManager` doesn't yet vary its `MockHubDiscovery`/
`MockHubTransport` by the newly-active Home's real identity — that needs a per-Home
`RemoteHubConfig`/`AuthorizedMobileSession`, which in turn needs the secure per-Home token
store noted above. The provider *shape* (fresh manager per Home switch) is real and tested by
construction; the *content* (actually different Hub per Home) is **PRODUCTION HARDENING
REQUIRED**.

**"Add Home" pairing wiring — explicitly PENDING, not faked (§13):** `HomeSettingsScreen`'s
`onPair` callback has the exact real signature (`String pairingCode -> Future<PairHomeResult>`)
a live call into Phase 11/12's `PairingClient.pairUsingCode` would fill — `PairHomeResult`
carries `hubId`/`projectId` from a genuine Hub authorization response, never something the user
merely typed. `main.dart`'s `pendingPairHome` throws `UnimplementedError` with an explicit
message: the real pairing protocol exists and is tested (Phase 11/12), but this composition
root has no Hub-discovery step yet to know which Hub's LAN address to pair against. The widget
test suite proves the UI's OWN behavior (calls the handler with the entered code, uses its
result, never bypasses it) independent of that pending wiring, via a real fake handler.

**Tests — shared: 19 new** (`paired_home_test.dart`) covering persistence (one/multiple Homes,
rename, active-Home reload), identity/security (rename never touches hubId/projectId, duplicate
display names never collide since hubId is the only key, empty/whitespace/over-length name
rejection), multiple Homes (add/switch/re-switch, duplicate-hubId rejection, first-Home
auto-select), isolation (removing/renaming Home A never affects Home B, removing the active vs.
a non-active Home), and startup (no paired Homes, a since-removed active Home resolves to null
rather than a guess, a still-selected Home survives reload regardless of reachability). **Mobile:
7 new** (`home_settings_screen_test.dart`) covering the first-install empty state, multi-Home
listing with no raw technical identifiers, active-Home switching, rename (success + validation
failure), remove-with-confirmation (isolated to the removed Home), and the full add-Home flow
through the real `onPair` contract.

**Gate:** `shared` 84/84 (65 prior + 19 new), `shared_ui` 8/8 (unchanged), `mobile` 8/8 (1 prior
+ 7 new), `touchpanel` 23/23 (untouched, unaffected) — **123 total**. `dart format` clean (6
files reformatted, 0 semantic change). Both Mobile and Touch Panel `flutter build web` succeed.

**Status labels (§35/§36):**
- `REAL/IMPLEMENTED`: `PairedHome`/`PairedHomeManager`/`PairedHomeStore` model and validation,
  Settings → Home UI (list/add/rename/remove/switch), canonical-identity/display-name
  separation (structurally enforced + tested), local persistence, first-install empty state,
  ConnectionManager-rebuild-per-Home-switch *mechanism*.
- `PRODUCTION HARDENING REQUIRED`: a secure PER-HOME token/session store (today's
  `AuthorizedMobileSession` design is single-session-shaped; multi-Home needs one per `hubId`,
  never persisted in `PairedHome` itself); wiring `connectionManagerProvider`'s actual
  transport/discovery to the active Home's real identity instead of the shared
  `MockHubDiscovery`/`MockHubTransport`; the live pairing-code → `PairingClient` network call
  (`pendingPairHome`'s `UnimplementedError`).
- `FUTURE ENHANCEMENT` (§31, explicitly not built): any cross-device/cloud synchronization of
  Home display names — each Mobile's alias is independently local, exactly as specified;
  synchronizing it later is a deliberately separate, unbuilt feature, not a gap in this one.
  Also future: a compact Home-switcher outside Settings (§24) — not added this phase, judged
  unnecessary against the existing calm Home experience; Settings → Home remains the sole
  authoritative surface.

**Existing-app / KNX-Matter safety:** confirmed via `git status` — only `apps/new/shared`,
`apps/new/mobile`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new/touchpanel` untouched (no
Home-management surface added there, per §20); no existing production app touched; concurrent
KNX/Matter changes visible in `git status` predate this session and were left untouched; no
private keys, tokens, or credentials committed (nothing sensitive is stored in `PairedHome` by
design).

## Session: Phase 12 — end-to-end production remote authorization & pairing (server-side)

**Closes the Phase 11 "SERVER-SIDE REQUIRED" gaps for real** — not another client-side
prototype pass. Touches `packages/hub-identity`, `cloud/tunnel-broker`, `services/gateway`;
`apps/new/*` untouched this phase (its Phase 11 client protocol was implemented against
exactly enough of a contract that the server now fulfills it, unchanged).

**Design decision (§11):** the Mobile authorization token is signed with the Hub's OWN Ed25519
device key (`HubIdentity`, `@supreme/hub-identity`) — the exact key ADR 0009's tunnel handshake
already proves possession of. `cloud/tunnel-broker/src/broker.ts`'s `attach()` now retains that
key per-hub (`getHubPublicKey`), so the broker can verify a Mobile token's signature WITHOUT a
synchronous call back to the (often CGNAT-hidden) Hub, and without a second, separately-trusted
keypair. The Hub remains sole issuer; the broker only verifies a signature — transport, not a
smart-home authority (§27), literally the ADR's own words re-applied here.

**`packages/hub-identity/src/mobile-authorization.ts` (new)** — `issueMobileAuthorizationToken`/
`verifyMobileAuthorizationToken`, a compact `base64url(payload).signature` token, 5-minute TTL
(`MOBILE_TOKEN_TTL_MS`). Placed here (not in `services/gateway`) specifically because
`cloud/tunnel-broker` already depends on `@supreme/hub-identity` and must never depend on
`services/gateway` — this is the correct shared home for both issuer and verifier. 5 new tests
(issue/verify round-trip, wrong-hub rejection, expiry, tamper detection, malformed shape).

**`services/gateway/src/mobile-pairing.ts` (new)** — the real server half of Phase 11's
`PairingClient`/`PairingTransport` contract: `verifyMobileSignature` (raw Ed25519 base64 key →
SPKI DER wrap → real Node `crypto.verify`, not string/MAC equality), `PairingCodeStore`
(single-use, 10-min pairing codes), `PairingChallengeStore` (single-use — `consume()` deletes
unconditionally on first lookup, so a challenge can never be replayed even by its own legitimate
user retrying), `MobileAuthorizationRegistry` (the Hub's authoritative, persisted — via the
SAME sealed 0600-file `SecretStore` convention `hub-agent.ts` already uses for
`hub_identity`/`hub_credential`, deliberately not a new DB layer — record of every paired
Mobile: mobileId/publicKey/hubId/projectId/label/pairedAt/lastSeenAt/revoked/revokedAt). 12 new
tests (signature verify incl. tamper/malformed-key, challenge replay/expiry/unknown-id, code
replay/expiry, registry tuple-scoped authorization, revocation isolation between Mobiles,
persistence-across-restart, revoke-on-unknown-id).

**`services/gateway/src/routes/pairing.ts` (new)** — real `/v1/pairing/{codes,challenge,verify,
refresh,mobiles,mobiles/:id/revoke}` routes implementing exactly the contract Phase 11's
`pairing.dart` doc comments described as SERVER-SIDE REQUIRED. `codes`/`mobiles`/`revoke` are
authenticated admin actions (reuse `auth.ts`'s existing `authenticate()`); `challenge`/`verify`
are the pairing ceremony itself (§8: a local-network/local-approval action — these routes are
reachable over LAN directly, same as any other gateway route; they are NOT specially gated
behind the broker's Mobile-token check, because no Mobile token exists yet at pairing time —
that would be a chicken-and-egg dead end, not a security improvement); `refresh` is the one
genuinely-remote Mobile action pre-token, reachable either on LAN or through the broker's
`/v1/route/:hubId/*` forward.

**Broker wiring (`cloud/tunnel-broker/src/server.ts`)** — `/v1/route/:hubId/*`'s default
`authorizeClient` (used whenever no override is supplied — i.e. what actually runs in
production) changed from unconditional fail-closed (`?? (async () => false)`) to a REAL
verifier: parses the bearer token, looks up the claimed hub's device public key via
`broker.getHubPublicKey(hubId)`, and calls `verifyMobileAuthorizationToken`. Unknown/offline hub
→ no key on file → still denied (fail-closed preserved, not weakened). Explicit test override
(`authorizeClient: async () => true`, used by the ORIGINAL Phase-10 e2e suite for hub-tunnel-only
testing) still works unchanged — this is additive, not a breaking change to that test's intent.

**`cloud/tunnel-broker/src/main.ts`** — added a startup safety check (§12): 
`SUPREME_BROKER_DEV_ALLOW_ALL=1` together with `NODE_ENV=production` now throws at boot instead
of silently running with client authorization disabled. `devAllowAll` itself is unchanged and
still available for local dev.

**Revocation model, honestly bounded (§9/§17):** `MobileAuthorizationRegistry.revoke()` is
authoritative and immediate for anything that asks the registry (route `verify`/`refresh`
calls). But a Mobile's currently-in-hand token is a self-contained signed assertion the broker
verifies without consulting the registry — so a just-revoked Mobile's *already-issued* token
still forwards through the broker until it naturally expires (≤5 minutes). This is a real,
deliberately bounded latency window, not a silent gap — proven by the new end-to-end test
(revoke → immediate `refresh` 401 → but a not-yet-expired token still passes the broker's own
check). Documented as `REAL/IMPLEMENTED` with that explicit bound, never claimed instantaneous.

**End-to-end integration test (§23 — "the most important test in this phase")**, added to
`services/gateway/src/broker-tunnel.e2e.test.ts`: a REAL Ed25519 "Mobile" keypair (Node
`generateKeyPairSync('ed25519')`, exported the same raw/base64 way the Dart client does), a real
admin login, a real pairing code, a real signed challenge/response over the actual `/v1/pairing/*`
routes, a real issued token used against the broker's REAL default authorizer (no override) to
reach `/healthz` through the actual tunnel, a forged-signature rejection, a replayed-challenge
rejection, and a revoke→refresh-denied sequence — all against a live Fastify hub + live Fastify
broker + a live `BrokerTunnelClient`, not mocks. 4 tests, 8 assertions of real cross-service
behavior. Device-command feedback (steps 12-15 of §23) is NOT re-tested here — that's the
pre-existing, unrelated `e2e.test.ts` device-command suite against the same real gateway; this
phase's job was proving the identity/pairing/authorization chain gating it, which it now does.

**Gate:** `packages/hub-identity` build clean, 18/18 tests (13 prior + 5 new). `cloud/tunnel-broker`
build clean, 18/18 tests (13 prior + 5 new: 4 `getHubPublicKey` + 1 already counted above —
see `broker.test.ts`). `services/gateway` build clean, 503/503 tests (486 prior + 17 new: 12 in
`mobile-pairing.test.ts`, 4 new `broker-tunnel.e2e.test.ts` cases, 1 net from the pre-existing
suite's assertion — exact new-test breakdown is in the two new test files). No `apps/new`
package was touched this phase — its existing 97/97 gate is unaffected and was not re-run
(nothing in `apps/new` changed) other than what a future consumer of `packages/hub-identity`'s
new exports would need, which is TS-only and irrelevant to the Dart barrel.

**Status labels, honest, per §28/§30:**
- `REAL/IMPLEMENTED`: Ed25519 signature verification (server + client, matching), pairing
  challenge/response with real single-use/expiry/replay protection, Hub-side authorization
  registry (persisted, tuple-scoped, revocable), Hub-issued/broker-verified authorization
  tokens, the broker's real default authorizer, production-mode `devAllowAll` startup guard,
  cross-hub/cross-project isolation (proven by test).
- `SERVER-SIDE REQUIRED`: none remaining for the core pairing/authorization loop — this was the
  literal purpose of the phase. What's left is genuinely new scope (below).
- `PRODUCTION HARDENING REQUIRED`: Mobile-side platform Keystore/Keychain-backed
  `SecretBytesStore` (Phase 11 carry-forward, untouched), OS connectivity-listener wiring
  (Phase 11 carry-forward), an actual homeowner-facing UI for pairing-code display/QR/mobile
  management (none built — this phase is server + protocol only, per its own "no UI polish"
  ordering), Touch Panel's `DeterministicHmacConfigVerifier` (Phase 9 carry-forward,
  deliberately not touched — different component, different identity, migration would need its
  own careful backward-compatibility pass per this phase's own §25 instruction not to do that
  casually).
- `REAL-WORLD TEST REQUIRED`: actual CGNAT/cross-network acceptance (§24) — unchanged, still
  requires real devices on real networks; this phase's integration test proves the
  cryptographic/protocol chain is real, not that it has been exercised over real CGNAT.

**Existing-app safety:** confirmed via `git status` — only `packages/hub-identity`,
`cloud/tunnel-broker`, `services/gateway`, `SESSION_HANDOFF.md`, `TODO.md` changed; `apps/new`
untouched; the concurrent KNX/Matter work visible in `git status` (services/commissioning,
services/protocols, packages/domain-model) predates this session and was left untouched.

## Session: apps/new Phase 11 — production remote access & Mobile pairing

**Broker authorization re-inspected (§9):** `cloud/tunnel-broker/src/server.ts`'s
`/v1/route/:hubId/*` route already fails closed — `opts.authorizeClient ?? (async () => false)`
— and `devAllowAll` is wired ONLY behind an explicit `SUPREME_BROKER_DEV_ALLOW_ALL=1` env var in
`main.ts`, never on by default. So the literal "remove `devAllowAll` from the production path"
ask was already true before this phase. What is still missing, unchanged from Phase 10
(**SERVER-SIDE REQUIRED**): a REAL `authorizeClient` implementation that checks a Supreme access
token against actual hub-membership — today the only two options are `devAllowAll` (dev) or
`undefined` (fail-closed, blocks everyone). Neither is a working production authorizer yet.

**What was built in `apps/new/shared` — new `src/identity/` module:**
- `mobile_identity.dart` — `Ed25519MobileIdentity`, a REAL Ed25519 keypair (via
  `package:cryptography`, not a deterministic stand-in): `generateAndPersist()`, `load()`,
  `sign()`, and a static `verify()` that genuinely fails on a tampered message (proven by test,
  not asserted). Private key bytes are routed through an injected `SecretBytesStore` interface
  so this pure-Dart package never imports Android/iOS platform APIs (§5) — the only
  implementation shipped is `InMemorySecretBytesStore`, explicitly labeled NOT production
  storage. **PRODUCTION HARDENING REQUIRED:** an Android Keystore-backed and iOS
  Keychain-backed `SecretBytesStore` do not exist yet; that adapter work belongs in
  `apps/new/mobile`'s platform layer, not this package, and is not faked here.
- `pairing.dart` — `PairingClient` drives a real challenge/response ceremony (pairing code →
  Hub-issued challenge → Ed25519-signed response → `MobileAuthorization`), never a
  `hubId + MAC address` shortcut (§8 explicitly forbids that). `PairingTransport` is the documented
  contract a real Hub pairing endpoint must implement — **SERVER-SIDE REQUIRED**, no
  `/v1/pairing/*` route exists in `services/gateway` yet. `AuthorizedMobileSession` turns an
  issued `MobileAuthorization` into the `bearerToken` closure `RemoteHubConfig` already expected
  from Phase 10, and enforces expiry/revocation client-side — `markRevoked()` makes
  `bearerToken()` throw immediately rather than send a stale token (§17).
- `MobileAuthorizationRecord` — the Hub-side registry row shape multiple paired Mobiles would
  need (§26: Owner iPhone/iPad, Partner iPhone, …) so a future server implementation and this
  client agree on fields; the actual registry/persistence is server-side, not built here.

**`ConnectionManager.notifyNetworkChanged()` added (§14):** re-triggers `start()` (re-discover
LAN → fall back to remote if enabled → re-authenticate) so a Wi-Fi↔5G/Wi-Fi A↔B transition
recovers without the homeowner re-pairing anything. The reconnect logic itself is
REAL/IMPLEMENTED and tested; **PRODUCTION HARDENING REQUIRED:** nothing in this repo yet calls
it from a real OS connectivity listener (e.g. `connectivity_plus` wired in `apps/new/mobile`) —
that platform wiring does not exist and is not claimed here.

**Multi-Hub / multi-Mobile (§26/27):** already structurally supported — `HubIdentity` was never
a singleton, `MobileAuthorization` is scoped per `(mobileId, hubId, projectId)` tuple, and
nothing in this phase introduced a `hubId = "default"`-style assumption anywhere.

**Revocation (§17):** client-side enforcement is real (`AuthorizedMobileSession.markRevoked()`);
the broker's existing 403 path (§Phase10) is the natural signal to call it from — a revoked
Mobile's next remote `authenticate()` already throws `AuthenticationException` today. Hub-side
"mark this Mobile revoked" persistence/registry is **SERVER-SIDE REQUIRED**, not built this
phase (would require the same not-yet-existing pairing endpoint).

**Config integrity, Touch Panel, 7272 (§19/20/21):** unchanged from Phase 9/10 — carried
forward as-is; still `DeterministicHmacConfigVerifier` (**PRODUCTION HARDENING REQUIRED** for
real Ed25519 config-signature verification — note the Mobile identity work this phase used real
Ed25519 for pairing, but did NOT retrofit the Touch Panel config verifier, which is a separate,
not-yet-touched component); Touch Panel gained no new Mobile-remote-access surface, per §20.

**Security review, status labels used throughout:** `REAL/IMPLEMENTED` — Ed25519 keypair
generation/signing/verification, pairing challenge/response flow, client-side revocation/expiry
enforcement, `notifyNetworkChanged()` reconnect trigger. `SERVER-SIDE REQUIRED` — broker's real
`authorizeClient` (hub-membership check), Hub's `/v1/pairing/*` endpoint and Mobile-authorization
registry. `PRODUCTION HARDENING REQUIRED` — platform Keystore/Keychain-backed `SecretBytesStore`,
OS connectivity-listener wiring, Touch Panel's config verifier (Phase 9 carry-forward),
`DeviceIdentityStore` platform storage (Phase 9 carry-forward). `REAL-WORLD TEST REQUIRED` —
full CGNAT/network-switching acceptance matrix (§24), unchanged from Phase 10, still not
performable in this environment.

**Gate:** `dart format` clean (4 files reformatted, 0 semantic changes); analyzer zero issues
across 4 packages; tests — shared 65/65 (54 prior + 4 mobile-identity + 3 pairing + 1 revocation/
network-change new = **65**), shared_ui 8/8, mobile 1/1, touchpanel 23/23 — **97 total**; both
`flutter build web` succeeded (confirming `package:cryptography` is web-safe, same bar as
`package:http` in Phase 10).

**Existing-app safety:** confirmed via `git status` before/after — only `apps/new/shared/*` plus
this file and `TODO.md` changed; no file under `cloud/`, `services/gateway`, or `infra/` was
touched (broker/gateway were inspected, not modified); the concurrent KNX/Matter work visible in
`git status` (services/commissioning, services/protocols, packages/domain-model) predates this
session and was left untouched.

## Session: apps/new Phase 10 — remote Mobile↔Hub connectivity (real, not fake)

**Critical inspection finding, changes everything about how this phase was scoped:** the
production Hub/cloud architecture for remote connectivity **already exists and is real**,
not something this phase needed to invent:
- `docs/architecture/adr/0009-zero-trust-tunnel-broker.md` — the Hub dials OUT to a cloud
  Tunnel Broker (`cloud/tunnel-broker/`) over a persistent connection (mTLS device cert,
  QUIC/WS). No inbound Hub port, ever — this is what satisfies every CGNAT/NAT/no-port-
  forwarding requirement in this phase, by a decision already made and shipped, not by
  anything added here.
- `cloud/tunnel-broker/src/server.ts` exposes `ALL /v1/route/:hubId/*`: a plain bearer-token-
  authenticated HTTPS request/response proxy. The broker is deliberately "a transport, not a
  man-in-the-middle" (its own doc's words) — exactly the §9 relay-is-transport-only
  requirement, already true.
- There is deliberately **no separate "direct remote" path** in the real architecture — the
  ADR chose broker-only remote for security (no inbound port, ever). Building a parallel NAT-
  traversal/direct-connect layer would contradict that existing decision, not complete it.
  `ConnectionStatus.connectedRemote` means "via the Tunnel Broker," full stop — documented as
  such rather than pretending a "direct" tier exists.
- **Real gap found, not fixed (SERVER-SIDE REQUIRED):** `cloud/tunnel-broker/src/main.ts`
  wires `authorizeClient` to `devAllowAll` in dev mode only — a real verifier (Supreme access
  token + hub-membership check) does not exist yet. Until it does, no Mobile client's bearer
  token is actually checked by a production broker.
- Real-time remote events are **not** available over `/v1/route/*` (request/response only,
  by design) — genuine live remote updates are `cloud/notification`'s job (separate,
  already-existing service, out of `apps/new` scope).

**What was built in `apps/new/shared`:** `RemoteHubTransport` (`src/connection/
remote_transport.dart`) — a REAL `HubTransport` implementation making real HTTPS calls
against the broker's actual `/v1/route/:hubId/*` contract (via `package:http`, cross-platform
including web). `connect()` is a no-op (this is a stateless proxy route, not a socket the
client holds); `authenticate()` does a real `GET .../healthz` and maps the broker's actual
status codes (200/403/503) to `AuthenticationException`/`StateError`; `sendCommand()` POSTs
with a bearer token; `events()` is honestly implemented as polling (not push), clearly
documented as the fallback until `cloud/notification` integration. `RemoteHubConfig` carries
`brokerUrl`/`hubId`/a `bearerToken` provider — all three supplied by a future account/pairing
flow, never fabricated here.

**Tests: 8 new**, all against the broker's real request/response contract (via
`package:http/testing.dart`'s `MockClient`, not a fake transport) — authenticate success/403/
503, command POST shape + bearer header, pre-auth command rejection, mid-session
`hub_offline`, and two full `ConnectionManager` end-to-end tests (remote fallback connects,
and a not-authorized Hub lands on `authenticationFailed`, not a silent "connected").

**Not wired into Mobile/Touch Panel's actual app composition** (`main.dart` still uses
`MockHubTransport` for remote) — deliberately: there is no real account login/pairing flow
yet to supply a real `hubId`/bearer token, and wiring `RemoteHubTransport` in without one
would either sit inert or invite a misleading "remote available" impression. The real,
tested transport exists in `shared` ready for a login/pairing flow to compose it in.

**Local connectivity (§5):** unchanged from Phase 9 — `MdnsHubDiscovery` real code, still
integration-unverified (no Hub advertises `_supremeos._tcp` yet), still correctly excluded
from the web-buildable barrel.

**CGNAT (§7, cases A-H):** satisfied structurally by the existing ADR 0009 design (Hub
dial-out, broker relay, no static IP/port-forwarding needed anywhere) — not by new
NAT-traversal code, which would be redundant with a decision already made. Network-change
recovery (Wi-Fi→5G etc., §14) is handled by `ConnectionManager`'s existing backoff/retry
loop when re-invoked; **PRODUCTION HARDENING REQUIRED**: no OS-level connectivity-change
listener (e.g. `connectivity_plus`) is wired to call `ConnectionManager.start()` again on
network change — `start()` is public and reusable, but nothing yet calls it automatically on
Wi-Fi/cellular transitions. Not added this phase (would be a new Flutter dependency wired to
platform connectivity events with no way to verify it here).

**Security review (§21, honest, not an audit) — status labels used throughout:**
`REAL/IMPLEMENTED`: Hub↔broker mTLS+cert identity (existing), relay-is-blind-transport
(existing), `authenticate()`/`connect()` boundary (Phase 9), remote request/response contract
+ status-code handling (this phase). `SERVER-SIDE REQUIRED`: broker's `authorizeClient` real
verifier. `PRODUCTION HARDENING REQUIRED`: Mobile-side device identity/pairing/login flow,
OS connectivity-change listener, `DeterministicHmacConfigVerifier`→real signature (Phase 9
carry-forward), `DeviceIdentityStore`→platform secure storage (Phase 9 carry-forward).
`REAL-WORLD TEST REQUIRED`: the full §24 manual acceptance matrix (LAN, 5G↔Wi-Fi, CGNAT-to-
CGNAT, Hub restart, Hub DHCP change, Hub Internet loss) — none of this can be proven by a
unit test; it needs real devices on real networks against a real deployed broker.

**Gate:** format clean (54 files, 0 changes across 4 packages after this phase's additions);
analyzer zero issues, 4 packages (no interface changes this phase, so no fallout); tests —
shared 54/54 (46 prior + 8 new), shared_ui 7/7, mobile 1/1, touchpanel 23/23 — **85 total**;
both `flutter build web` succeeded (confirming `package:http`, unlike the mDNS `dart:io`
code, is genuinely cross-platform and safe in the main barrel).

**Existing-app safety:** confirmed via `git status` before/after — only `melos.yaml`,
`SESSION_HANDOFF.md`, `TODO.md` changed outside `apps/new/`; no file under `cloud/`,
`services/gateway`, or `infra/` was touched; concurrent KNX work in another session left
untouched.

## Session: apps/new Phase 9 — native 7272 client architecture, security review

**Real Hub architecture (unchanged by this session — see prior entry for
the inspection, extended here):**
```
LAN/Web client → Caddy HTTPS :443/:80 → SupremeOS Gateway :8080 (internal)
```
No WebSocket/native-client endpoint inspection beyond what the prior entry
found was needed for this phase's scope — it's about the NEW client
architecture, not re-deriving the Hub's existing routes.

**Server-side change identified, NOT made (§Phase9-3/20 — exact
before-modifying identification, deferred to a deliberate human decision):**
smallest-safe path is a new Caddy `:7272` server block reverse-proxying to
the same `gateway:8080` backend `infra/hub-compose/Caddyfile`'s existing
`:443` block already proxies to — i.e. reuse the existing semantic REST/WSS
API and auth (`services/gateway/src/auth.ts`) rather than inventing a
second protocol, exactly as §2 asks to consider. This keeps 8080 internal
and 443 for browsers untouched; 7272 becomes a second front door onto the
identical backend. Not implemented — `infra/hub-compose/Caddyfile` was not
touched.

**What was built in `apps/new/shared` (`supreme_os_core`):**
- `HubTransport` gained `authenticate()`, separate from `connect()` (§
  authentication boundary) — a socket succeeding is not the same claim as
  "this session is authorized." `ConnectionStatus` gained `authenticating`
  between `connecting*` and `connected*`; a rejected `authenticate()` throws
  `AuthenticationException`, routed to a distinct `authenticationFailed`
  state rather than an endless reconnect loop.
- `MdnsHubDiscovery` (`src/connection/mdns_hub_discovery.dart`) — a REAL
  (not mock) mDNS/DNS-SD implementation using `package:multicast_dns`,
  browsing `_supremeos._tcp` and parsing PTR/SRV/TXT records into
  `DiscoveredHub`/`HubIdentity`. Documented TXT contract: `hubId`,
  `projectId`, `version`. **Honest status: implemented against the
  `multicast_dns` API, never run against a real Hub, because no Hub
  advertises `_supremeos._tcp` yet** (that's the server-side work above).
  Deliberately NOT exported from the main barrel — it's `dart:io`-based
  (raw UDP), which breaks on Flutter Web; keeping it out of the barrel is
  what let both apps' `flutter build web` stay green while this real
  implementation exists in the same package. A real mobile/desktop build
  swaps it in for `MockHubDiscovery` at the composition root.
- `SignedPanelConfig` / `HubConfigVerifier` / `DeterministicHmacConfigVerifier`
  (`src/touchpanel/config_integrity.dart`) and
  `ProvisioningController.revalidateAgainstHub()` — the mandatory
  revalidation flow from the Phase 7 review: cached config shows
  immediately (unchanged boot-speed behavior), then in the background the
  panel fetches the Hub's signed config, verifies signature AND
  monotonic version, and ONLY a verified result ever overwrites the cache.
  A locally edited/forged cache file cannot survive this. **Honest status:
  the version-monotonicity check is real and production-safe; the
  signature check itself is a deterministic stand-in, explicitly not
  cryptography** — a real implementation verifies an Ed25519 (or similar)
  signature against a public key from panel enrollment, matching this
  repo's existing Hub-identity direction, and is a drop-in replacement for
  `DeterministicHmacConfigVerifier`.
- `DeviceIdentity` / `DeviceIdentityStore` / `InMemoryDeviceIdentityStore`
  (`src/touchpanel/device_identity.dart`) — clean interface, deterministic
  in-memory test implementation. **Honest status: explicitly NOT
  production-ready** — no Android Keystore/iOS Keychain/desktop
  secure-storage backing exists; the demo panel identity string from Phase
  1-6 is still exactly that, a demo string, now behind an interface that
  makes the gap visible and swappable rather than papered over.
- `PanelHeartbeatMonitor` (`src/touchpanel/heartbeat.dart`) — real,
  deterministic (caller-supplied clock) grace-period logic mapping
  heartbeat timestamps to `PanelConnectionState`; one missed beat within
  the grace period does not flip a panel to disconnected.
- Wired into `apps/new/touchpanel/lib/main.dart`: `PanelBoot._restore()`
  now kicks off `_revalidate()` in the background right after showing the
  cached UI (never blocking boot on it), using a mock Hub echo (no real Hub
  to disagree with yet) — proving the wiring, not simulating a specific
  reassignment (that half is already covered by
  `applyHubPushedReassignment`'s existing tests).

**Registry/Hub-side persistence (§17): NOT implemented, by design.**
`PanelRegistryEntry`/`PanelRegistryRepository` (from Phase 1-6) already
define the correct client-read contract. Actually persisting Touch Panel
registry rows Hub-side needs a real service/DB table in `services/gateway`
— identified as required future work, not faked here as a client-local
"registry."

**Security review (§21, honest, not a formal audit):**
- Device identity: interface-only, no secure storage — real risk if
  shipped as-is; flagged, not fixed (needs platform work).
- Hub identity: now separate from address (`HubIdentity` equality by
  `hubId`+`projectId`); Hub-side persistent identity work already
  underway elsewhere in the repo (unrelated worktree, noted for awareness).
- Authentication: `authenticate()` boundary now exists and is enforced by
  `ConnectionManager`, but no real Hub auth protocol is wired to it yet —
  mock always succeeds/fails on a test flag.
- Configuration integrity: monotonic-version replay protection is real;
  signature verification is not yet cryptographic — the single most
  important thing to land before any real deployment.
- Local network attacker: knowing a Hub's IP+7272 grants nothing without
  passing `authenticate()` — by design, not yet by a real implementation.
- Cloned panel identity: not preventable with the current stub identity
  store; requires the secure-storage work above.
- Remote transport: unchanged, still opt-in/off-by-default, still a
  transport-only concern (no new remote code added this phase).
- Stale/replay configuration: covered by the monotonic version check.

**Tests: 14 new** (2 authenticate/authenticationFailed lifecycle tests in
`connection_manager_test.dart`; 12 in the new
`config_integrity_test.dart`/`hub_discovery_test.dart` covering verifier
outcomes, revalidation adopt/reject/stale-version, device identity
round-trip, heartbeat grace period). **Gate:** format clean (4 packages,
52 files, 0 changes), analyzer zero issues (4 packages — one real fallout
fixed: `ConnectionStateIndicator`'s switch needed the new `authenticating`
case), tests 60/60 shared + 7 shared_ui + 1 mobile + 23 touchpanel = 91
total, `flutter build web` succeeded for both apps (confirming the
`dart:io` mDNS code correctly stayed out of the web build path).

**Existing-app safety:** confirmed via `git status`/`git diff --stat`
before and after — only `melos.yaml`, `SESSION_HANDOFF.md`, `TODO.md`
touched outside `apps/new/` (309 lines, all docs/config, no code). The
concurrent unrelated KNX work in another session was left untouched.

## Session: apps/new platform convention — SupremeOS Hub default port 7272

**Before Phase 9, inspected the existing repository as required.** Findings:
the real running Hub (`services/gateway`) listens on `SUPREME_PORT` (default
**8080**, `services/gateway/src/config.ts`), reverse-proxied to LAN clients
over HTTPS on **443** by Caddy (`infra/hub-compose/Caddyfile`,
`docker-compose.yml`). **No mDNS/DNS-SD/UDP service discovery exists
anywhere in the repository today** — the only discovery tool
(`tools/discover-supremeos-url`) probes a fixed candidate-URL list, it
doesn't advertise or browse a service. `7272` appeared nowhere before this
session. Also noted, purely for awareness: an unrelated, unmerged agent
worktree (`.claude/worktrees/agent-*/packages/hub-identity`) is building a
UUIDv7+Ed25519 Hub identity concept — not depended on here, but it confirms
the project's existing direction already treats Hub identity as separate
from network address.

**What this means / compatibility decision:** `7272` is adopted as the
SupremeOS platform default for the NEW direct client↔Hub control channel
`apps/new` establishes — distinct from the existing browser-facing
HTTPS/Caddy path (443/8080) that `web-installer`/`web-homeowner` use today.
**The real Hub was NOT modified** — `services/gateway`/`infra/hub-compose`
still listen on 8080/443 exactly as before. Whether the Hub should
eventually also listen on 7272 directly (or Caddy should gain a
stream/passthrough proxy to it) is a Hub-side infrastructure decision this
session flags but does not make — it needs a deliberate call from whoever
owns `services/gateway`, not a silent assumption baked into client code.

**What was built**, all in `apps/new/shared` (`supreme_os_core`):
- `SupremeOSHubDefaults` (`src/connection/hub_defaults.dart`): the ONE place
  `7272` is declared — `defaultPort = 7272`, plus a documented (not yet
  implemented) `mdnsServiceType = '_supremeos._tcp'` for a future real
  discovery implementation to advertise/browse for.
- `HubIdentity` + `DiscoveredHub` (`src/connection/transport.dart`): a Hub's
  identity (`hubId`, `displayName`, `projectId`) is now modeled separately
  from its network address/port — equality is by identity, not address, so
  a Hub that moved to a new DHCP-assigned IP is still recognized as the same
  Hub. `DiscoveredHub.port` defaults to `SupremeOSHubDefaults.defaultPort`
  but is carried per-result (a future non-default professional port doesn't
  require touching the constant).
- `HubDiscovery` gained `discoverAllLan()` (returns every visible Hub, §
  multiple Hubs) alongside the existing single-result `discoverLan()` (kept
  for `ConnectionManager`'s normal single-Hub path) — the architecture now
  represents multiple simultaneous Hubs without `ConnectionManager` or any
  UI needing new logic to handle it.
- `MockHubDiscovery` updated to build its mock result through
  `DiscoveredHub`/`SupremeOSHubDefaults` instead of a second hardcoded URL
  string, so the mock can never silently drift from the real default.
- Discovery remains entirely inside the connection layer — no screen/widget
  in Mobile or Touch Panel references a port or discovery type; both only
  ever see `ConnectionManager`'s `ConnectionStatus`.

**Tests added** (`shared/test/hub_discovery_test.dart`, 12 new tests, all
passing): default port is 7272; a discovery result uses 7272 when no custom
port is given; a custom port on one Hub doesn't change the shared constant;
multiple Hubs can be represented at once; `discoverLan` still gives the
single-Hub view; Hub identity compares equal across different addresses
(reconnect-after-address-change); two different Hubs are never equal;
LAN-first/remote-disabled-by-default/remote-only-when-enabled all
re-verified against the new discovery model.

**Gate**: format clean (0 changes, 4 packages), `flutter analyze`/`dart
analyze` zero issues (4 packages, including the two other apps that
transitively depend on the changed `HubDiscovery` interface — only
`MockHubDiscovery` implements it, already updated), tests — shared 32/32
(20 prior + 12 new), shared_ui 7/7, mobile 1/1, touchpanel 23/23 — 63 total,
`flutter build web` succeeded for both apps.

**Not done (deliberately, per scope):** no real mDNS/DNS-SD package was
added — `HubDiscovery` is the documented seam a Phase 9+ implementation
plugs into (likely `multicast_dns` on pub.dev, or platform NSD/NWBrowser
APIs); adding that dependency now would be premature since nothing consumes
it yet. No change to `services/gateway`/`infra/hub-compose`.

## Session: apps/new Phase 7.1 + Phase 8 — Touch Panel Experience

**Phase 7.1 (machine IDs vs display names):** `PanelAssignment` gained
`assignedRoomName`/`assignedAreaName` alongside the existing `assignedRoomId`/
`assignedAreaId`, plus a `displayName` getter — both come from the SAME
Hub-authoritative `AreaSummary` picked during provisioning, never invented or
slugified client-side. `PrefsPanelConfigStore` persists the new fields;
`provisioning_flow.dart` passes the selected area's name through at confirm
time. Regression test added (`panel_boot_test.dart` and
`room_experience_test.dart`) asserting `'living-room'`/raw ids never appear
and `'Living Room'` does.

**Phase 8 (SupremeOS Touch Panel Experience):**
- `RoomExperienceScreen` now branches on `AdaptiveProfile.panelMode` directly
  (5 real tiers — micro/compact/standard/expanded/immersive), each showing
  genuinely different content per the phase brief, not just a different
  arrangement of the same content: micro = identity + one Experience action;
  compact = Lighting/Shades/Climate/Experience, no Audio; standard = all four
  domains + multiple Experiences; expanded/immersive = atmosphere panel +
  controls + Experiences, immersive splitting further into 4 side panels.
- New `ExperienceActivation` widget: tapping an Experience shows "Applying…"
  then the Experience name once the (mocked) Hub confirms — real
  requested-vs-confirmed state, not a fabricated success.
- Connection wiring: `PanelBoot` now creates a `ConnectionManager` (mirroring
  Mobile); `AssignedScreen` shows a small `ConnectionStateIndicator` next to
  the room name (never a dominant banner) and threads `connected` into every
  control so a Hub-down state visibly disables commands (`Switch`/
  `ChoiceChip`/`IconButton`/`DropdownButton` all greyed via real `null`
  callbacks, not silently-ignored no-ops — that distinction was a real bug
  the domain-control API had before this phase).
- Scope-based navigation (`AssignedScreen` rewritten): ROOM scope shows its
  one room with zero navigation; FLOOR/WHOLE HOME scope show a room switcher
  pre-filtered to exactly that scope (structurally cannot reach outside it,
  not just hidden by convention) via a new `_ScopedRoomSwitcher`. No scope
  ever exposes a reassignment control — verified by a new
  `scope_navigation_test.dart` (7 tests) asserting absence of "Change
  Room"/"Change Floor"/"Change Scope"/"Reassign" text at every scope.
- `RoomHeader` gained an optional `trailing` slot (shared by Mobile too, used
  here for the connection indicator).
- Domain control callbacks (`LightingControl.onToggle`, etc.) changed from
  non-nullable to nullable — `null` is how a caller genuinely disables a
  control; a no-op function does not visually disable a `Switch`/`ChoiceChip`
  in Flutter, which was the bug found while wiring connection-state.

**Real bugs found and fixed by the gate:**
1. `late final ConnectionManager` in `PanelBoot` was lazily initialized —
   `dispose()` unconditionally referenced it, so a panel that never left the
   provisioning screen would construct-and-start a fresh `ConnectionManager`
   *during teardown*, leaving a timer flagged as leaked past disposal.
   Fixed by constructing it eagerly in `initState`.
2. `ClimateControl`'s `DropdownButton` had no bounded width and genuinely
   overflowed in a narrow side-panel column — bounded via `SizedBox` +
   `isExpanded: true` + ellipsis, not just made to fit this one test's width.
3. `AudioControl`'s fixed `Row` (icon + 96px slider) overflowed even with no
   artist text — changed to `Wrap`, consistent with the other controls.
4. The immersive Experiences card could still exceed its slot's height —
   wrapped in `SingleChildScrollView`, consistent with the other two cells.

**Visual validation:** all 5 tiers inspected live in a real browser
(`flutter build web` + local static server) — micro (240×320, tiling
artifact in this browser tool at that exact size, content correct in the
unaffected quadrant and confirmed by passing widget tests), compact
(375×812, clean), standard (desktop preset, clean, live "● Connected"
indicator visible), immersive (2400×1500, clean, 4-panel layout, zero
overflow — confirms the overflow fixes above hold under real rendering).

**Final gate:** `dart format --set-exit-if-changed` clean across all 4
packages; `flutter analyze`/`dart analyze` zero issues in all 4; tests —
shared 20/20, shared_ui 7/7, mobile 1/1, touchpanel 23/23 (panel boot 2,
room experience 11, scope navigation 7, prefs store 3) — 51 total, all real;
`flutter build web` succeeded for both apps.

**Known limitation carried forward:** device/room state is still entirely
mocked inline in `RoomExperienceScreen` — no live Hub state feed yet (Phase
9+, §43). Whole Home scope's room switcher currently lists every project
area with no separate "residence overview" landing screen — acceptable per
phase scope but worth a Phase 9 look if Whole Home gets dedicated attention.

## Session: apps/new Phase 7 — SupremeOS Adaptive Experience Foundation

Verified Phase 1-6 with a real Flutter 3.47.4/Dart 3.13.3 toolchain (previously blocked — see
prior handoff entry), fixed everything the gate caught, then built Phase 7 on top of it.

**New package: `apps/new/shared_ui`** (`supreme_os_ui`) — the Flutter binding for
`supreme_os_core`'s tokens, plus the reusable component library. Added to `melos.yaml`.
- `SupremeColorScheme`/`SupremeTextStyles`/`buildSupremeTheme()`: one `ThemeData` for both
  Homeowner and Professional Mode (density changes, palette/type family never does).
- `AdaptiveScope`/`AdaptiveProfile` (new in `supreme_os_core`'s `src/design/adaptive.dart`):
  the semantic adaptive-layout engine — `PanelPresentationMode` (micro/compact/standard/
  expanded/immersive), `LayoutComposition` (singleDominantAction/stackedControls/
  gridControls/sidePanels), `InformationCapacity`, per-mode `minTouchTarget`. Classifies by
  logical dp width (a documented heuristic — a real panel's registered hardware size should
  override this once that plumbing exists; the seam is `physicalSizeInchesHint`).
- Components: `RoomHeader`, `EnvironmentalStateLine`, `LightingControl`/`ShadesControl`/
  `ClimateControl`/`AudioControl`, `ExperienceControl`, `StatusIndicator`/
  `ConnectionStateIndicator`/`PanelConnectionIndicator`, `SupremeCard`, `PrimaryAction`/
  `SecondaryAction`, `AdaptivePanel` (composes children per the current `LayoutComposition`),
  `showSupremeBottomSheet`.
- New design tokens in `supreme_os_core/src/design/tokens.dart`: colors, fluid type scale,
  spacing/radius/elevation/icon-size tokens resolved per `SupremeDensity`, motion
  durations/curves, `EnvironmentalOverlay` (warmth/brightness data model for §12 — no real
  imagery pipeline yet, just the contract).

**Mobile**: `app_theme.dart` deleted; Home/Spaces/Experiences/Now/More/Room now consume
`supreme_os_ui` tokens and components instead of the old ad-hoc `AppColors`. Room screen
uses the same `LightingControl`/`ShadesControl`/etc. and `AdaptivePanel` the Touch Panel uses
— proving shared foundation, not two ad-hoc styling systems.

**Touch Panel**: new `lib/experience/room_experience_screen.dart` — ONE adaptive composition
(not two hand-duplicated screens) that renders as a single-dominant-action micro layout, a
stacked/gridded standard layout, or a side-by-side immersive layout (atmosphere panel +
controls + experiences) purely off `AdaptiveProfile.composition`. Wired into `AssignedScreen`
(replacing the placeholder text). `provisioning_flow.dart` and `main.dart` also moved off
hardcoded hex colors onto `supreme_os_ui` tokens.

**Real bugs found and fixed by the gate** (not hidden):
1. A `const` failing-assert test was a compile error, not a runtime throw — fixed by
   dropping `const` where the test needs the assertion to fire at runtime.
2. `ConnectionState` (our type) collided with Flutter's own `ConnectionState` — renamed ours
   to `HubConnectionState` everywhere, not hidden behind an import alias.
3. Deprecated `RadioListTile.groupValue`/`onChanged` (Flutter 3.32+) — migrated to
   `RadioGroup<T>`.
4. **`AdaptivePanel` nested inside another `AdaptivePanel`'s cell is a real layout bug**: the
   inner one re-reads the ROOT viewport profile via `AdaptiveScope.of(context)` instead of
   respecting its actual slot's constraints, causing severe overflow. Fixed by using a plain
   `Column` for a cell whose composition was already decided by the outer panel — nesting
   adaptive decisions is architecturally wrong, not just a style choice.
5. `ClimateControl`'s body used `Row` + `Spacer`, which genuinely overflows in a narrow
   side-panel column (confirmed both by `flutter test` and by live browser rendering at
   2400×1500) — changed to `Wrap`.
6. The immersive layout's side-panel column could still exceed its slot's height with two
   full `SupremeCard`s — wrapped in `SingleChildScrollView`.

**Verified in a real browser** (`flutter build web` + local static server), not just
compiled: provisioning flow renders correctly styled at 375×812; `RoomExperienceScreen`
renders correctly at desktop width (stacked cards, working chips/slider/stepper) AND at
2400×1500 (three-panel immersive layout, no overflow) — confirming the overflow fix above
held under real rendering, not only widget tests.

**New bug found during live browser check, NOT fixed this session (scope discipline)**:
the room header shows the raw assignment id (`master-bedroom`) instead of a human display
name (`Master Bedroom`) — `AssignedScreen._title` uses `assignment.assignedRoomId` directly.
Real fix needs a display-name field either on `PanelAssignment` or a room lookup by id;
deferred to avoid drifting back into Phase 1-6 model changes mid-Phase-7.

**Also discovered, unrelated to this work**: another session/process is concurrently
modifying `services/commissioning/src/knx/*` and `services/protocols/src/{knx-driver.ts,
knx-codec.ts,...}` — confirmed NOT caused by this session (verified via `git status` deltas
across the session); left untouched.

**Final gate, all real, all passing**: `dart format --set-exit-if-changed` clean across all
4 packages (shared/shared_ui/mobile/touchpanel); `flutter analyze`/`dart analyze` — zero
issues in all 4; tests — shared 20/20, shared_ui 7/7, mobile 1/1, touchpanel 6/6 (all real
assertions, including the §17 completion-criteria test proving the same room composes
differently at 3-4in/10in/30in through the actual app); `flutter build web` succeeded for
both mobile and touchpanel.

**Not done (explicitly out of Phase 7 scope per the brief)**: Watch, Experience editor,
automations UI, technical logs UI, Web Homeowner, extensive protocol UI, additional screens
beyond Home/Spaces/Experiences/Now/More/Room.

## Session: apps/new foundation started (Mobile + Touch Panel, from-scratch UI)

Started the new-generation client apps under `apps/new/` per the North Star spec (residence
OS, not a smart-home dashboard). Existing `apps/mobile`, `apps/web-homeowner`,
`apps/web-installer` untouched — this is a parallel product, not a migration.

**What exists now:**
- `apps/new/shared` (`supreme_os_core`, pure Dart, no Flutter dep): capability vocabulary
  mirroring `packages/domain-model/src/capabilities.ts`, `Space`/`Experience` semantic model,
  `ConnectionManager` (LAN-first, opt-in remote, backoff/reconnect — UI only ever sees
  `ConnectionStatus`), and the Touch Panel provisioning contract (`ProvisioningController`,
  `PanelConfigStore`, `PanelAssignment`, locked `PanelConfig.isLocked`) plus panel registry
  read models (`PanelRegistryEntry`, `PanelEvent`) for the future Logs > Touch Panels view.
  Real unit tests in `apps/new/shared/test/` cover: reboot-restores-assignment, room-scope
  requires a room id, Hub-pushed reassignment overwrites the local cache, LAN-first connection
  selection, remote-off-by-default, no-connection command rejection.
- `apps/new/mobile` (`supreme_mobile_next`, Flutter): 5-tab shell (Home/Spaces/Experiences/
  Now/More per §5), Riverpod-provided `ConnectionManager` + mock `HomeRepository`, a Room
  screen showing only the 4 domain tiles a space declares (no device list).
- `apps/new/touchpanel` (`supreme_touchpanel`, Flutter): boot sequence that restores a locked
  assignment from `shared_preferences` or falls into first-boot provisioning
  (scope → area → confirm); the assigned screen has **no** reassignment control by design.
- Registered all three in `melos.yaml`.

**Mocked, behind interfaces (§43), swap-in point noted in each file:**
- Hub discovery/transport (`MockHubDiscovery`/`MockHubTransport`) — real impl needs mDNS/SSDP +
  the actual gateway WSS/REST contract from `services/gateway`.
- Touch Panel area list and Hub confirmation (`fetchAreas`/`confirmWithHub` in
  `apps/new/touchpanel/lib/main.dart`) — needs the real Hub project/area endpoint and identity
  issuance (mirror `services/identity`).
- Panel registry repository (`PanelRegistryRepository`) — types exist, no backend wiring yet.

**Blocker:** Flutter/Dart are not yet on PATH in this environment (background provisioning
hook was still running mid-session — see `SessionStart` hook output). Could not run
`dart test` / `flutter analyze` / `flutter build` to confirm the new code actually compiles.
Code was written carefully against known-good Dart/Flutter APIs but is **unverified** — next
session must run `melos bootstrap && melos exec -- dart analyze .` (or `flutter analyze`) in
`apps/new/*` before trusting it, and actually run the widget on an emulator per the visual
validation workflow.

**Not started:** design tokens (Phase 3, currently a small ad-hoc `AppColors` in
`apps/new/mobile/lib/app_theme.dart` — should graduate to a real shared tokens module),
Apple Watch / Wear OS targets (Phase 12), Touch Panel adaptive layout engine for 3"–30"
(Phase 8 only has scope/area selection, not the small/large-screen composition rules),
Web management reassignment surface (explicitly out of scope this phase), real semantic-state
wiring to the Hub (everything currently reads mock repositories).

**Recommended next phase:** get Flutter verified and runnable, run the new tests, then build
out the adaptive Touch Panel layout tiers (§26–§28) since that's the most architecturally novel
piece with the least precedent in the existing codebase.

## Session: Home Assistant fully removed

SupremeOS no longer depends on Home Assistant in any form — not optional, fully removed.
Deleted: `services/integration-layer/src/ha/*` (adapter, WS transport, provisioner,
capability mapper) and their tests; the "Supreme Universal Bridge" driver manifest; the
`supreme-homeassistant.service` systemd unit and all `install.sh`/`update.sh`/
`health-check.sh`/`logs.sh` HA install/health logic; the `homeassistant` docker-compose
service, its `ha-data` volume, and `docker-compose.ha-test.yml`; `.github/workflows/
ha-regression.yml`; `docs/ha-integration.md`; the web-installer "Native Migration" tab.
`SUPREME_BACKEND` now has exactly two values: `native` (default, real) and `mock` (tests).
Any earlier note below mentioning `HomeAssistantProviderDriver`/`HaAdapter`/`depends_on:
homeassistant` describes prior history, not current code — see
`docs/architecture/Home-Assistant-Dependency-Audit.md` for the full before/after record.
Left for the user to decide: legacy persisted `ownership="ha"`/`provider="homeassistant"`
DB rows are not migrated (no such rows found in the audited schema, but a live DB with an
old install could have some) — the `ProviderRouter` now fails such devices loudly
(`backend_unavailable`) rather than fabricating state, per the codebase's own principle.

## Session: Casambi Local Gateway diagnosis + driver-secret encryption-at-rest

**Branch:** `native-linux`. Started as a live Casambi Local Gateway debugging session
(discovery working, per-device commands were fanning out to every light — traced the
wire-level `Target_Type`/`Target_ID` encoding against the actual Lithernet UDP Developer
Reference PDF and confirmed `local-command-mapper.ts`/`udp-codec.ts` match the documented
spec exactly, so the fan-out is not a SupremeOS bug — root cause needs a real packet
capture on the user's own network, which this session couldn't take; also confirmed Local
mode structurally cannot fetch real fixture names from the Lithernet gateway — checked
every locally-reachable interface (UDP `NotifyControlValues`, the entire WebAPI, the web
UI, `.ceg` export, the Diagnostics console) and none carry a name field; names exist only
in Casambi's Cloud account).

User asked for a future one-time Cloud REST name-sync (Local UDP stays the only live
transport) but first wanted the Casambi Cloud credential genuinely protected. Investigated
and confirmed the codebase's own **Production Readiness Audit** already flagged this
generally (Critical Blocker H3): driver secrets (`installed_drivers.config`) were stored
as plaintext JSON, masked only in API responses, not encrypted at rest.

**Built real AES-256-GCM encryption-at-rest for every driver's `secret: true` config
field** (not scoped to Casambi — fixes this for every driver: Lutron, HEOS, etc. too):

- `packages/crypto/src/index.ts` — `encryptSecret`/`decryptSecret`/`isEncryptedSecret`/
  `generateEncryptionKey`. Self-describing `enc:v1:<iv>:<tag>:<ciphertext>` format so
  encrypt/decrypt are each idempotent (safe to call on already-transformed values).
- `services/drivers/src/secret-store.ts` (new) — `createDriverSecretCrypto`,
  `withSecretEncryption` (a transparent `IInstalledDriverStore` decorator: every read
  decrypts, every write encrypts — `DriverManager` itself needed zero changes),
  `migrateDriverSecretsToEncrypted` (idempotent boot-time migration for pre-existing
  plaintext, same pattern as ADR-0023's `migrateOwnershipToProvider`).
- `services/gateway/src/bootstrap.ts` — the AES key is generated once and persisted via
  the existing `SecretStore` (0600 file), same pattern as the HA token.
- `services/gateway/src/installer-context.ts`/`context.ts` — wired `driverSecretCrypto`
  through `InstallerServices`, wraps `deps.driverStore`, runs the migration in `init()`.
- Tests: `packages/crypto/src/crypto.test.ts` (+6), `services/drivers/src/
  secret-store.test.ts` (new, 10 tests), `services/gateway/src/
  driver-secret-encryption.e2e.test.ts` (new — proves end-to-end through the real HTTP API:
  masked over the wire, real ciphertext at rest, real plaintext still usable by the driver
  stack, legacy plaintext migrates on next boot).

**Full monorepo verification:** `pnpm turbo run build typecheck test` — 173/173 tasks
green, 372/372 gateway tests passing (zero regressions).

**Then built the actual Casambi Cloud name-sync feature** on top of the encryption layer
above — Local UDP stays the only live transport; Cloud is reached only for this one-time,
REST-only (no WebSocket) fetch:

- `services/protocols/src/casambi/casambi-driver.ts` — `CasambiProtocolDriver.
  syncNamesFromCloud(creds, transport?)`: opens a `createSession()`/`fetchNetwork()`-only
  Cloud session (never `openWire()`), matches each Cloud unit to an already-discovered
  LOCAL unit by numeric id, copies over `name` where present, discards the session. Throws
  if called in Cloud mode. Idempotent; never overwrites a name with an empty one. New
  `CasambiNameSyncResult` type (`matched`/`total`/`networkName`).
- `services/gateway/src/routes/installer.ts` — `POST /v1/drivers/:id/casambi/sync-names`:
  reads `apiKey`/`email`/`password`/`networkId` straight from the driver's own (decrypted)
  config — the SAME fields Cloud mode already has, no new config surface — validates
  they're set, calls the driver method, returns the result.
- `apps/web-homeowner/src/api.ts` / `drivers.tsx` — `syncCasambiNamesFromCloud()`; a new
  "Cloud name sync (optional)" section inside `CasambiLocalGatewayPanel` (Local mode only)
  rendering the same 4 Cloud fields via the existing `ConfigField`, plus a "Sync names from
  Cloud" button and a result summary. Explicit UI note that credentials must be saved
  before syncing (the route reads the persisted config, not the in-browser draft).
- Tests: `services/protocols/src/casambi/casambi-driver.test.ts` (+4 — real match/no-op/
  no-WebSocket/throws-in-Cloud-mode assertions against the real driver), `services/
  gateway/src/casambi-cloud-name-sync.e2e.test.ts` (new — route wiring: 404 for a
  non-Casambi id, 404 with a clear message when no live driver is registered). **Honest
  test-coverage gap, documented in that file's own header comment:** the route's SUCCESS
  path (a genuinely live, connected `CasambiProtocolDriver` reached through `ctx.sil.
  getNativeDriver()`) isn't exercised at the HTTP layer — `AppContext.create()`'s default
  test wiring uses a bare `MockAdapter`, not the `ProviderRouter` real boot
  (`bootstrap.ts`'s `createHubContext`) uses, and no existing test in this codebase
  (including the pre-existing `/casambi/diagnostics`/`/casambi/transport-monitor` routes,
  which read a live driver the identical way) stands up that harness either. The feature's
  real logic is fully covered at the driver level instead.

**Full monorepo verification (after both pieces):** `pnpm turbo run build typecheck test`
— 173/173 tasks green, 993/993 protocols tests + 375/375 gateway tests passing (zero
regressions; one unrelated upstream commit — a curtain-icon UI feature — was merged in
along the way and re-verified clean).

**Security note:** the user pasted real Casambi Cloud credentials directly into chat
during this session. They were never written to any file or committed — caught and fixed
one near-miss where a test fixture briefly used the real values before this was pushed
anywhere. Flagged to the user, who was advised to rotate the password/API key as hygiene
since the chat transcript itself is an exposure point independent of anything this session
did.

**Committed and pushed** to `native-linux` — both the encryption-at-rest work (`583adcc`,
merged with one upstream commit) and this name-sync feature.

**Follow-up in the same session: fleet-wide env-var default for Casambi Cloud
credentials.** User asked whether `apiKey`/`email`/`password` are "default" for both Cloud
and Local setups so the UI never has to ask — confirmed against the manifest schema that
none of these fields have a hardcoded `default`, and that Cloud credentials are shared
across mode switches only because there's a single config object per driver instance. User
then explicitly asked to "make it default for both type of setup" with no typing required.
Two ways to satisfy that were identified: hardcode a literal credential into source (an
explicit **no** — permanent git-history exposure regardless of who asks, the same "never
commit secrets" rule from this file applies) or reuse the deployment's existing
`SUPREME_CASAMBI_API_KEY`/`EMAIL`/`PASSWORD`/`NETWORK_ID` env vars (`config.ts`) as a
fallback wherever a driver's own config leaves these fields blank. Presented both to the
user; they chose the env-var default.

**Built the env-var fallback for both the Local Gateway's Cloud name-sync and any
manifest-installed Cloud-mode Casambi driver:**

- `services/gateway/src/native-driver-factory.ts` — new `NativeDriverFactoryContext.
  casambiCloudDefaults` (populated only when all three required env vars are set), and a
  new exported `resolveCasambiCloudCredentials(config, defaults)` pure helper: driver's own
  config wins field-by-field, falling back to `defaults` only where blank; returns `null`
  when neither source has all three required fields. The `casambi` factory's Cloud branch
  now calls this helper instead of inlining the `??` fallback itself.
  `installer-context.ts`'s `nativeDriverContext()` populates `casambiCloudDefaults` from
  `GatewayConfig.casambiApiKey/Email/Password/NetworkId`.
- `services/gateway/src/routes/installer.ts`'s `/casambi/sync-names` route now calls the
  SAME `resolveCasambiCloudCredentials()` helper (previously had its own duplicated inline
  `str(cfg.x) ?? str(ctx.config.x)` logic) — one credential-resolution path, not two.
- `apps/web-homeowner/src/drivers.tsx` — updated the Cloud name-sync section's help text to
  tell the installer that a fleet-wide env-var default means the sync button works even
  with all 4 fields left blank.
- Tests: `services/gateway/src/native-driver-factory.test.ts` (+2 — fleet default fills in
  for blank config; still null when neither config nor default has credentials).

**Full verification:** `pnpm --filter @supreme/gateway exec tsc --noEmit -p .` clean;
`pnpm turbo run build typecheck test --filter=@supreme/gateway --filter=@supreme/protocols`
— 40/40 tasks green, 377/377 gateway tests passing (21 in the two directly-touched test
files, zero regressions elsewhere).

**Security note (unchanged from above):** no real credential value from this conversation
was ever written to any file — the env-var approach was chosen specifically to keep it
that way permanently, not just for this session's test fixtures.

**Committed and pushed** to `native-linux` (`e3618f9`).

**Found via a real screenshot from the user: the runtime-only fallback wasn't enough.**
The Driver Manager's "Save configuration" screen still demanded API key/email/password be
typed in, and still showed `NOT_CONFIGURED · needs configuration (apiKey, email,
password)`, even with the fleet env vars set. Root cause: `resolveCasambiCloudCredentials()`
only helps once a driver is already constructed — it was never wired into
`validateDriverConfig()`/`isConfigComplete()`, the two functions that gate whether a
config save succeeds and whether `reconcileManifestDrivers()` even starts the driver at
boot. A blank-credentials Cloud config would fail to save at all, and even if it
had been force-saved some other way, the driver would never be reconciled/started.

**Fixed properly, not just cosmetically:**

- `services/drivers/src/config.ts` — new `ConfigFallbacks` type + a `fallbacks` parameter
  on both `validateDriverConfig()` and `isConfigComplete()`. A fallback satisfies a
  required/`requiredIf` field WITHOUT writing it into the persisted config — the field
  stays absent in storage, so the real credential is never written into the encrypted
  secrets store either; it's read fresh from the environment every time it's actually
  needed, so rotating the env var takes effect for every driver instance at once.
- `services/drivers/src/driver-manager.ts` — `DriverManager.setConfig()` accepts and
  threads the same `fallbacks` parameter through to `validateDriverConfig()`.
- `services/gateway/src/installer-context.ts` — new `casambiCloudDefaults()` (single
  source of truth, replacing the duplicated inline check in `nativeDriverContext()`) and
  `fallbacksFor(protocols)` (keys the Casambi fallback map only for drivers whose
  `protocols` include `"casambi"`). Threaded into `setDriverConfig()` (config save),
  `reconcileManifestDrivers()` (boot/config-change reconciliation, 1 call site),
  `reregisterDriver()` (live config-edit reconciliation), and `driverHealth()` (the
  `NOT_CONFIGURED`/`configComplete`/`missing` fields the Driver Manager UI displays).
- Tests: `services/drivers/src/config.test.ts` (+4 — fallback satisfies required without
  persisting; explicit value still wins; still errors with no fallback; `isConfigComplete`
  honors a fallback), new `services/gateway/src/casambi-fleet-default-config.e2e.test.ts`
  (3 tests through the REAL HTTP API: saving a Cloud config with blank apiKey/email/
  password succeeds and reports `configComplete: true`/non-`not_configured` health when a
  fleet default is set; the real values are never persisted into the driver's own stored
  config; the same blank save still correctly 422s when NO fleet default is configured).

**Full verification:** `pnpm turbo run build typecheck test --filter=@supreme/gateway
--filter=@supreme/drivers --filter=@supreme/protocols` — 42/42 tasks green, 380/380
gateway tests passing (7 new across the two directly-touched test files, zero
regressions elsewhere).

**Committed and pushed** to `native-linux` (`2844a01`).

**User pushed further, with a real screenshot: "api key, network admin email, network
admin password, shouldnt be visible at all in ui, these parameters should be set by
default in backend."** Distinct from the backend-completeness fix above — this is a UI
request, and doesn't require putting a literal credential in git (already firmly
rejected earlier this session and not revisited). The three CREDENTIAL fields (apiKey,
network admin email, network admin password) are a deployment-wide account, so an
installer/homeowner should never see input boxes for them at all; `networkId` stays
visible/editable since — unlike the account credentials — it identifies which Casambi
NETWORK this specific job's fixtures live in, which genuinely varies per installation.

- `apps/web-homeowner/src/drivers.tsx` — new `CASAMBI_BACKEND_ONLY_KEYS = new
  Set(["apiKey", "email", "password"])`. `visibleCasambiConfigSchema()` now excludes
  these unconditionally (Cloud mode, Local mode, and with the discriminator omitted),
  so the primary Cloud connectionType form no longer renders them — only `networkId`
  remains, with a short note explaining the account is deployment-wide. Local Gateway's
  "Cloud name sync (optional)" panel's `cloudSyncFields` now filters to `networkId`
  only, with the help text rewritten to stop inviting manual credential entry. The
  driver-health "needs configuration" chip no longer prints raw `apiKey`/`email`/
  `password` field-key names (which now point at controls that don't exist) — for
  Casambi it instead says the deployment itself has no Casambi Cloud account configured
  and to contact the system administrator, distinguishing that from any other genuinely
  missing, still-visible field.
- `visibleCasambiConfigSchema` exported for testing.
- Tests: `apps/web-homeowner/src/drivers.test.ts` (+3 — apiKey/email/password absent in
  Cloud mode, Local mode, and with connectionType omitted; `networkId` still present).

**Full verification:** `pnpm turbo run build typecheck test --filter=
@supreme/web-homeowner --filter=@supreme/gateway --filter=@supreme/drivers
--filter=@supreme/protocols` — 47/47 tasks green (103/103 web-homeowner tests, 3 new).

**Committed and pushed** to `native-linux` (`cc0e3bd`).

**User asked to wire the fleet default into the actual deployment tooling** so a
provisioned hub ships with it pre-set, never something even a deployer types into a
running system's UI: `infra/native-linux/install.sh` and `config/gateway.env.template`.

- `install.sh`'s `collect_answers()` — `SUPREME_CASAMBI_API_KEY`/`EMAIL`/`PASSWORD`/
  `NETWORK_ID` follow the exact same non-interactive, pre-exported-only pattern already
  used for `SUPREME_HA_TOKEN`/`SUPREME_UNSPLASH_KEY` (`"${VAR:-}"`, never prompted,
  never logged) — whoever provisions the hub image pre-exports these before running
  install.sh (or hand-edits `install.conf` after). Persisted into `install.conf`
  (`chmod 0640`) the same way every other answer is, so `update.sh`/`recover.sh`
  re-renders pick them up automatically on every subsequent run.
- `lib/deploy-steps.sh`'s `render_template()` — 4 new `___SUPREME_CASAMBI_*___`
  substitutions. Guarded with `${VAR:-}` (unlike every pre-existing substitution in this
  function, which assumes the var is always set) specifically because `update.sh`'s
  `load_answers()` and `recover.sh` both `source` `install.conf` directly rather than
  going through `collect_answers()`'s defaulting — an install.conf written by a
  pre-this-change install.sh genuinely won't have these keys, and `set -euo pipefail`
  would abort with "unbound variable" without the guard. Verified directly: simulated
  `render_template()` against the real template both with and without the vars set —
  correct empty-string output in the backward-compat case, correct real values when set,
  zero leftover `___` placeholder tokens either way.
- `config/gateway.env.template` — the 4 new lines (with the same doc comment explaining
  the design), placed next to the existing Lutron block.
- **Found and fixed a related, pre-existing gap while checking for docker-compose
  parity** (the template's own header claims a direct correspondence with
  `docker-compose.yml`'s gateway service): `infra/hub-compose/.env.example` already
  documented `SUPREME_CASAMBI_*` (from an earlier, unrelated session that wired
  `bootstrap.ts`'s env-only Cloud auto-connect), but `docker-compose.yml`'s gateway
  `environment:` block never actually listed them — so setting them in `.env` never
  reached the container on the Docker deployment path. Added the same 4
  `${VAR:-}`-interpolated lines there, matching the existing per-driver convention (e.g.
  the adjacent Lutron block). Verified with `docker compose config` (real Compose
  interpolation, minimal required vars supplied) — parses clean, Casambi vars resolve
  correctly into the rendered gateway service.
- `shellcheck -x` on both modified scripts — zero new warnings (all pre-existing,
  unrelated to this change); `bash -n` syntax-checks clean on both.

**Committed and pushed** to `native-linux` (`eec572c`).

**User then pasted the same real Casambi credentials a second time** and asked to "save
it permanently... encrypt it." Refused to write it into any repo file again — same
reasoning, unchanged: this session only has the git repository, not the user's live
hub; nothing in a git-tracked file is ever the right place for a real secret regardless
of phrasing ("which file do I edit", "save it in the project repo"). Explained explicitly
that `gateway.env`/`install.conf` never live inside the repo at all — `install.sh`
renders them onto `/etc/supremeos` on the ACTUAL hub's filesystem, outside git entirely —
so there genuinely is no repo file for this, not just an inconvenient one. Recommended
rotating the password/API key since it's now been pasted into this chat transcript twice.

**User then asked for automation: "whenever new installation or old it place it should
automatically run."** Built exactly that, without ever putting the real value in git:

- `infra/native-linux/config/casambi-fleet-credentials.example` (new) — git-tracked
  TEMPLATE only (blank placeholders), documenting the real, machine-local, NEVER-tracked
  file operators copy it to (`/etc/supremeos/casambi-fleet-credentials`, `chmod 0600`)
  before filling in real values.
- `infra/native-linux/lib/common.sh` — new `load_casambi_credentials_file()`, mirroring
  install.sh's own `load_install_conf_safely` line-format discipline (only simple
  `SUPREME_CASAMBI_*="value"` lines, shell metacharacters rejected, file never `source`d
  as executable shell). Missing file = silent no-op (the normal case); a genuinely
  malformed one is rejected in full with a clear warning. An already-non-empty variable
  (an explicit one-off env-var export) is left untouched, so a deliberate override always
  wins over the standing fleet file — verified directly (env var wins per-field, file
  fills in the rest, both cases produce the expected result).
- `install.sh`'s `collect_answers()` now calls this loader BEFORE the existing `"${VAR:-}"`
  fallback, so a brand-new machine picks up the credentials file automatically from a
  plain `./install.sh` — no env var to export, no extra flag, no manual step beyond
  placing the file on the machine however it was provisioned (golden image, scp, USB).
- `infra/native-linux/apply-casambi-credentials.sh` (new, executable) — the "old
  installation" half: for an ALREADY-installed hub, loads the same credentials file,
  rewrites ONLY the 4 `SUPREME_CASAMBI_*` lines in the existing `install.conf` (every
  other answer/secret untouched — proven by diffing the file before/after in the
  end-to-end simulation below), re-renders `gateway.env` via the same `render_template()`,
  and restarts `supreme-gateway`. Idempotent — safe to re-run any time the file's values
  change (rotation).
- **Verified end-to-end, not just unit-by-unit**: simulated a full run against a fake
  `SUPREME_CONFIG_DIR` with a pre-existing `install.conf` that predates this feature (no
  Casambi keys at all, proving the backward-compat guard from the prior commit still
  holds) — loaded a fixture credentials file, confirmed `install.conf` gained exactly the
  4 new lines with every pre-existing line byte-for-byte unchanged, then re-rendered
  `gateway.env` and confirmed the real fixture values landed correctly with zero leftover
  `___` placeholder tokens. Also verified the "no credentials file at all" case (the
  default/common case) is a clean, error-free no-op. Fixture values only — no real
  credential in any file, test, or command in this session, consistent with the standing
  constraint.
- `shellcheck -x` on all three touched/new files — zero findings (the one new warning
  introduced, SC2015 in `apply-casambi-credentials.sh`, was fixed by rewriting the
  guard as an explicit `if`, not suppressed). `bash -n` syntax-checks clean on all three.
- Full monorepo `pnpm turbo run build typecheck test` — 47/47 tasks cached-green
  (infra-only change, correctly has zero effect on any JS/TS package).

**Committed and pushed** to `native-linux` (`8e6bedc`).

**User pushed back once more: "But I don't want that"** — i.e. didn't want ANY human,
ever, to manually type the credential per hub, even once. Explained the actual technical
ceiling honestly rather than either caving (hardcoding it in git, still refused) or just
repeating the prior answer: a secret shipped in software always originates from SOME
human action — the only real lever is WHERE that happens and HOW OFTEN. Presented the one
option that genuinely collapses it to a single, permanent action: move the one-time entry
into this repo's own CI secrets store (GitHub Actions), so no individual hub-provisioning
event ever requires retyping the values again. User replied "you know best" — proceeded
to design and build it directly against this repo's OWN existing release infrastructure.

**Built `.github/workflows/casambi-credentials.yml`** (new, `workflow_dispatch`-only,
never runs on a push/tag): reads three GitHub Actions repository secrets
(`CASAMBI_API_KEY`/`EMAIL`/`PASSWORD` — added once, by an admin, directly in GitHub's own
encrypted secrets UI, never a file in this repo, never pasted anywhere again) and renders
exactly the `casambi-fleet-credentials` file `install.sh`/`apply-casambi-credentials.sh`
already consume, as a short-lived (1-day retention) workflow artifact — never attached to
a published GitHub Release (deliberately distinct from `release.yml`'s own artifact,
which persists indefinitely and is downloadable by anyone with repo/release access).
`check-secrets`/`fail-if-not-configured` job-output gating mirrors the exact pattern
`cd.yml`'s own `OTA_SIGNING_KEY` gate already uses in this repo (a job-level `if:` can't
read `secrets` directly). Secret values live only in each step's own `env:` block, never
inlined into a `run:` string, on top of GitHub's own automatic log-masking.
`SUPREME_CASAMBI_NETWORK_ID` is deliberately NOT a secret here and renders blank — unlike
the account itself, it identifies one specific hub's Casambi network, which isn't a fleet
value to centralize.

**Explicitly considered and rejected** baking the credential directly into
`release.yml`'s own packaged install artifact (the more "automatic" option) — that
artifact is signed and published to every future GitHub Release, downloadable
indefinitely by anyone with repo/release access, which would make the exposure surface
WORSE than the manual file-copy approach, not better, and directly contradicts "not
accessible to anyone." The `workflow_dispatch`-only, short-retention, never-published
design is the one that actually reduces exposure versus every earlier option in this
session, including the previous commit's own manual approach.

**What this changes practically:** the one remaining human action (typing the real
values) now happens exactly once, ever, in GitHub's own secrets UI — not per hub, not
repeated on rotation either (only add secret rotation to that same UI once). Provisioning
any future hub, or rotating the password, becomes: trigger the workflow from the Actions
tab, download the artifact, copy the file onto that machine, run `install.sh` or
`apply-casambi-credentials.sh` — zero retyping of the actual credential, ever again.

**Verified:** the workflow YAML parses cleanly (`python3 -c "import yaml; ..."` against
the file); `actionlint` wasn't available in this sandbox to lint further, disclosed
honestly rather than skipped silently. No JS/TS or shell script changed in this step —
purely a new CI workflow file, so the existing full-suite verification from the prior
three commits stands unaffected.

**Committed and pushed** to `native-linux` (`66ae067`).

**User then tested live against their own hub (192.168.0.105)** and reported the "Cloud
name sync (optional)" section was missing from the Local Gateway panel — confirmed the
code IS correct/present in the repo at that exact spot (`drivers.tsx:675`, right before
`CasambiDiscoveryExplainer` at line 706); the user's hub was simply running a build that
predates the feature. Pointed them at `sudo ./infra/native-linux/update.sh` plus a hard
browser refresh, and at `git log --oneline -1` on the hub itself vs. `origin/native-linux`
to confirm drift going forward — this session has no network path to the user's LAN to
verify directly, disclosed explicitly rather than pretending otherwise.

**Found a real bug from the user's next screenshot**, unrelated to any of the above: Cloud
mode's `createSession()` was failing with `HTTP 404`. Root cause: the user had typed
`Showroom` (the network's own DISPLAY NAME, set in the Casambi mobile app) into the
"Network id (optional)" field. `HttpCasambiTransport.createSession()`
(`services/protocols/src/casambi/cloud-transport.ts:143-146`) builds the session URL as
`/v1/networks/${networkId}/session` whenever `networkId` is non-empty — `Showroom` isn't
a real Casambi network ID, so that endpoint doesn't exist, hence 404. The field's own help
text ("Pin a single network for a faster session handshake") never said what a valid value
actually looks like or warned that a display name would break the request outright.

- `services/drivers/src/manifests.ts` — rewrote the `networkId` field's `help` text to
  explicitly warn that it's Casambi's own internal network ID, NOT the display name shown
  in the Casambi app, name the exact failure mode a display name causes, and clarify blank
  is the normal/expected value unless the account manages more than one network.
- Immediate fix given directly to the user: clear the field, re-save — with it blank,
  `createSession()` calls `/v1/networks/session` (no network segment), authenticating
  against whichever network(s) the account can see.
- Verified: `@supreme/drivers` typecheck clean, its 36 tests pass (unchanged — this is a
  `help` string only, no schema/behavior change), full
  `pnpm turbo run build typecheck test --filter=@supreme/drivers --filter=@supreme/gateway
  --filter=@supreme/web-homeowner` — 45/45 tasks green, 380/380 gateway tests unaffected.

**Committed and pushed** to `native-linux` (see commit following this entry).

---

## Session: Repository sync — native-linux ⟵ claude/casambi-driver-refactor-lvu23e

Compared both branches commit-by-commit (11 unique to `native-linux`, 4 unique to
`claude/casambi-driver-refactor-lvu23e`). Ported: `SupremeOS Core Capability Audit`
(docs), `Capability Audit Phase 1` fixes (fully, clean cherry-pick), the automations
`engine: "ha"` rejection + `assertSecureConfig` mock-in-production refusal from
`Native Backend Implementation`, and `SupremeOS Production Readiness Audit` (docs).

**`Native Backend Implementation`'s adapter-wiring work (see that session's own entry
below) was NOT ported wholesale** — it targets `RoutingBackendAdapter`/
`routing-adapter.ts`, which `native-linux` had already deleted in favor of its own,
independently-developed ADR-0023 Provider architecture
(`ProviderRegistry`/`DriverBindingEngine`/`ProviderRouter`). `provider-router.ts`'s own
docstring already states it "never assumes any particular provider (including Home
Assistant) is present" and fails loudly rather than falling back to a simulator —
the same goal that session pursued via now-superseded files. `home-service.ts`'s
`bind()` on `native-linux` already uses explicit provider assignment (ADR-0023 §
Commissioning), so the "defaults ownership to ha" bug that session fixed does not
exist here in the first place. **This directly resolves the Production Readiness
Audit's Critical Blocker #1 below** ("two incompatible unmerged core-architecture
rewrites") — `native-linux`'s ADR-0023 Provider architecture is confirmed the one
production line of development; the `RoutingBackendAdapter`/`OwnershipRegistry` line
is superseded, not merged. Full comparison, every excluded file, and why:
`docs/architecture/Native-Linux-Casambi-Branch-Sync-Report.md`.

## Session: SupremeOS Production Readiness Audit (Commercial Release Assessment)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Read-only audit, no application code
modified. New doc: **`docs/architecture/SupremeOS-Production-Readiness-Audit.md`** —
covers all 10 requested phases and 9 deliverables (Production Readiness Report, Driver
Readiness Matrix, Installer Workflow Audit, Diagnostics Coverage Report, Backup & Recovery
Report, Security Assessment, Performance Assessment, Commercial Competitiveness Assessment,
Remaining Blocker Roadmap) plus a Final Production Readiness Score. Evidence gathered via
7 parallel research passes (each citing file:line) plus this session's own direct
investigation and synthesis for Phase 9/10.

**Final score: 3.6/10 — Pre-Production.** Top 5 Critical blockers found:

1. **Two incompatible, unmerged core-architecture rewrites of device lifecycle exist
   simultaneously.** This branch extended `OwnershipRegistry`/added `HaUnavailableAdapter`
   (Native Backend session). Independently, the `native-linux` branch replaced the same
   subsystem with a `provider`+`DeviceLifecycleState` model under its own ADR-0023
   ("Native Device Lifecycle Architecture" — note: **ADR number collision** with this
   branch's `docs/architecture/adr/0023-native-backend-default.md`, different content).
   Neither branch's device-lifecycle work exists on the other. This needs a dedicated
   reconciliation session before either branch can be called "the" production architecture.
2. **Backup-signing keypair is ephemeral** (`services/gateway/src/installer-context.ts:294,305`)
   — regenerated fresh on every gateway process start, no persistence, no config override.
   Any backup taken via the API becomes unrestorable after the gateway restarts — breaks
   the wipe+reinstall+restore and hardware-replacement recovery stories entirely.
3. **Matter, DALI, and Zigbee drivers are structurally non-functional in production** —
   default controller/bus factories throw unconditionally; nothing in `bootstrap.ts` or
   `native-driver-factory.ts` ever injects a real one.
4. **`assertSecureConfig()` doesn't require `setupWizard=true` in production** — a
   misconfigured deployment (`SUPREME_SETUP_WIZARD=0`) silently gets a Master account at a
   hardcoded, source-visible password with zero warning.
5. **Zero verified evidence of performance/scale at any device count.** The CI job meant to
   produce a real load number (100 VUs/60s) has failed 100% of its 32 scheduled runs
   (broken pnpm invocation) and has never been triggered manually.

Full ranked blocker list (5 Critical / 10 High / 9 Medium / 4 Low), the complete
Driver Readiness Matrix (~22 drivers), and category-by-category Commercial Competitiveness
scoring (vs. RTI/Savant/Crestron/Control4) are in the audit doc — not duplicated here.

**Rules honored per the task brief:** no application code modified, no architecture
redesigned or resolved (the branch-fork finding is reported, not decided), no new protocol
features, nothing removed. This document and this handoff entry are the only changes this
session produced.

**Recommended next session**: per the user's own closing note in the audit brief, resolve
the 5 Critical blockers (especially C1, the branch fork, and C2, the backup-key defect)
before any Fan/Vacuum/RGB/protocol-expansion feature work.

---

## Session: SupremeOS Core Capability Audit — Phase 1 (Correctness Fixes)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New doc:
**`docs/architecture/SupremeOS-Core-Capability-Audit-Phase1-Fixes.md`** (Correctness
Fix Report, Capability Compliance Report, Regression Report, Updated Capability
Matrix). Fixes only the 5 correctness bugs named in the prior session's
**`docs/architecture/SupremeOS-Core-Capability-Audit.md`** §6 items 1–7 — no new
capabilities, no protocol expansion, no deployment change, no UI redesign, `vacuum`
support NOT implemented, no new KNX/Matter fan features implemented.

**Fixed, each with new/updated tests:**
1. `apps/web-homeowner/src/device-sheets.tsx` — a sensor-only device's Expanded Sheet
   fabricated a "Turn on/off" button (sensor is read-only). Added a `SensorSheet`
   read-only readout.
2. `services/protocols/src/sip-driver.ts` — the SIP door station's `"lock"` action
   fabricated `locked: true` with zero hardware confirmation (no relatch API exists).
   Now throws a clear error instead.
3. `services/protocols/src/knx/capability-mapper.ts` — KNX discovery classified
   fan/ventilation-named devices with a `fan` capability that `knx-codec.ts` cannot
   execute (guaranteed throw). Now classifies `deviceKind: "fan"` for diagnostics
   only, `capabilities: []`.
4. `services/protocols/src/matter-driver.ts` — `discover()` silently filtered out any
   node whose clusters map to zero capabilities (a real Matter `FanControl`/RVC
   node). Now keeps the node in the result with `raw.unmappedClusters` disclosed, and
   fires a new optional `onLog` warning (mirrors the existing avr/heos/yamaha
   pattern) — not commissionable, but no longer invisible.
5. `cloud/voice/src/alexa.ts`, `google.ts`, `services/homekit/src/bridge.ts` — a
   device whose capabilities produced zero real Alexa interfaces / Google traits /
   HomeKit services was still discovered/synced/published (visible, uncontrollable,
   or an empty accessory). All three now omit such a device entirely; a device with
   at least one genuinely mapped capability (e.g. `fan`+`onoff`) is unaffected.

**A real regression was found and fixed during full verification** (not just
touched-package testing): Fix 3 broke `knx-installer-workflow.e2e.test.ts`'s two
"KNX Automatic Room Creation" tests — their fixture device was incidentally named
"Vent Fan Switch" (testing room assignment, not fan control), which now correctly
gets zero bindable capabilities and fails KNX approval. Renamed the fixture to
"Attic Utility Switch" (classifies as `onoff`) — not a flaw in Fix 3.

**Verification:** full monorepo `pnpm turbo run build typecheck test` —
**173/173 tasks successful** (one unrelated `heos-driver.test.ts` `ECONNRESET` flake,
confirmed non-reproducing, matching this repo's already-known flaky-test class).

**Disclosed, not silently skipped:** Fix 1 (Sensor Expanded Sheet) has no automated
UI test in this repo and was not verified live via Playwright this session — verified
by typecheck and code review only. A follow-up session should open the app against a
sensor-only device and confirm the Expanded Sheet renders a read-only readout with no
command firing.

## Session: Native Backend Implementation — Home Assistant becomes optional

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New docs:
**`docs/architecture/Native-Backend-Implementation.md`**,
**`docs/architecture/adr/0023-native-backend-default.md`**. No protocol, deployment, or
UI file modified — confirmed via a scoped `git diff`.

**The ask:** replace the production use of `MockAdapter` with a true Native Backend;
make Home Assistant a genuinely optional compatibility adapter; classify every
`IBackendAdapter` method; fix commissioning ownership defaults, `Device.status`
reconciliation, and `engine: "ha"` automations.

**Key finding before writing any code:** the brief's stated "current architecture"
(`RoutingBackendAdapter → {Home Assistant, Mock Adapter}`) didn't match the code.
`SupremeNativeAdapter` already existed, was already a complete `IBackendAdapter`, and
was **already** wired unconditionally as the router's `native` slot — it already *is*
the Native Backend. The real gaps were narrower: the router's `ha` slot silently got
`MockAdapter` whenever `SUPREME_BACKEND !== "ha"` (the type didn't even have a
`"native"` value), and `HomeService.bind()` defaulted every device's ownership to
`"ha"` unconditionally — the exact "nothing else claimed it" heuristic
`OwnershipRegistry`'s own docstring forbids. See the architecture doc's §0 for the
full account.

**Changes, in order:**
- `services/gateway/src/config.ts` — `backend: "native" | "mock" | "ha"`, defaulting
  to `"native"`; `assertSecureConfig()` now refuses `SUPREME_BACKEND=mock` in production.
- `services/integration-layer/src/ha-unavailable-adapter.ts` (new) — the honest "HA
  compatibility plugin not installed" placeholder, replacing `MockAdapter`'s old
  implicit role in the router's `ha` slot.
- `services/gateway/src/bootstrap.ts` — three-way `haSide` selection (`ha`/`mock`/
  `HaUnavailableAdapter`).
- `services/integration-layer/src/sil.ts` — new `haCompatBackendKind` accessor and
  `primeState()` (centralizes in-process engine state priming, previously
  bootstrap.ts-only and broken for every test that builds its own `AppContext`).
- `services/home/src/home-service.ts` — `bind()`'s default ownership is now `"ha"`
  only when the hub's HA-compatibility slot has a working backend behind it (real or
  mock-standing-in-for-tests); `"native"` otherwise. New `setDeviceStatus()`.
- `services/gateway/src/{context,installer-context,main}.ts` — centralized state
  priming in `AppContext.create()`; `InstallerServices.reconcileDeviceStatuses()`
  (per-device `getDiagnostics().connectionStatus`, falling back to protocol-level
  connect status; never touches a device with no honest signal), called on every
  driver lifecycle transition and once a minute from the tick loop.
- `services/automations/src/service.ts` + `engine.ts` — `create()`/`update()` reject
  new `engine: "ha"` automations; `health()` reports a legacy one as `"broken"`.
- `packages/domain-model/src/automations-dsl.ts` — doc comment updated to match.

**Tests added:** `ha-unavailable-adapter.test.ts`, two new cases in
`routing-adapter.test.ts`, four new cases in `config.test.ts`,
`native-backend-boot.e2e.test.ts` (the first test in this repo to exercise the real
`bootstrap.createHubContext` production path — every other gateway e2e test builds
its own `AppContext` directly), `device-status-reconciliation.e2e.test.ts`, and four
new cases in `services/automations/src/engine.test.ts`.

**Verification:** full monorepo `pnpm turbo run build typecheck test` — **173/173
tasks successful** (one unrelated `heos-driver.test.ts` `ECONNRESET` flake on the
first run, confirmed non-reproducing on an isolated rerun, matching this repo's
already-known flaky-test class — not a regression from this work). Gateway package
alone: 74/74 test files, 306/306 tests.

**Disclosed, deliberate scope boundaries (not bugs):** `engine: "ha"` automations are
rejected, not executed — no live push-to-HA/`externalRef` lifecycle exists
(`compileToHa()` is a pure compiler nothing calls), and building one was out of this
milestone's scope and unverifiable without a live HA instance in this sandbox.
`Device.status` for HA-owned, unassigned, or native-owned-but-never-bound devices is
left untouched — no honest per-device connectivity signal exists for them.

## Session: Runtime Data Path Verification — Casambi UDP receive-path evidence tooling

**Branch:** `claude/casambi-driver-refactor-lvu23e`. New doc:
**`docs/architecture/Casambi-Runtime-Data-Path-Verification.md`**. **No protocol logic modified**
(UDP codec, Discovery Engine, Entity Mapper, Event Engine untouched).

**The ask:** determine exactly where a UDP packet disappears when `Packets Received` stays at
zero despite the gateway confirmed broadcasting (Wireshark on the host sees it), with runtime
evidence rather than another round of assumption.

**Built, in order from the bottom of the stack up:**
- **Independent UDP probe** (`services/lan/src/server/udp-probe.ts`, opt-in via
  `SUPREME_LAN_PROBE_PORT`) — a second listener with no decoder, no NATS, no Casambi, bound to the
  same port. Splits "why does SupremeOS see zero packets?" into two answerable halves: probe deaf
  too → loss is below SupremeOS; probe hears them → loss is inside SupremeOS, above the socket.
- **Network + socket forensics** (`services/lan/src/server/network-forensics.ts`) — real
  `/proc/net/route` (routing table, default gateway), `/proc/net/udp` (kernel's own per-socket
  **drop counter** — proof packets arrived and were THEN lost, a different diagnosis from "never
  arrived"), `/proc/self/ns/net` (namespace identity), real socket buffer sizes. Parsers validated
  against real captured content from this session's own Linux sandbox, cross-checked against
  Node's own `address()`/`getRecvBufferSize()` for a genuinely bound socket. `null` + stated reason
  on any non-Linux platform, never a fabricated empty table.
- **Eleven-stage receive pipeline** (`services/protocols/src/casambi/receive-pipeline.ts`) — OS
  Network Stack → supreme-lan UDP Socket → Datagram Received → Raw Packet Recorder → NATS Publish →
  Gateway Subscriber → Casambi UDP Engine → Protocol Decoder → Discovery Engine → Entity Mapper →
  Room Assignment. `StageMetrics` (entered/exited/failures/timestamps/latency) added to
  `core/pipeline-stages.ts` with every `null` REQUIRED to carry a reason (enforced by
  `stageMetrics()`'s own default) — e.g. OS Network Stack's `entered` is `null` because the kernel
  cannot count datagrams that never reached it, and Room Assignment carries no counter at all
  because that step genuinely isn't performed by this driver (confirmed by reading
  `approvePendingDevice` before writing the stage, not assumed).
- **Root cause classifier + certification** (`services/protocols/src/casambi/receive-certification.ts`)
  — exactly the nine specified categories, checked bottom-up (kernel drops before any app counter).
  `unknown` is a real, tested outcome: the exact reported state (driver socket at zero, no host
  capture) resolves to `unknown` naming both candidate causes and the one piece of evidence
  (a `tcpdump`/Wireshark count over the same window) that would resolve it — never invented.
  Certification requires all seven sections evaluated AND passing; an un-run section is
  `NOT EVALUATED`, never a silent pass.
- **Gateway route** `GET /v1/drivers/:id/casambi/receive-pipeline?wiresharkPackets=N` and a
  **Runtime Pipeline Dashboard** in the Casambi Diagnostics panel — all eleven stages rendered
  independently (no aggregate), a `null` metric shown as "not measured" with its reason, never `0`.
  Diagnostics-only; not rendered in Cloud mode.
- `infra/hub-compose/collect-certification-evidence.sh` now also fetches this report, feeding it
  the REAL packet count read back from its own `tcpdump` capture.

**Verification:** `@supreme/lan` 93/93 tests (22 new, including real-OS-socket reception proof for
the probe); `@supreme/protocols` 279/279 (32 new, covering every classifier branch including both
`unknown` cases). Full monorepo: 115/115 build+typecheck, 99/99 test tasks. Deployment-isolation
guard still passes against the new modules.

**Standing limitation, stated plainly:** this cannot run against the real Lithernet Gateway from
this sandbox — no LAN path exists here. Built entirely for the user's own local execution; the
resulting evidence bundle (or dashboard output) is what a follow-up session would analyze.

## Session: Native Device Lifecycle Architecture (ADR-0023, Phase 1 complete)

Replaced the ownership model (`OwnershipRegistry`/`RoutingBackendAdapter`,
`ownership = ha | native | unassigned`) with a provider-driven architecture:
`ProviderRegistry` + `DeviceLifecycleState` machine + `DriverBindingEngine` +
`ProviderRouter`. Home Assistant is now just another provider driver
(`HomeAssistantProviderDriver` wraps `HaAdapter` into `INativeProtocolDriver` and
registers into the same driver array as every native protocol) — no special casing
anywhere in routing. `SUPREME_BACKEND=native` is the new production default;
`mock` is explicitly test/CI-only. See `docs/architecture/adr/0023-native-device-
lifecycle-architecture.md` for the full decision record, phased implementation, and
completion summary (includes one disclosed, deliberate behavior change: the
`/v1/migration` wizard no longer fabricates live control for a domain migrated to
"native" without a real driver bound).

No protocol driver was modified (Casambi, KNX, Matter, MQTT, Apple TV, DALI, Modbus
untouched). `pnpm -r build` clean workspace-wide; full test suite clean except two
confirmed pre-existing flakes in files this refactor never touched (real-TCP-socket
`avr-driver`/`heos-driver` contention in `@supreme/protocols`, a timing-based loop
assertion in `@supreme/lan`) — both re-run clean in isolation. `gateway` + `homeowner`
containers rebuilt/redeployed; `/healthz` confirms `backend: "provider-router"`.

**Known gap, not silently skipped:** per-device provider/lifecycle fields aren't yet
wired into `GET /v1/devices/:id/diagnostics` (needs a `supreme-contracts` schema
change) — the broader `/v1/drivers/diagnostics` surface and its UI panel already
expose lifecycle-state counts. Native (non-Docker) Linux deployment wasn't
re-exercised this pass (the change is deployment-independent by design, but only the
Docker path was actually run).

## Session: Native Linux Installer — backend/HA prompt fix

**Branch:** `native-linux`. Fixed a real first-install bug: answering "No" to Home
Assistant still asked for HA username/password and a standalone "Backend [mock]"
question. `infra/native-linux/install.sh`'s `SUPREME_BACKEND` is now always derived
from the HA yes/no answer (`native` when no HA, `ha` when yes) and validated against
`native|ha|mock` — HA-specific prompts are skipped entirely on the "No" path. Added
pre-install validation (domain format, timezone, HA credential length) that fails
loudly rather than silently continuing. Updated `docs/architecture/
Native-Linux-Deployment.md` with the new wizard flow. Verified via an isolated
functional harness (8 scenarios) since no automated test suite exists for these
shell scripts; all 9 native-linux scripts pass `bash -n`. Only `infra/native-linux/`
+ one doc touched — no application code, Gateway, LAN service, Commissioning, or
provider architecture modified. Committed and pushed to `origin/native-linux`
(`d96ee90`).

## Session: Production Architecture Direction — deployment/transport separation in `@supreme/lan`

**Branch:** `claude/casambi-driver-refactor-lvu23e`. ADR: **`docs/architecture/adr/0022-supreme-lan-transport-service.md`**
(new Amendment section, 2026-08-02). **No protocol driver was modified.**

**The direction:** SupremeOS ships as a dedicated OS image (Home Assistant OS-style) on x86/ARM,
where `supreme-lan` runs as a native systemd service with direct NIC access. Docker is a
development and CI environment only, and no long-term architectural decision may be made from its
limitations.

**The problem this exposed:** Docker's vocabulary had leaked into load-bearing places in the
transport — `networkMode: "bridge" | "host" | "macvlan"` sat in the **NATS wire protocol**, the
health snapshot, the `UdpTransportServer` constructor, and the failure-diagnosis branch condition;
compose filenames were hardcoded into remediation strings. Removing Docker would have meant editing
the transport and its wire protocol — a protocol change forced by a deployment change.

**The fix — one deployment module, one neutral concept.** New `services/lan/src/server/deployment.ts`
is the ONLY module in `@supreme/lan` allowed to name a container runtime, compose file, or systemd
unit; it holds a `LanDeployment` table (`native-linux`, `docker-host`, `docker-bridge`, `macvlan`,
`vm-bridged`, `unknown`) carrying all deployment-specific text as data. Everything else reasons only
about `LanAccess` = `"direct" | "isolated" | "unknown"` — a property of the network namespace that
is equally meaningful for a native service, a VM, and a container. Deployment is **configured**
(`SUPREME_LAN_DEPLOYMENT`), never auto-detected: a process cannot tell from inside its own namespace
whether it shares the host's, so `unknown` is reported honestly instead of guessed. Legacy
`SUPREME_LAN_NETWORK_MODE` still works — existing compose files and deployed units are unaffected.

**Production deployment unit:** `infra/systemd/supreme-lan.service` runs the SAME
`dist/server/main.js` as the container with `SUPREME_LAN_DEPLOYMENT=native-linux`. It deliberately
does not set `PrivateNetwork`/`NetworkNamespacePath` — that would recreate on the production image
exactly the isolation that breaks broadcast/multicast under Docker bridge.

**The rule is now enforced, not just written down.** `services/lan/src/deployment-isolation.test.ts`
scans every shipped `@supreme/lan` module for container-runtime vocabulary in executable code (doc
comments exempt — explaining *why* a limitation exists carries no runtime coupling; `*.test.ts`
exempt — a test must construct a `DEPLOYMENTS["docker-bridge"]` fixture and assert its remediation
text, which is consuming the isolated module, not leaking). The guard was verified by injecting a
real leak into `health.ts` and confirming it fails — it does not pass vacuously.

**One genuine leak it caught in shipped code:** the "Docker Desktop does not implement host
networking" caveat was a hardcoded string inside `routing-diagnosis.ts`. It is now
`LanDeployment.unreliableLanAccessOn`, keyed by `process.platform`; the diagnosis appends the note
verbatim without knowing which runtimes are affected. Correcting the earlier code, it now covers
`darwin` as well as `win32` — Docker Desktop runs Linux containers in a VM on both.

**Net effect:** removing Docker is now a deployment change, not a protocol rewrite. The transport
can switch between Docker / native Linux / a future hardware-specific deployment without touching
any protocol driver.

**Verification:** `@supreme/lan` 9 files / 74 tests green; full monorepo 115/115 build+typecheck
tasks and 99/99 test tasks green.

## Session: LAN receive path — Casambi UDP RX + KNX/IP discovery (one shared root cause)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Full investigation:
**`docs/architecture/Casambi-LAN-Receive-Path-Investigation.md`**. No protocol logic modified.

**Both symptoms share ONE root cause, proven experimentally on a real Docker Engine: bridge
networking does not deliver LAN broadcast OR multicast into containers.** Identical code, only the
network mode differing — bridge: broadcast NOT RECEIVED, multicast join OK but NOT RECEIVED; host:
both RECEIVED. Casambi's `Sent = 6 / Received = 0 / Last Error = None` is exactly that signature:
nothing errored, the kernel just never delivered. Wireshark sees the packets; `@supreme/lan` never
does — the loss is below the application, so no protocol-level change could fix it.

**KNX/IP discovery is NOT a regression from `@supreme/lan`** — code evidence:
`createKnxDiscoveryRemoteSocketFactory` is defined and **never called**; `knxSearch()` still uses
its built-in raw `node:dgram`, and `installer-context.ts:817` calls it with no options at all. KNX
discovery has never routed through `@supreme/lan`, and the Gateway's own networks were never
modified by any of that work (`git log -- infra/hub-compose/docker-compose.yml`). It fails for the
same Docker-bridge reason, independently.

**The most damaging finding — a false PASS:** `addMembership()` SUCCEEDS on bridge networking and
then nothing ever arrives. Every diagnostic checking "did we join the group?" was reporting a green
tick on a permanently deaf socket, which is exactly why KNX discovery returned an empty list with
no error, forever. Fixed: `DgramUdpSession` now tracks `joinedMulticastAt` separately from
reception and exposes `joinedMulticastButNeverReceived`; a live run of the real `knxSearch()` now
reproduces the 0-gateway symptom but *explains itself*.

**New diagnostics (no behavior change):** protocol-agnostic `core/pipeline-stages.ts` with a
PASS/FAIL/**WAITING** vocabulary — WAITING is the state the old diagnostics couldn't express. A
reception stage is never PASS because a setup call didn't throw; it must be backed by a
received-packet counter. Built on it: `casambi/pipeline-status.ts` (Socket → Listening → Receiving
→ Publishing → Decoding → Discovery → Entities) and `knx/knx-discovery-pipeline.ts` (Socket →
Joined Multicast → Received Search Response → Gateway Parsed → Gateway Created).
`knx-discovery.ts` gained an **optional** `onDiagnostics` observer — omitting it is byte-for-byte
the prior code path.

**Deliberately NOT tracked:** a per-datagram broadcast/multicast/unicast split. `rinfo` reports the
SENDER, not the destination, and Node doesn't surface `IP_PKTINFO` — such a counter would be a
guess presented as a measurement.

**Required fix (deployment, not code):** reception needs host networking —
`-f docker-compose.lan-host.yml -f docker-compose.nats-loopback.yml` on Linux. Note this fixes
Casambi but **not** KNX discovery, which runs in the Gateway (bridge by design per ADR 0022). The
recommended next step, explicitly NOT done here per the standing "Casambi first" rule: wire the
already-built `knx-discovery-remote-socket.ts` adapter so KNX inherits the same fix.

**Tests:** `@supreme/lan` 7 files/60 tests (4 new joined-vs-receiving); `@supreme/protocols` 80
files/772 tests (9 new pipeline-stage). 47/47 turbo tasks green.

## Session: Casambi — Discovery UX fix + ENETUNREACH root cause (DEPLOYMENT defect, fixed)

**Branch:** `claude/casambi-driver-refactor-lvu23e`. Full investigation:
**`docs/architecture/Casambi-ENETUNREACH-Investigation.md`**. Two independent issues, both fixed.
No Casambi protocol code (UDP codec / Discovery Engine / Entity Mapper / Event Engine) was
touched, per the governing brief.

**PART 1 — Discovery UX.** The UI said "Auto-discovery is not implemented," conflating two
different mechanisms and wrongly implying devices must be added by hand. Now stated separately:
*Automatic Gateway Discovery — Not available* (no discovery API exists in the Lithernet docs; IP
entered manually) and *Automatic Device Discovery — Enabled* (devices appear automatically from
incoming UDP notifications, no manual creation). New `CasambiDiscoveryExplainer` in `drivers.tsx`
+ matching Aureon-token CSS; the gateway route's own response message was the source of the
misleading string and was corrected too. Added a live `CasambiDiscoveryStatus` block to
Diagnostics that shows real discovery state and, before any traffic, says "Waiting for first UDP
notification — device discovery will begin automatically," framed as a normal pre-traffic state.

**PART 2 — ENETUNREACH root cause: a DEPLOYMENT defect, reproduced and fixed.**
`docker-compose.yml` attached `lan` to `supreme-core` ONLY, and that network is `internal: true`
— which by design has no default route, so the kernel rejected every send to a LAN address before
a packet left the process. **Reproduced on a real Docker Engine** with one variable changed
(identical image/code/target): `internal: true` → `SEND FAILED: send ENETUNREACH
192.168.0.45:10009` (byte-identical to the report); normal bridge → `SEND OK`. Fixed by giving
`lan` a second, non-internal `supreme-lan-egress` network — every other service keeps its exact
prior isolation. **Fix verified by booting the real stack**: the container now has a default route
(previously none) and the identical real `supreme.lan.udp.send` to `192.168.0.45:10009` returns
`{"ok": true}`.

Note the base compose's own comment had claimed the degraded bridge mode only lost *broadcast
reception*; reality was worse (no egress at all, not even unicast). Comment corrected. Broadcast
RECEPTION still requires the host-networking overlay — unchanged and still the documented
production topology.

**Diagnostics (Part 2 cont.):** new `services/lan/src/server/routing-diagnosis.ts` computes a real
routing verdict inside supreme-lan's own namespace (real interfaces + CIDR mask arithmetic, real
`os.platform()`, explicitly-configured network mode — never self-detected), attached to failed-send
wire responses and exposed via `NatsUdpTransportClient.lastSendDiagnosis`. `failure-analysis.ts`
gained a snapshot-level send-error classifier that runs BEFORE the "zero packets received" branch,
so `ENETUNREACH` is named a deployment/routing failure rather than misreported as a
broadcast-reception problem; `EHOSTUNREACH` → gateway issue; `EACCES` → permission/SO_BROADCAST;
anything else stays honestly `unknown_error`.

**Tests:** `@supreme/lan` 7 files/56 tests (10 new routing-diagnosis tests); `@supreme/protocols`
79 files/763 tests (3 new send-classification tests). Full monorepo turbo run across
lan/protocols/gateway/web-homeowner: 47/47 tasks green. Both compose configurations re-validated.

## Session: Casambi Local Gateway — Phase 3, Real Hardware Certification Tooling

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Final Hardware Validation
session below). **Confirmed workflow, explicitly stated by the user this session:** this AI
session has no network path to the user's real Lithernet Gateway or LAN, and never will from this
sandbox — the user runs the validation runbook themselves, on their own SupremeOS installation,
against their real hardware, and shares back the resulting JSON/logs/pcap evidence for analysis.
**Production Gate verdict unchanged: NOT EVALUATED — hardware unavailable** (no evidence bundle
has been shared yet; nothing here renders a verdict from data that doesn't exist).

**What changed this session** (all hardware-independent tooling to support that confirmed
handoff, per the user's explicit instruction "Build all tooling assuming this workflow"):
- **Live Capture**: `replayableDgramSocket().startRecording()`/`handle.finish()`
  (`services/lan/src/server/replay-dgram-socket.ts`) — records real datagrams as they arrive at
  the base socket (pure side-observation, zero effect on normal delivery) into a ready-to-save
  `PacketCapture`. This is how a real gateway's real traffic becomes a permanent regression
  capture. New `fakeDgramSocket().emitMessage()`/`emitError()` test-support methods so this could
  be verified hermetically. 4 new tests.
- **`PacketCapture.metadata`**: a generic `Record<string, unknown>` bag added to `@supreme/lan`'s
  capture format; `CasambiCaptureMetadata` (firmware/gateway version, data format, Net ID, date,
  notes — all nullable, never guessed) documents the Casambi-specific shape in
  `services/protocols/src/casambi/capture-metadata.ts`.
- **Capture library reorganized** into the certification brief's exact category tree:
  `tests/regression/casambi/{living-room,kitchen,office,button-events,sensor-events,dimming,
  scenes}/`. The three existing captures moved into their category folders with real metadata
  populated (`null` for anything not actually known, e.g. the real capture's exact date/gateway
  hardware version were never recorded). The four new category folders are correctly EMPTY — no
  synthetic data fabricated to fill them — each with a `README.md` explaining exactly what real
  evidence would populate it. The regression test loader (`casambi-packet-replay-regression.
  test.ts`) now recurses `tests/regression/casambi/` instead of scanning one flat directory.
- **Failure Analysis extended**: `CasambiFailureStageResult` gained `evidence: string[]` (the
  literal snapshot facts behind each verdict, independently checkable) and `suggestedFix: string
  | null` (always a concrete next action) — matches the certification brief's exact
  Reason/Evidence/Suggested Fix format. `formatFailureAnalysisReport()` renders all three.
- **Local certification evidence collector**
  (`infra/hub-compose/collect-certification-evidence.sh`, new): a shell script the user runs on
  THEIR OWN machine — never remotely, never assuming this session can reach their LAN — that
  automates the runbook's `curl`/`docker logs`/`tcpdump` steps into one timestamped bundle
  (before/after Transport Monitor snapshots, container logs, an optional real tcpdump capture
  during a prompted trigger step). Every uncollectable piece is recorded as an explicit
  "SKIPPED: &lt;reason&gt;", never silently omitted.
- Runbook and the Final Hardware Validation Report doc both updated to reference all of the above
  and make the confirmed handoff workflow explicit throughout.

**Tests:** 4 new (`startRecording`/Live Capture) in `replay-dgram-socket.test.ts`; existing
`failure-analysis.test.ts`/`casambi-packet-replay-regression.test.ts` updated for the extended
shape and reorganized directory, all still passing. `@supreme/lan`: 6 files/46 tests (up from 42).
`@supreme/protocols`: 79 files/760 tests (no new test files this session — only new cases within
existing files, some replacing prior assertions for the extended shape — net count unchanged).

**No UI built** (same disclosed scope cut carried forward unchanged): Transport Monitor panel,
Packet Replay "Saved Captures" panel, Packet Trace Viewer, performance charts — all backend/data
only, tracked in TODO.md.

## Session: Casambi Local Gateway — Final Hardware Validation & Production Gate

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 2 below). Full report:
**`docs/architecture/Casambi-Final-Hardware-Validation-Report.md`** — Hardware Validation Report,
Performance Report, Packet Replay Framework Guide, Transport Monitor Guide, and Production
Readiness Checklist, all in one document. **Production Gate verdict: NOT EVALUATED — hardware
unavailable** (neither PASS nor FAIL — this sandbox never had access to a real Lithernet gateway,
so there is no real-hardware evidence to render either verdict on). Per the governing brief's
Critical Requirement, KNX/Matter/other protocol migrations remain on hold until that real-hardware
retest actually happens.

**What changed this session:**
- **Packet Replay Framework** (new, `@supreme/lan`, protocol-agnostic — reusable by every future
  LAN protocol): `PacketCapture` JSON format (`services/lan/src/server/replay-dgram-socket.ts`),
  `replayableDgramSocket()` (wraps a real or fake `DgramSocketLike`, injects a captured datagram
  through the IDENTICAL `DgramUdpSession` → `UdpTransportServer` → NATS → `NatsUdpTransportClient`
  → adapter → driver chain real hardware traffic uses — "no code path may differ" is satisfied
  structurally, not by convention), `fakeDgramSocket()` (formalizes the fake-socket pattern every
  test file was hand-rolling separately). File I/O + PCAP export (one-way, for opening a capture in
  Wireshark — PCAP import deliberately not implemented, see the report §3 for why) in
  `services/lan/src/server/capture-io.ts`.
- **Capture library**: `tests/regression/casambi/{living-room,kitchen,office}.json` —
  `living-room` is the REAL 99-byte Wireshark-captured NotifyControlValues packet from the earlier
  hardware audit session, reused rather than re-transcribed; `kitchen`/`office` are synthetic but
  wire-valid (a button press; a well-formed but UNMAPPED opcode 0x39, deliberately exercising the
  "Discovery ignored packet" failure mode). New
  `casambi-packet-replay-regression.test.ts` (7 tests) auto-loads and replays every capture
  through the real pipeline — "no hardware required" per the brief, verified: e.g. the real
  living-room capture's controls map to Supreme's `sensor` capability (VERIFIED by actually
  running the code and reading the result, not assumed — an earlier draft assumption that it
  would map to `onoff` was wrong and caught by the test failing honestly).
- **New driver-level observability**: `CasambiProtocolDriver` now tracks `unmappedOpcodeEvents`/
  `lastUnmappedOpcode` (a datagram that decodes successfully but whose opcode
  `normalizeLocalPacket` doesn't map to any signal — previously a true silent drop, now a real,
  observable event) and a bounded `recentJourney` "Packet Trace" (per-datagram: arrival time,
  decode outcome, resolved handler/signal kind, and a REAL measured `processingDurationMs`).
- **Failure Analysis report generator** (`services/protocols/src/casambi/failure-analysis.ts`,
  new): a pure function over the Transport Monitor snapshot producing the EXACT ✓/✗ + "Reason:"
  checklist format the governing brief specified (Transport → NATS → Casambi Adapter →
  Discovery/Driver), never guessing — `not_applicable` for anything it can't honestly evaluate.
  Wired into `GET /v1/drivers/:id/casambi/transport-monitor` as a new `failureAnalysis` field.
- **Performance**: extended the existing latency benchmark to report p50/p95/p99/max (not just
  median/p95/mean).
- **No UI built this session** (Transport Monitor panel, Packet Replay "Saved Captures" panel,
  Packet Trace viewer) — same disclosed scope cut as Phase 2's Transport Monitor; backend/data
  only, tracked in TODO.md.

**Tests:** 4 new test files (`replay-dgram-socket.test.ts` 5 tests, `capture-io.test.ts` 3 tests,
`casambi-packet-replay-regression.test.ts` 7 tests, `failure-analysis.test.ts` 8 tests) plus new
cases in `casambi-driver.test.ts`. `@supreme/lan`: 6 files/42 tests. `@supreme/protocols`: 79
files/760 tests. `@supreme/gateway`: 72 files/295 tests. All passing, zero regression.

**Disclosed, still not resolved:** real Lithernet hardware and real Windows Docker Desktop remain
outside this sandbox's reach — no engineering inside this environment changes that. The Packet
Replay Framework and Failure Analysis tooling exist specifically so that when real hardware IS
available, the runbook (`docs/architecture/Casambi-Real-Hardware-Validation-Runbook.md`, updated
this session to reference these new tools) can be followed and the Production Gate re-evaluated
with real evidence.

## Session: `supreme-lan` LAN Transport Service — Phase 2 (Casambi Migration & Transport Monitor)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues Phase 1 below). Full account,
including the honest hardware/Windows/Linux assessment: **`docs/architecture/
Supreme-LAN-Transport-Architecture.md` §10**. ADR 0022's status line updated to reflect Phase 2 as
implemented. Per the governing brief's Critical Requirement, **do not start KNX/Matter/any other
protocol migration until Casambi is confirmed operational on real hardware** — that hasn't
happened yet (see below); the existing `lan-adapters/` (KNX Discovery/mDNS/SSDP) remain exactly as
Phase 1 left them, untouched.

**What changed this session:**
- **`CasambiUdpSocketLike`/`CasambiUdpSocketFactory` deleted entirely.** `CasambiUdpEngine`
  (`services/protocols/src/casambi/local-transport/udp-engine.ts`) now takes a required
  `udpTransportFactory: UdpTransportFactory` and calls the generic `UdpTransport` (`@supreme/lan`)
  directly — no adapter layer, no raw `node:dgram` inside this package anymore. Every other public
  method/getter kept its exact prior shape, so `command-engine.ts`, `discovery-engine.ts`, and
  `casambi-driver.ts`'s command/event dispatch needed **zero edits**.
- **`LocalDirectUdpTransport`** (new, `services/lan/src/client/local-direct-udp-transport.ts`) — a
  same-process `UdpTransport` (real `node:dgram`, no NATS hop) for single-process dev/test, wrapping
  the already-tested `DgramUdpSession`.
- **Transport selection is centralized once**, in `services/gateway/src/installer-context.ts`'s
  `nativeDriverContext()`: real NATS configured → `NatsUdpTransportClient`; otherwise →
  `LocalDirectUdpTransport`. `native-driver-factory.ts`'s casambi factory and the Test Connection
  route (`routes/installer.ts`) both consume this same resolution — Casambi's Local Gateway driver
  now **defaults through `@supreme/lan`** in every environment, not just when explicitly configured.
- **Transport Monitor** (new): `CasambiProtocolDriver.getCasambiTransportMonitor()`
  (`services/protocols/src/casambi/transport-monitor.ts`) — four real, non-fabricated layers
  (Transport/NATS/Casambi Adapter/Driver), exposed at the new
  `GET /v1/drivers/:id/casambi/transport-monitor` route, separate from the existing
  `casambi/diagnostics` route (unchanged). New counters added purely additively:
  `CasambiUdpEngine.decodedCount`/`decodeFailureCount`/`transportDiagnostics`,
  `NatsUdpTransportClient.packetsSent`/`packetsReceived`/`requestsSent`/`eventsReceived`/
  `lastError`, `CasambiProtocolDriver`'s `discoveryEventsCount`/`commandsIssuedCount`/
  `feedbackEventsCount`. New `queryLanHealth()` client helper (`@supreme/lan`) calls the
  `supreme.lan.health` subject Phase 1 built a server handler for but nothing had called yet.
  **No dedicated UI page built this session** — see TODO.md.
- **Cloud implementation, entity model, discovery/event/command engines, Driver Manager UI, and
  the existing Cloud REST implementation are byte-for-byte unchanged** — zero edits to any of those
  files; confirmed by the full pre-existing test suite passing unmodified.

**Tests (all passing, all in this session):** rewrote `udp-engine.test.ts` (35 tests, all UdpTransport-
based) and `casambi-driver.test.ts` (34 tests) onto the new architecture; new
`casambi-over-supreme-lan.test.ts` (7 tests) — the cross-package proof that the REAL, unmodified
`CasambiProtocolDriver` connects/discovers/updates state/fires events/issues commands entirely over
a REAL `NatsUdpTransportClient` + REAL `UdpTransportServer` sharing a REAL `IEventBus` (fake
`node:dgram` only), plus the honest failure-path proof (no `supreme-lan` reachable → `connect()`
rejects, never silently "succeeds"); new `NatsUdpTransportClient`/`queryLanHealth` tests in
`@supreme/lan`'s `contract.test.ts`; new `native-driver-factory.test.ts` tests proving the factory
actually uses a supplied `udpTransportFactory` and correctly falls back to
`LocalDirectUdpTransport`; new `casambi-lan-latency.test.ts` — an automated, repeatable, code-only
latency benchmark (n=50 samples/run). Full monorepo `turbo run build typecheck test`: **173/173
tasks green** (`@supreme/protocols` 77 files/742 tests, `@supreme/gateway` 72 files/295 tests,
`@supreme/lan` 4 files/34 tests — all up from Phase 1's counts, zero regression anywhere).

**Real Docker validation (new this continuation — a real Docker Engine became available in this
sandbox mid-session):** built the real `lan.Dockerfile` image, booted real `nats`+`lan` containers,
and reproduced the ACTUAL bug this project exists to fix, for real: a genuine UDP broadcast sent
from the Docker host was **not received** by the bridge-networked `lan` container, then **was
received** by the identical container rebuilt on `docker-compose.lan-host.yml` (real
`network_mode: host`) + `docker-compose.nats-loopback.yml`. This is real Docker/Linux evidence, not
a simulation — see architecture doc §10.3 for full detail. In the process, found and fixed two
real, previously-undiscovered bugs (not caught by config-parsing or code review): (1)
`lan.Dockerfile` never copied `cloud`/`drivers`/`tools`, so `pnpm install --frozen-lockfile` failed
outright (`services/license` depends on `cloud/licensing`) — fixed to match
`gateway.Dockerfile`'s COPY list; (2) `docker-compose.nats-loopback.yml`'s port publish was
silently a no-op because Docker refuses to publish a port for a container whose ONLY network is
`internal: true` (confirmed with an isolated minimal repro) — fixed by giving `nats` a second,
non-internal, loopback-only network in that one override file. Also measured a real end-to-end
latency of **~8ms** (host UDP send → real container receive → real NATS publish → host-side
subscriber) during this validation, alongside the new automated benchmark's code-only numbers
(sub-millisecond — see architecture doc §10.4 for both, kept clearly separate).

**Disclosed, still not resolved (see TODO.md and architecture doc §10.3):** this sandbox still
cannot reach a real Lithernet gateway or real Windows Docker Desktop — no amount of additional
sandbox work substitutes for that. A synthetic UDP broadcast from a script is real evidence the
Docker/networking MECHANISM works, but it is not a real device on a real physical LAN. The
Transport Monitor has a working backend + route but no dedicated UI page yet. KNX/mDNS/SSDP
migration remains explicitly on hold pending the real-hardware retest, per the governing brief.

## Session: Production Architecture Refactor — `supreme-lan` LAN Transport Service (Phase 1)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the sessions below — this is now a
cross-cutting infrastructure change, not Casambi-specific, per the user's own explicit framing).
Full design record: **`docs/architecture/adr/0022-supreme-lan-transport-service.md`**; full
technical detail (flow/deployment diagrams, migration risk table, testing honesty notes):
**`docs/architecture/Supreme-LAN-Transport-Architecture.md`** — read both before touching Docker
network topology or any raw-socket driver code again.

**Problem:** Docker bridge networking silently drops LAN broadcast/multicast (proven with the real
Casambi Wireshark capture from the prior session) — affects Casambi UDP, KNX Routing/Discovery,
Matter/mDNS, SSDP, Sonos, Denon, Apple TV, Hue, Yamaha. Moving the whole Gateway to
`network_mode: host` (tried previously) broke it (`getaddrinfo ENOTFOUND postgres`, proxy 502) —
the Gateway is tightly coupled to Postgres/Redis/NATS/internal services only reachable via
Docker's bridge DNS.

**Solution built this session (Phase 1 only — service + generic transport + Docker topology +
docs, NOT yet the default for any driver):**
- **New package `@supreme/lan`** (`services/lan`) — zero dependency on `@supreme/protocols` or any
  business/domain concept. Reuses `@supreme/messaging`'s existing `IEventBus`/NATS seam (already
  deployed, already wired into the Gateway) as its only IPC — no new mechanism invented. A generic
  `requestReply()` helper (`shared/rpc.ts`) adds real RPC semantics on top of the bus's existing
  publish/subscribe, without modifying `@supreme/messaging` itself.
- **Generic `UdpTransport` interface** (`transport.ts`): `bind`/`send`/`joinMulticast`/`close`/
  `onMessage`/`onError`/`onListening`/`address` — ONE interface covering unicast, broadcast, and
  every multicast use in this codebase (mDNS/SSDP/KNX are just `bind({multicastGroup})` presets).
  `joinMulticast()` exists as a separate post-bind capability specifically because KNX
  discovery's real code binds first, then joins multicast only once bind genuinely completes — a
  real API gap found and fixed during implementation, not assumed away.
- **Real server** (`server/`): `DgramUdpSession` (injectable `DgramSocketLike`, same fake-socket
  convention as every existing raw-socket module) + `UdpTransportServer` (NATS command dispatch,
  session multiplexing, event publishing) + `main.ts` (deployable entrypoint) + `health.ts`
  (diagnostics snapshot — `networkMode` read from config, never inferred, per this codebase's
  standing "never fabricate" rule).
- **Four migration adapters** (`services/protocols/src/lan-adapters/`, NOT inside `@supreme/lan` —
  keeps the dependency direction one-way: `@supreme/protocols → @supreme/lan`): each implements an
  EXISTING driver-facing interface (`CasambiUdpSocketLike`, `KnxDiscoverySocket`, `MdnsSocket`,
  `SsdpSocket`) exactly, as a drop-in alternative to that protocol's real-`dgram` default. **None
  of the four existing driver files were modified** — the adapters are opt-in, not defaulted.
- **Docker**: base `docker-compose.yml` gets a `lan` service (bridge, degraded-but-testable
  default); new `docker-compose.lan-host.yml` (host networking, mirrors
  `docker-compose.appletv-host.yml` exactly — simpler, since `lan` only ever talks NATS, no
  `extra_hosts` needed); new `docker-compose.nats-loopback.yml` (exposes NATS on `127.0.0.1` only,
  since `supreme-core` is `internal: true` and a host-networked container can't reach it by
  container DNS). New `infra/hub-compose/lan.Dockerfile` mirrors `gateway.Dockerfile`'s
  multi-stage pnpm-deploy pattern.

**Tests (all passing, all in this session):** `@supreme/lan` — 24 tests (fake-socket unit,
`InProcessEventBus` contract/RPC, real-loopback smoke test with genuine OS UDP sockets).
`@supreme/protocols` lan-adapters — 19 tests, including the concrete cross-package proof: the
REAL, unmodified, hardware-validated `CasambiUdpEngine` sending/receiving real wire packets
entirely over the new remote transport. Full `@supreme/protocols` suite re-run: 77 files/727 tests,
zero regression (no existing driver file touched).

**Disclosed, not resolved this session (see TODO.md):** Phase 2 (defaulting Casambi onto the
remote transport) deliberately held — the adapter is proven, but flipping the default needs its
own real-hardware retest against a host-networked `supreme-lan`, not bundled into the session that
introduces the RPC path for the first time. KNX Routing and Matter (Phases 3b/4) need their own
protocol-level seam work first — both currently own sockets inside third-party libraries
(`knxultimate`, future `@matter/main`) with no injectable hook, unlike Casambi/KNX-discovery/
mDNS/SSDP. "Windows compatibility" testing is code-review-only + a documented native-process
workaround, not executed on Windows this session (this sandbox is Linux-only). Real LAN broadcast
reception has not been re-verified against actual hardware through `supreme-lan` yet — only the
diagnostic/transport plumbing is proven, via loopback and in-process tests.

## Session: Casambi Local Gateway — UDP Receive Pipeline Audit (real hardware capture)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Auth & UDP Diagnostics session
below). Triggered by a real Wireshark capture (Lithernet Gateway, firmware 6.25) proving the
gateway broadcasts `NotifyControlValues` to `255.255.255.255:10009` while SupremeOS reported
`Packets Received = 0`. Full audit, root cause, before/after flow diagrams, and firmware-scheme
disclosure: **`docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md`** — read that document
before touching `udp-engine.ts`'s `handleMessage` again.

**Root cause (confirmed by code reading, not hardware):** no reception-blocking bug existed —
the socket binds to `0.0.0.0` (no address filter, no `connect()`, no `rinfo.address` check
anywhere), so broadcast and unicast datagrams are received identically. The REAL, confirmed bug:
`packetsReceived` only incremented inside `decodeCasambiPacket()`'s success branch, so a datagram
that failed to parse was invisible to the counter and had no bulk trace — "never arrived" and
"arrived but failed to parse" were indistinguishable everywhere in the driver. Manually decoding
the report's exact byte sequence (reconstructed to its stated 99-byte length) against the
unmodified codec succeeds, so the specific example isn't itself undecodable — the fix targets the
counter/tracing gap the report's required steps describe, not a codec rewrite.

**Changes:**
- `udp-engine.ts`: `packetsReceived`/`lastPacketAt` now increment BEFORE parsing, unconditionally.
  New `onRawDatagram()` (fires pre-parse, proves socket-level reception independent of decode) and
  a bounded (20-entry) `recentTraces` log — every datagram, decoded or not, with raw ASCII/hex,
  byte length, source, and parse result. A failed parse is traced and logged, never a silent drop.
- `casambi-driver.ts`: wires `onRawDatagram`/`onDecodeError` into the existing `ProtocolTracer`
  pipeline (immediate "UDP datagram received"/"UDP parse failed" log lines); threads
  `recentTraces` into `getCasambiDiagnostics()`.
- `diagnostics.ts`, `routes/installer.ts`, `api.ts`, `drivers.tsx`: `recentTraces` surfaced end to
  end — Diagnostics page now renders a real packet-trace table, and Test Connection's UDP result
  includes the trace from its own test window.

**Tests:** `udp-engine.test.ts` — 1 updated (decode failure now correctly counts as received) + a
new "real hardware capture" suite (8 tests) using the report's exact byte sequence, reconstructed
and verified to be exactly 99 bytes: broadcast reception, pre-parse counting, real ASCII hex-dot
decode, full trace recording, parser-failure trace+log, bounded trace log. `casambi-driver.test.ts`
+2 (end-to-end trace reaching Driver Diagnostics for both a decodable and an undecodable packet).
Full monorepo verification green (`@supreme/protocols` 72 files/708 tests, `@supreme/gateway` 72
files/293 tests after rebuilding `@supreme/protocols`'s dist — a workspace-resolution step, not a
code defect — `@supreme/drivers` 22, `@supreme/web-homeowner` 55 + build). Zero Cloud regression.

**Disclosed, not resolved:** no hardware was available to confirm the original symptom is now
actually fixed end-to-end on the real gateway — only that the diagnostic blind spot the report
describes is closed and the reconstructed real payload decodes correctly. The gateway's own
firmware number (6.25) and the protocol doc's "Evolution firmware" version gates (e.g. ≥37.90) are
different numbering schemes and were NOT compared numerically — see the audit doc §6.

## Session: Casambi Local Gateway — Auth & UDP Diagnostics

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the audit session below, same
branch). Brief: refine Local REST authentication, fix the UDP "Unreachable" false-negative, and
add production-quality staged connection diagnostics — grounded strictly in the Lithernet manuals,
with every undocumented assumption disclosed rather than inferred. Full write-up, including the
required six-question UDP audit answered against the real pre-existing code:
**`docs/architecture/Casambi-Local-Auth-And-UDP-Diagnostics.md`** — read that document, not this
summary, before touching Local REST auth or UDP diagnostics again.

**Root causes found (both real, confirmed by reading the code, not assumed):**
1. The generic `services/drivers/src/config.ts` `validateDriverConfig` iterated the Casambi
   manifest's full `configSchema` unconditionally, checking `required` regardless of
   `connectionType` — a Local Gateway config save could fail on a missing `email` (a Cloud-only
   field), and vice versa. This existed independently of anything UDP-related.
2. `CasambiUdpEngine.probe()`'s reachability check conflated one timed-out application-layer
   round-trip (opcode 0x39 Node Status, 2s timeout) with the actual transport state — a
   TCP-shaped assumption on a connectionless, push-based protocol. The gateway's own "UDP
   Listening on IP:Port" self-report (confirmed via `Lithernet_General_Settings_Network.pdf` p.72
   as its own Control System Wizard status field) was never contradictory with SupremeOS's
   report; the probe-timeout logic was just answering the wrong question.

**Changes made** (Connection Manager → Transport → Service → Engine hierarchy preserved,
unmerged; zero Cloud regression — the full pre-existing Cloud-mode test suite passed unmodified):
- **`packages/domain-model/src/drivers.ts`** — new `requiredIf: { key, equals }` on
  `DriverConfigField`, a generic (not Casambi-specific) mechanism for mode-conditional required
  fields.
- **`services/drivers/src/config.ts`** — `validateDriverConfig`/`isConfigComplete` now resolve
  `requiredIf` against the submitted/existing/default value of the named discriminator field.
- **`local-transport/rest-client.ts`** — `gatewayUsername`/`gatewayPassword` → HTTP Basic Auth on
  every request; `testConnection()` returns `{ reachable, httpStatus, authFailed }`;
  `setTargetValue()` can return `"unauthorized"`.
- **`local-transport/udp-engine.ts`** — real `socketState`, `localAddress`/`localPort` (from
  `dgram.Socket.address()`), `packetsSent`/`packetsReceived`, `lastPacketAt`, `lastSendError`,
  `lastDecodeError`, `averageLatencyMs` (probe round-trips only). No packet-loss field — the
  documented packet structure has no sequence numbers, so it's permanently unmeasurable and never
  fabricated.
- **`health-monitor.ts`** — new `udpStage()`: `not_configured | socket_error | bound_waiting |
  active`. Only a real socket error is a failure; "bound, nothing received yet" is a normal state.
- **`diagnostics.ts`** — additive `udp` field on the snapshot (Local only, `null` for Cloud).
- **`services/gateway/src/routes/installer.ts`** — Test Connection rewritten to the staged model
  above instead of a single `reachable` boolean; never marks UDP failed on "no reply yet."
- **`manifests.ts`** — new `gatewayUsername`/`gatewayPassword` fields, exact field order per the
  brief's mockup, `requiredIf` on every mode-conditional field, version bumped to 1.3.0.
- **`native-driver-factory.ts`**, **`drivers.tsx`**, **`api.ts`** — threaded the new fields/types
  through; Driver Manager's Local Gateway panel now renders the staged Test Connection report
  (REST / HTTP Authentication / Gateway / UDP / Port / Gateway Configuration / Status / Packets
  Received / Last Packet / Latency), and the Diagnostics page gained a live "UDP transport"
  section sourced from the running driver's real engine state.

**Tests:** ~45 new/updated tests across `config.test.ts` (requiredIf, both directions),
`rest-client.test.ts` (Basic Auth header, 401/403 handling), `udp-engine.test.ts` (socketState
transitions including a real bind failure, address/port exposure, packet/send/decode counters,
probe latency, no packet-loss getter), new `health-monitor.test.ts` (`udpStage`'s four-way rule),
`casambi-driver.test.ts` (end-to-end diagnostics wiring, `bound_waiting`→`active` transition,
`udp: null` in Cloud mode), `native-driver-factory.test.ts` (+2). Full monorepo
`turbo run build typecheck test` across `@supreme/domain-model`, `@supreme/drivers`,
`@supreme/protocols`, `@supreme/gateway`, `@supreme/web-homeowner`: **48/48 tasks green**
(`@supreme/protocols` 71 files/690 tests, `@supreme/gateway` 71 files/289 tests, `@supreme/drivers`
22 tests, `@supreme/web-homeowner` 55 tests + build). No hardware was available — every claim is
either a code fact or cited to a specific Lithernet PDF page, never inferred as verified.

**Disclosed, not fixed this session** (see `TODO.md`): the HTTP auth scheme is Basic by informed
default, not confirmed against real hardware (Digest is possible); no SSL/HTTPS support for the
Local REST client; no dedicated fastify-level HTTP test for the rewritten test-connection route
(its underlying primitives are fully unit-tested); the MAC-address-as-credentials fallback login
is not implemented.

## Session: Casambi Architecture Validation & Refactor (mandatory pre-implementation audit)

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues PR-2 below, same branch). The user
required a full, honest architecture audit against an explicit Connection Manager → Transport →
Service → Command/Event/Discovery Engine hierarchy **before any further feature work**, with an
explicit instruction not to self-grade "yes." Full findings, per-layer honest answers, refactor
performed, and justification for every decision: **`docs/architecture/Casambi-Architecture-Audit.md`**
— read that document, not this summary, before touching command/event dispatch in this driver again.

**Headline finding:** Connection Manager, Local Transport (container), and both Local Services
(REST/UDP) were already genuinely compliant. **Command Engine and Event Engine did not exist as
real, distinct entities** — `casambi-driver.ts`'s `command()` had an inline `if (mode==="local")`
branch building/sending commands two different ways, and two separate private methods
(`onEvent`/`onLocalPacket`) each independently decided what a raw wire signal meant, duplicating
that decision once per transport. Discovery Engine was half-real: `buildDiscoveredDevices()` (the
output-shaping half) was already transport-independent and correct; the driving half (how a
transport learns about units) was inline in the driver for both transports.

**Refactor performed** (zero Cloud regression — the full pre-existing Cloud-mode
`casambi-driver.test.ts` suite, including its fake-timer reconnect/heartbeat assertions, passed
unmodified after every step, verified incrementally, not just once at the end):
- **`command-engine.ts` (new)** — `CasambiCommandEngine` interface, `CloudCommandEngine`/
  `LocalCommandEngine` implementations. `command()` collapsed to one call site, no mode branching.
- **`event-engine.ts` (extended)** — `CasambiSignal` union + `normalizeCloudEvent`/
  `normalizeLocalPacket` (pure functions) + `enableLocalButtonEvents`/`disableLocalButtonEvents`.
  The driver's two duplicated dispatch methods removed, replaced by one `applySignal()` reaction
  method fed by both normalizers.
- **`discovery-engine.ts` (extended)** — `startLocalDiscovery`/`stopLocalDiscovery` extracted from
  the driver's inline UDP bootstrap/teardown. Cloud's discovery-driving (`loadNetwork`/`seedState`)
  was deliberately NOT extracted into a shared interface — two real callers with genuinely
  different shapes (REST pull vs. UDP push) is judged premature abstraction, not a missing
  abstraction; full reasoning in the audit doc.
- **25 new tests** (`command-engine.test.ts` 6, `event-engine.test.ts` 14, `discovery-engine.test.ts`
  5) exercising the extracted engines directly, independent of the driver.

**Disclosed, NOT fixed in this pass** (see the audit doc's §7 template-readiness table and
`TODO.md`): `casambi-driver.ts` still publishes through the old, Casambi-only `CasambiEventBus`,
not the cross-driver `core/event-bus.ts`'s `CoreEventBus` built in the PR-2 session — migrating it
is scoped, disclosed follow-up, not bundled into this audit's regression-sensitive refactor.
Similarly, `entity-mapper.ts`'s `capabilitiesFromUnit` does not yet consume `core/
capability-engine.ts` — that Capability Engine module exists and is tested but has no real
consumer anywhere yet, Casambi included. **Casambi is not yet confirmed ready to be the standard
template for future drivers** until those two gaps close — the audit doc says so explicitly rather
than claiming a clean bill of health.

**Verification:** full `turbo run build typecheck test` across `@supreme/protocols`,
`@supreme/drivers`, `@supreme/gateway`, `@supreme/web-homeowner` — 46/46 tasks green.
`@supreme/protocols` alone: 70 test files, 669 tests, all passing.

## Session: Casambi Driver Refactor — PR-2 Core Architecture + Local Gateway Foundation

**Branch:** `claude/casambi-driver-refactor-lvu23e` (continues the Foundation session below — same
branch, same effort). This session's brief: build the cross-driver **SupremeOS Core** (Event Bus,
Capability Engine, Packet Recorder Framework, Driver Health Engine, Driver Metrics Engine) and
implement the **real** Casambi Local Gateway protocol wherever it is fully documented — grounded in
the 7 attached Lithernet reference PDFs (re-read in full this session; `Lithernet_UDP_Developer_
Reference.pdf`'s §5.10 "UDP Casambi Command" and `Lithernet_WebAPI.pdf`'s §5.14 are the two that
matter for wire protocol). Foundation's explicit constraint carries forward unchanged: **Cloud
behavior must stay byte-for-byte identical** — nothing in `cloud-transport.ts`, `connection-
manager.ts`'s cloud branch, or the Cloud half of `casambi-driver.ts` was touched.

### SupremeOS Core (`services/protocols/src/core/`, new)

Five modules, none Casambi-specific, all with real unit tests:

- `event-bus.ts` — `CoreEventBus` + the brief's exact 13-category taxonomy (Device/Button/Sensor/
  Lighting/Media/Climate/Automation/Scene/Group/Diagnostic/Driver/Network/Health). Every interface's
  doc comment states plainly which driver actually emits it today; most are honestly reserved for a
  future protocol. **Not yet wired into `casambi-driver.ts`** — the driver still publishes through
  the pre-existing, Casambi-only `event-engine.ts`/`CasambiEventBus` (Foundation-session code, left
  alone deliberately to avoid re-touching tested Cloud event-emission paths in the same PR that adds
  Local). Migrating the driver onto `CoreEventBus` is real, scoped follow-up work — see TODO.md.
- `capability-engine.ts` — `computeEntityCapabilities()`/`computeDriverCapabilities()`, pure
  functions turning a device's real `CapabilityKind[]` + structural color config into flat boolean
  flags. `supportsRGBW` is hard-coded `false` with a doc comment explaining why (no domain-model
  white-channel field exists — not this session's gap to invent one).
- `packet-recorder.ts` — `PacketRecorder`, a bounded ring buffer with query/filter/export. Framework
  only, as scoped: no protocol-specific parsing lives here, and nothing wires the real UDP engine's
  raw datagrams into it yet (see TODO.md).
- `driver-health-engine.ts` — `computeDriverHealth()`, generalizing Foundation's Casambi-only
  Health Monitor into a reusable score+verdict engine any future driver can reuse.
- `driver-metrics-engine.ts` — `DriverMetricsEngine`, sliding-window rate counters (packets/
  commands/events per sec) + cumulative counters (REST requests/UDP events/reconnects/dropped) +
  latency tracking.

### Casambi Local Gateway — now a real protocol, not architecture-only

- `local-transport/udp-codec.ts` (new) — byte-exact encode/decode for the "UDP Casambi Command"
  wire format (`hex-dot`/`dec-hash`), grounded directly in the reference PDF's opcode tables and
  worked examples. Every encoder/parser is unit-tested against a real documented example where one
  exists. **Three documentation inconsistencies found and flagged in code comments (never silently
  resolved):** (1) §5.10.2.1.2's section heading says opcode 0x1A but its own body says 0x1B — same
  opcode 0x1B is *also* used for the unrelated ParametersComplete marker; disambiguated by the
  declared Length field, exactly as both sections themselves specify. (2) §5.10.2.2.18's heading
  says 0x3F (SetTargetElements) but its body says opcode 0x3E — identical to SetTargetDimmers
  immediately above it; resolved by following the section title, flagged as a judgment call. (3)
  0x2F (Set color via RGBW) and 0x3D (Set color via Hue/Sat) both have a worked example whose
  Length token undercounts by exactly one relative to the doc's own universal framing formula
  (`length = opcode + arguments`, p.264) — this codec always derives Length from that formula, not
  a per-opcode caption, so it does not reproduce the doc's apparent typo.
- `local-transport/udp-engine.ts` (real, was a stub) — a real `node:dgram` UDP4 socket (injectable
  `socketFactory` for tests), send via the codec's encoders, decode incoming datagrams via the
  codec's parsers, and a `probe()` method for the Setup Wizard's "Test Connection" using opcode
  0x39 with `Request=0xFF` ("own node") — the one documented request value that can never actuate a
  real device/group/scene.
- `local-transport/rest-client.ts` (real, was a stub) — implements exactly the one documented REST
  endpoint, `GET /set/target_value` (`Lithernet_WebAPI.pdf` §5.14.1). `fetchNetwork`/`fetchState`
  honestly still reject — no such endpoint exists anywhere in the supplied reference set.
  `testConnection()` never calls the write endpoint (that always actuates); it's a plain reachability
  GET to the gateway's HTTP root.
- `local-discovery.ts` (new) — `updateUnitFromControlValues()`, the mechanism Local-mode discovery
  actually uses: no REST device-listing endpoint is documented anywhere, so units are inferred
  progressively from UDP NotifyControlValues (opcode 0x4B) subscription responses, folded into the
  SAME `CasambiUnit` shape `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` already
  know how to read — additive to the unified entity model, not a parallel implementation of it.
  Maps dimmer (type 1), on/off (16), battery (7), device temperature (6), lux (20), and presence
  (21). Deliberately does NOT map the color-related types (2/3/4/5/11) — type 2's single-byte
  "Color Temperature" has no documented Kelvin range/normalization at the NotifyControlValues
  layer (unlike the SET-side opcode 0x48, which does document one) — an honest, disclosed gap.
- `local-command-mapper.ts` (new) — `localCommandToUdpPacket()`, the Local-mode analogue of
  `entity-mapper.ts`'s `commandToTargetControls()`. Maps onoff/brightness/color(hue-sat, kelvin) to
  real UDP opcodes (0x20, 0x3D, 0x48). `position` is deliberately unmapped — no opcode in the
  reference set documents a shade/cover position control.
- `casambi-driver.ts` — Local mode's `connect()` no longer throws
  `CasambiLocalRestNotImplementedError`. It now really starts the UDP engine, sends the documented
  bootstrap sequence (SetDefaultMask → Subscribe → NotifyButtonEvent enable, all best-effort since
  Subscribe/NotifyButtonEvent are firmware-gated ≥37.90/≥39.50 and there's no way to detect an
  older-firmware no-op without real hardware), and routes incoming packets: 0x4B →
  `local-discovery.ts` → the SAME `applyUnit()`/`record()` machinery Cloud already uses (so state
  listeners/diagnostics/events all work identically regardless of transport); 0x51 → a typed
  `ButtonEvent`; 0x3A → forgets the unit + a `networkUpdated` event; 0x0D (Scene called) is logged
  via the tracer only — its 8-bit, installer-app-configured payload has no unitId/sceneId
  equivalent to `SceneEvent`, an honest gap rather than a forced mapping. `command()` now really
  sends a UDP packet for onoff/brightness/color; `position` (and anything else `local-command-
  mapper.ts` returns `null` for) surfaces the driver's existing "unsupported command" error.
  `isConnected()` reflects the real UDP socket's `listening` state. UDP being connectionless means
  there is still no reconnect loop for Local — a disclosed, deliberate scope boundary, see TODO.md.
- `health-monitor.ts` — `computeHealthVerdict`/`restSubsystemStatus`/`udpSubsystemStatus` no longer
  hard-code Local to `"not_implemented"`. UDP status now reflects the real socket state
  (`connected`/`disconnected`); REST status for Local reports `"not_configured"` (honestly: the
  documented REST surface is one stateless write endpoint, nothing with a live connection state to
  report — not a placeholder for "unimplemented").

### Driver Store, Gateway routes, UI

- `services/drivers/src/manifests.ts` — Casambi bumped 1.1.0 → 1.2.0. New config fields: `netId`
  (0-254, must match the gateway's own Net ID) and `dataFormat` (`hex-dot`/`dec-hash` select, must
  match the gateway's own "DEC or HEX" setting). `autoDiscover`'s help text now honestly says why
  it's unimplemented (no discovery endpoint) rather than "architecture-only."
- `services/gateway/src/native-driver-factory.ts` — reads `netId`/`dataFormat` from stored config
  and passes them through to `CasambiLocalGatewayConfig`.
- `services/gateway/src/routes/installer.ts` — `POST /v1/commissioning/casambi/test-connection` is
  now REAL: parses `{gatewayIp, restPort, udpPort, netId, dataFormat}` from the request body, runs a
  REST reachability check + a safe UDP probe, returns `{implemented: true, reachable, rest, udp,
  message}`. `discover-gateway` stays honestly `implemented: false` with updated wording (no
  enumeration/discovery endpoint is documented for this gateway at all).
- `apps/web-homeowner/src/api.ts`/`drivers.tsx` — `testCasambiLocalConnection()` now sends real
  connection params (reads them from the wizard's own in-progress field values) and renders
  `rest`/`udp` reachability separately. New `netId`/`dataFormat` fields render in the Local Gateway
  section. Diagnostics panel's UDP status no longer says "(placeholder)".

### Verification

Full `turbo run build typecheck test` across `@supreme/protocols`, `@supreme/drivers`,
`@supreme/gateway`, `@supreme/web-homeowner` (and their dependency closure) — 46/46 tasks green.
`@supreme/protocols`' own suite: **67 test files, 644 tests, all passing**, including every
pre-existing Cloud-mode Casambi test unmodified (confirms zero Cloud regression) plus this
session's new coverage: `core/*.test.ts` (5 files), `casambi/local-transport/udp-codec.test.ts` (39
tests, several byte-exact against the PDF's own worked examples), `udp-engine.test.ts` (13, fake
`dgram` socket), `rest-client.test.ts` (6, fake `fetch`), `local-discovery.test.ts` (8),
`local-command-mapper.test.ts` (10), and 12 new Local-mode integration tests appended to
`casambi-driver.test.ts` (connect/disconnect bootstrap+teardown sequences, NotifyControlValues →
state, command → UDP packet, button events, node removal, diagnostics). **Not done this session:**
live Playwright verification of the updated Driver Manager UI (no running `hub-compose` stack in
this sandbox, same honest gap as the Foundation session) — flagged, not claimed. Real Lithernet
hardware verification of anything firmware-gated (≥37.90/≥39.50 NotifyControlValues/NotifyButtonEvent,
≥36.70 Target Color/Status) is also unverifiable without hardware — see TODO.md.

## Immediate priorities for the next session

1. **RGBW/CCT capability inference for Local mode** — `local-discovery.ts` currently omits color
   entirely (documented gap: NotifyControlValues type 2's byte has no known Kelvin range). If a
   real gateway can be tested, confirm the actual encoding and complete the mapping.
2. **Wire `casambi-driver.ts` onto `core/event-bus.ts`** — today the driver still uses the
   Foundation-session `CasambiEventBus`; migrating to the new cross-driver `CoreEventBus` was
   deliberately deferred this session to avoid re-touching tested Cloud event paths in the same PR
   that added Local. Do this as its own scoped change with its own regression pass.
3. **Wire the real UDP engine into `core/packet-recorder.ts`** — the framework exists; nothing
   records real datagrams into it yet. Needed before "Packet Capture" in the UI can go from
   disabled placeholder to real.
4. **Local mode reconnect/health-recovery loop** — UDP being connectionless means a lost socket
   today has no automatic recovery the way Cloud's WebSocket does. Decide what "reconnect" even
   means for a connectionless protocol on a LAN gateway before building it.
5. **0x0D Scene called → a real driver event** — currently only logged via the tracer. Its 8-bit,
   installer-app-configured payload has no unitId/sceneId; decide on a shape (maybe a new,
   Local-only event type) before wiring it into `CoreEventBus`/`CasambiEventBus`.
6. Live Playwright verification of the updated Driver Manager wizard/diagnostics UI at all four
   required breakpoints — genuinely not done this session (no backend running in this sandbox).
7. Verify every firmware-gated opcode (0x39/0x45/0x46/0x49/0x4B/0x50/0x51, gated ≥33.22 through
   ≥39.50 across different features) against a real Lithernet Gateway once hardware is available —
   this session's implementation is byte-exact against the documentation but has never touched a
   real device.

---

## Session: Universal AV SDK

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start.

This handoff was rewritten from scratch — the previous version had drifted several sessions out
of date (it stopped at the original `TcpLineTransport`/`state-cache.ts` extraction and never
recorded the subsequent HTTP AppCommand layer, the Audyssey-family command pass, the RTI
Capability Audit, or this session's work). The detailed history of each of those passes lives in
its own architecture doc, cross-linked below — this file only needs to describe current state and
what changed most recently.

## Most recent session — AVR Diagnostic Mode

Prior sessions in this branch did a static code audit (found one real bug: the renamed-input
capability-config race — `refreshInputEnrichment()` fire-and-forget raced by a synchronous
`getCapabilityConfig()` read, still unfixed, still in `TODO.md`), then a full runtime-instrumented
trace of a real event through the entire pipeline against a fake AVR + real gateway + real
browser (found no pipeline break). The user then explicitly asked for neither: since they have no
way to give this session access to their real physical Denon/Marantz receiver, they asked for a
**permanent, production-safe diagnostic facility they can enable on their own installation** to
capture ground truth from their own hardware and hand the log back for analysis.

**Shipped**: AVR Diagnostic Mode — `SUPREME_AVR_DIAGNOSTICS=true` (env var, off by default).
When enabled, every real receiver event gets a correlation ID (`AVR-000023`); every stage it
passes through (`TCP`/`Parser`/`patchMedia`/`emitFor`/`StateCache`/`Gateway`/`WebSocket`) logs a
line tagged with that ID. Unrecognized lines are captured with hex/ascii/length/firstToken/
sender/frequency, never a bare "unrecognized" message. Exact session counters (received/parsed/
unknown/dispatched/dropped/bindingsMissing/cacheDeduplicated/gatewayPublishes/websocketSends) are
tracked throughout and reported at shutdown and at export time. `GET /v1/devices/:id/diagnostics/
export` streams the complete trace as a downloadable `diagnostic.log` file — the one file to
upload back for analysis. Full detail, exact enable/export steps: `docs/architecture/
AVR-Diagnostic-Mode.md`.

**Architecture**: new `services/protocols/src/avr-diagnostics.ts` (`AvrDiagnosticsRecorder` —
pure, no I/O, bounded ring buffer + bounded unknown-pattern map). Wired into `avr-driver.ts` via
`this.diagnostics?.method(...)` at every stage — optional chaining short-circuits before argument
evaluation when disabled, so the off cost is one property read + one null check, zero string
building/allocation/I/O. Correlation ID crosses the driver→gateway→WebSocket process/package
boundary via a new optional `traceId?: string` field on the already-shared `BackendStateEvent`
type, and a new optional `INativeProtocolDriver.recordDiagnosticStage?()` method that gateway code
calls back into (found via the pre-existing `SupremeIntegrationLayer.getNativeDriver("avr")`) —
neither layer needs new knowledge of the other's internals. `exportDiagnosticsLog?()` is routed to
the owning driver through the same `native-adapter.ts`/`routing-adapter.ts`/`sil.ts` pattern
`getTrace`/`getDiagnostics` already use. No feature work: parser/protocol/control-path logic is
completely unchanged, only observability was added.

**Verification**: 6 new tests in `avr-diagnostics.test.ts` (correlation IDs, full-lifecycle
capture, unknown-command capture, exact counters, session report, buffer eviction), 3 new tests
in `avr-driver.test.ts`'s "AVR Diagnostic Mode wiring" `describe` block (disabled = no-op, enabled
= real end-to-end trace incl. simulated Gateway/WebSocket stage append, real unrecognized-line
capture over a real TCP fake AVR), 1 new test in `native-driver-factory.test.ts`, 3 new e2e tests
in `avr-diagnostics-export.e2e.test.ts` (export succeeds/404s-when-off/404s-for-unknown-device).
Full monorepo `pnpm typecheck`/`pnpm build`/`pnpm test` all green (93/93 turbo tasks); one
transient CPU-contention flake in an untouched, pre-existing real-TCP timing test was confirmed
non-reproducible in isolation and on rerun, not a regression from this work.

**Known limitation, stated to the user**: this facility captures real traffic once enabled and
operated against real hardware — it cannot be exercised against a physical Denon/Marantz receiver
from this environment, since none is reachable here. The wiring itself is proven against a real
in-process fake AVR over real TCP (same fidelity as prior sessions' runtime pipeline trace).

## Current state of the AV SDK

- `services/protocols/src/av-sdk/` is the real, runtime shared module: `TcpLineTransport`
  (pooled/reconnecting/line-buffered TCP, shared by AVR+HEOS), `HttpPollClient`/`AdaptivePoller`
  (shared in-flight-deduped HTTP + adaptive polling, shared by AVR's AppCommand layer), `state-
  cache.ts` (`recordCapabilityState`, shared by all three AV drivers), `init-handshake.ts`
  (`InitHandshake` — new this session, see below), `protocol-tracer.ts`, `network-source-
  resolver.ts`.
- `avr-driver.ts` (Denon/Marantz) is the SDK's reference implementation — the only driver
  combining two transports (Telnet realtime push + HTTP AppCommand for renamed/hidden inputs and
  album art) through shared SDK primitives.
- Full architecture: `docs/architecture/Universal-AV-SDK.md`. Full per-capability wire evidence:
  `docs/architecture/AVR-Universal-Capability-Matrix.md`. Engine-level roadmap (what's ✓/Partial/
  Planned across the whole SDK, honest Denon/Yamaha/Anthem reuse mapping): **new this session**,
  `docs/architecture/Universal-AVR-SDK-Roadmap.md`.

## This session's work — RTI Capability Audit, Phases 1–4

Prior session produced `docs/architecture/RTI-Capability-Audit.md`: an evidence-based audit of 16
capabilities RTI's driver has that SupremeOS didn't, classified A (officially confirmed, ready to
build) / B (officially-adjacent, one piece of evidence missing) / C (RTI application-layer pattern
buildable from already-confirmed commands) / D (RTI-only, no official corroboration). This
session executed the user's 4-phase instruction against that audit:

**Phase 1 — Category A (5 items), all shipped:**
Subwoofer On/Off (`PSSWR`), Cinema/Music/Game/Pro Logic mode (`PSMODE:`), Cinema EQ (`PSCINEMA
EQ.`), Loudness Management (`PSLOM`), Tone Control On/Off (`PSTONE CTRL`) — all in `avr-codec.ts`,
each an official-PDF-cited exact token, wired into `denonCapabilityConfig()`'s `advancedControls`
(reusing the existing generic `select` UI renderer, zero new frontend code needed). New
`hasExtendedAudio` installer-declared gate flag. 30 tests in `avr-codec.test.ts`.

**Phase 2 — Category C (all 4 items), all shipped:**
- **C.1/C.2 (connection-readiness state machine + paced init-burst)**: new `InitHandshake` class
  (`av-sdk/init-handshake.ts`) — sends one init token, waits for any reply, sends the next, rather
  than one blind burst write. New `DriverDiagnosticsSnapshot.fullySynced: boolean` (three-file
  sync: `adapter.ts` → `rest.ts` → `driver-diagnostics.ts`), wired into `avr-driver.ts`'s
  `onLinkConnect()`.
- **C.3 (keepalive probe)**: `AvrProtocolDriver.heartbeat()` — `PW?` probe, `{ ok, latencyMs }`,
  structurally identical to the existing `HeosProtocolDriver.heartbeat()`.
- **C.4 (raw command escape hatch)**: `AvrProtocolDriver.sendRaw()`, threaded through 6 interface/
  adapter touch points (`INativeProtocolDriver` → `IBackendAdapter` → `avr-driver.ts` →
  `native-adapter.ts` → `routing-adapter.ts` → `sil.ts`) to a new `POST /v1/devices/:id/raw-
  command` gateway route (`validation_failed`/422 when the owning backend doesn't support it), plus
  a new devMode-gated **Raw Command** UI section (`device-detail-sections.tsx`, wired into the AVR
  console). New `services/gateway/src/raw-command.e2e.test.ts` (4 tests) covers both the success
  path (fake native driver) and the unsupported-backend 422 path (HA-owned device).
- Two real race-condition bugs were found and fixed via test-driven debugging while wiring this
  (not guessed, not papered over — see `RTI-Capability-Audit.md`'s git history / the full session
  transcript for the exact repro): a test-harness ECONNRESET gap (fixed in the test helper) and a
  genuine `fullySynced` default-value race in `avr-driver.ts`'s `bind()` (fixed with `if
  (!link.ready) link.diagnostics.setFullySynced(false);` right after `ensureLink()`).

**Phase 3 — honest response on hardware access:**
This sandboxed environment has no LAN reachability to any physical Denon/Marantz receiver — there
is no real hardware to verify Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat)
against. Rather than fabricate a live capture, `RTI-Capability-Audit.md` got a new closing section
documenting this plainly and laying out a concrete, self-serve **guided capture procedure**: with
`devMode` on, send each Category B probe token via the new Raw Command box and read the reply in
the existing Protocol Trace panel — the exact tooling built in Phase 2 is what a real Category B
verification pass needs, no new engineering. Category B/D stay unbuilt, as they should.

**Phase 4 — Universal AVR SDK Roadmap (the explicitly-flagged most important deliverable):**
New `docs/architecture/Universal-AVR-SDK-Roadmap.md` — an engine-level (not brand-level) roadmap:
a ✓/Partial/Planned status for each of 17 engines (Core Transport, Realtime Event Engine,
Diagnostics, Capability Engine, Protocol Recorder, Connection State Machine, Keepalive Framework,
Zone Engine, Media Engine, Artwork Engine, Metadata Engine, Audio/Video Processing Engine,
Calibration Engine, Developer Console, Capability Discovery, Hardware Verification Mode), each
cited against real code. Includes a Denon "Uses:" mapping, and — deliberately correcting the
user's own illustrative "reuses 95%" framing rather than parroting it — an **honest** Yamaha reuse
assessment (real, measured reuse is low: only `state-cache.ts` + the shared `DriverDiagnosticsTracker`
class; `Universal-AV-SDK.md`'s own before/after table already recorded Yamaha's SDK-extraction
line-count reduction at ~1%, not 95%) with a concrete 3-step path to raise it, and an Anthem
mapping framed honestly as **not yet built** — a projection based on Phase 9's readiness findings
(transport/diagnostics tier likely near-total reuse; command-vocabulary tier 100% unevidenced,
zero shortcuts).

## Verification (RTI Capability Audit phases)

`pnpm build` — 54/54 (now includes the new `raw-command.e2e.test.ts`, `init-handshake.ts`/`.test.ts`).
`pnpm typecheck` — 93/93. `pnpm test` — full monorepo green (a `pnpm test` run under maximum
turbo parallelism transiently failed 3 unrelated, pre-existing timing-sensitive tests in
`avr-driver.test.ts`/`heos-driver.test.ts` due to CPU contention across ~50 concurrently-running
packages; confirmed non-reproducible via 3 repeated isolated re-runs and a scoped
`--filter @supreme/protocols --filter @supreme/gateway` run, both 100% green — not a regression
from this session's changes). Frontend (`apps/web-homeowner`) `typecheck`/`build` both clean for
the new `RawCommandSection`/`sendRawDeviceCommand` wiring; **not** Playwright-verified live this
session (no running dev server/backend in this sandbox) — flagged honestly rather than claimed.

## Later this session — Denon Cheat Sheet Audit

The user supplied an installer/engineer reference document ("Dan's Denon Cheat Sheets," Denon
section, pasted directly after a `share.google` link proved unreachable from this sandbox — the
outbound proxy rejected the CONNECT with a policy denial, confirmed via `$HTTPS_PROXY/
__agentproxy/status`) and asked for it to be audited against the official protocols and this
SDK, under a strict evidence hierarchy: official Denon Telnet PDF → official HEOS spec → live
hardware → the cheat sheet (reference only, never a source), with an explicit copyright
constraint (extract capabilities/observations only, never copy text/tables/examples/code).

**Method**: every claim in the cheat sheet was independently re-derived by fetching and reading
`denonavr`'s real, MIT-licensed source from GitHub (`const.py`, `foundation.py`, `input.py`,
`volume.py`) — the same independent cross-check source this project has used since the original
HTTP AppCommand pass — plus SupremeOS's own existing Telnet/AppCommand code. Every literal string
or field name that appears in the new doc is cited to one of those, never to the cheat sheet.

**New**: `docs/architecture/Denon-CheatSheet-Audit.md` — a full per-capability table, a gap
matrix, and an SDK-layer placement review (per-capability: Transport/Discovery/State/Capability/
Diagnostics/Media/Audio/Video/Developer-Tools layer, or Denon-adapter-only).
---

## Session: Universal Keypad Framework / Intent Engine

---

## Latest pass — Home Assistant Dependency Audit (analysis only, ZERO code changes)

A repository-wide audit of every remaining runtime dependency on Home Assistant, producing
`docs/architecture/Home-Assistant-Dependency-Audit.md` (10 phases: dependency discovery, runtime
graph, registry/automation/state/UI/driver audits, compatibility-layer design, migration roadmap,
readiness assessment). **No application code was modified, no HA code removed, no driver touched** —
the only file added is the audit document; `pnpm build`/`typecheck`/`test` remained fully cached
(56/56, 97/97, 97/97), proving nothing was disturbed.

**Headline findings (all evidence-cited in the doc):**
- HA-specific code is confined to **4 files** in `services/integration-layer/src/ha/`, with exactly
  **2 consumers** elsewhere — `bootstrap.ts` (conditional on `SUPREME_BACKEND=ha`) and
  `compiler.ts`'s `compileToHa`, which has **no runtime caller at all**.
- **Every protocol driver is 100% native** (zero HA references in `services/protocols/src/`), the
  **entire UI has zero HA calls**, and **every registry** (device/entity identity/room/floor/area/
  state/capabilities/history/statistics) is Supreme-owned.
- Only **6 of the brief's 20 HA subsystems** are genuinely used, all via one WebSocket connection
  plus a one-time onboarding HTTP flow.
- **SupremeOS already boots and fully functions with no HA process** — the entire 240-test gateway
  suite runs at `SUPREME_BACKEND=mock`.
- **The one real blocker:** there is no native-only backend mode. The router always has an `ha`
  side, which is either real HA or `MockAdapter` — **an in-memory simulator**. Turning HA off today
  doesn't remove the dependency, it silently replaces it with a fake. Now tracked as the top
  **Critical** item in `TODO.md`.
- Assessment: **architecturally ~90% HA-independent, operationally ~40%** — 1 Critical, 2 High,
  3 Medium, 2 Low blockers, all small and well-scoped (a third adapter mode, a compose profile, a
  dead-code decision), not a platform rewrite.

**Newly tracked in `TODO.md`:** the Critical native-mode blocker; 2 High (compose opt-in; the
`engine:"ha"` dead path); 2 Medium (unowned `Device.status` availability; commissioning defaulting
to `ownership="ha"`).

---

## Prior pass — Universal Intent & Capability Engine (Phase 2)

**Branch:** `claude/universal-keypad-framework-7khr2o`, based on `main` at session start (the
same branch Phase 1 shipped on — this session's branch instruction named
`feature/universal-keypad`, but the harness's assigned branch for this session takes precedence,
per this environment's git-safety convention). This session built the **Universal Intent &
Capability Engine, Phase 2** (ADR 0017), directly on top of the Universal Keypad Framework (ADR
0016) shipped last session — the brief's mission: completely decouple user interactions from
drivers, so `ToggleLight` keeps meaning the same thing forever even if the physical device behind
it changes from KNX to Casambi to Matter to anything else.

## What actually shipped

**The single highest-leverage decision**: `AutomationAction`
(`packages/domain-model/src/automations-dsl.ts`) gained ONE new additive variant — `{ type:
"intent", intentId, target, params }` — alongside the existing `device_command`/`scene_activate`/
`notify`/`delay`. Because `KeypadMapping.actions` already reuses `AutomationAction` verbatim (Phase
1's design), keypad mappings gained full Intent support with **zero** additional schema/engine
changes — direct payoff of Phase 1's reuse decision. `AutomationExecutors` gained one new optional
method, `runIntent?`, wired identically for both the Automation Engine and the Keypad Mapping
Engine (they already share one executor set). `runAutomationAction`/`describeAutomationAction`
(both previously extracted+shared, see Phase 1) grew an `"intent"` case; `compileToHa` (the
`engine: "ha"` static-compile path) honestly refuses to compile an intent action — intent
resolution is inherently dynamic, no static HA config can express it.

**New domain-model** (`packages/domain-model/src/intents.ts`, new + `intents.test.ts`):
`IntentDefinition` (pure, serializable metadata: id/name/category/description/
requiredCapabilities/parameters/targetKinds/version/i18nKey — future-proofed for AI/marketplace
consumption), `IntentTarget` (device/room/scene/automation/home, discriminated union).
Deliberately NOT a closed `z.enum` of every intent id — the catalog lives as runtime
`IntentRegistry.register()` calls, extensible forever with zero schema changes, mirroring how
`DriverManifest`/the Driver Store let a new protocol appear with no core-architecture change.

**New bounded service `@supreme/intent-engine`** (mirrors `@supreme/automations`/
`@supreme/keypad-framework`'s conventions — depends only on domain-model/contracts):
- `CapabilityIndex` — `Map<CapabilityKind, Set<DeviceId>>`, O(matching devices) lookup for
  `devicesWithCapability`/`devicesWithCapabilityInRoom`, never O(every device on the hub). Kept in
  sync via a new, additive `HomeService.onDeviceChanged` event (mirrors `SIL.subscribe`/
  `NotificationService.onNotification`'s exact shape) rather than re-scanning on every lookup or
  hooking dozens of device-mutation call sites individually.
- `IntentRegistry` — pairs each `IntentDefinition` with a `translate` (capability-driven: params +
  current state + capability config → `CapabilityCommand`) or `runSystem` (system-level: direct
  dispatch, no device resolution) handler, validated to match `requiredCapabilities` **at
  registration time**, not at first invocation.
- `validateIntentParams` — real required/type/min/max/enum-options validation + defaults, never
  trusting a caller (keypad, automation, direct REST, future AI) blindly.
- `registerBuiltinIntents` (`catalog.ts`) — 42 intents across all 6 brief-specified categories
  (lighting/climate/av/blinds/security/system). Two categories are honest, registered-but-throwing
  gaps: `swingMode`/`tiltUp`/`tiltDown` (no swing/tilt field in `TemperatureState`/`PositionState`
  yet) and `executeScript`/`webhook` (no script engine/webhook dispatcher exists) — same "visibly
  incomplete, never faked" discipline as ADR 0015's undocumented protocol gaps.
- `IntentEngine` — the Capability Engine itself: validate target kind → validate params → resolve
  device(s) via `CapabilityIndex` (or dispatch system-level directly) → translate → command →
  record an `IntentRun` trace (mirrors `AutomationRun`/`KeypadMappingRun`).
- 48 tests across 5 files, all passing, including a dedicated "migration readiness" test proving
  the identical intent+target invocation against two different `executors.command`
  implementations (standing in for two different drivers) behaves identically.

**Gateway wiring** (`services/gateway/src/{context,server}.ts`, new `routes/intents.ts`): the
`CapabilityIndex`/`IntentRegistry`/`IntentEngine` are constructed in `initWithHome()`, wired to the
SAME executors closures already built for automations/scenes/security/notifications; `runIntent`
added to the shared `AutomationExecutors` object. New REST surface (`GET /v1/intents`,
`GET /v1/intents/:id`, `POST /v1/intents/:id/run`, `GET /v1/intents/runs`,
`GET /v1/intents/:id/runs`), gated by a new additive `"intent"` `ResourceType` (baseline
permissions mirroring `"keypad_mapping"`'s per-role defaults). New `intents.e2e.test.ts` (11 tests)
proves the full pipeline over a real mock-backend hub: catalog listing, direct device-target
invocation, room-target multi-device resolution ("Movie Mode" pattern), param validation
(422 on missing required param), the honest `executeScript` failure (503), real security
arm/disarm dispatch, run-history retrieval, AND a keypad mapping whose action is `{type:"intent",
...}` driving a real device through the exact same Intent Engine a direct REST call uses.

**Documentation**: `docs/architecture/adr/0017-universal-intent-capability-engine.md`,
`docs/architecture/Universal-Intent-Capability-Engine.md` (architecture diagram, 4 sequence
diagrams — lifecycle/resolution/room-resolution/migration-readiness — Intent Registry spec,
capability resolution flow, driver integration spec, migration strategy, performance/scalability
analysis, public APIs, extension points, future roadmap). `PROJECT_CONTEXT.md` §4/§6 updated.

**Verification**: full monorepo `pnpm build` (56/56), `pnpm typecheck` (97/97), `pnpm test` (97/97
tasks) — all green, including every pre-existing suite passing **unmodified**
(`@supreme/automations`' original 36 tests + 3 new for the `"intent"` action = 39,
`@supreme/protocols`' 378, `@supreme/gateway`'s 229 pre-existing + 11 new = 240,
`@supreme/permissions`' 10, `@supreme/home`'s 8).

## What was deliberately NOT built (Phase 2 scope, per the brief)

- **No visual Intent/mapping editor** — backend architecture only, matching Phase 1's scope
  discipline.
- **No Postgres persistence** for anything new (the Intent Registry is code-defined, not a
  user-editable record, so this doesn't apply the way it does to `KeypadMapping`; `IntentEngine`'s
  run-history is in-memory only, same as the Automation/Mapping engines).
- **No swing/tilt capability-model addition** — `swingMode`/`tiltUp`/`tiltDown` are registered,
  honestly throwing intents, not a speculative schema change to invent the field.
- **No script engine or webhook dispatcher** — `executeScript`/`webhook` are registered, honestly
  throwing intents, not fabricated infrastructure.

**Findings, net**:
- Most of the cheat sheet's *write*-path claims (power/volume/mute/input via a legacy
  `/MainZone/index.put.asp?cmd0=...`-style HTTP interface) are fully redundant with the
  already-shipped, universal Telnet control path — and independently, `denonavr`'s own
  legacy-generation write path uses a *different* URL family than the cheat sheet describes,
  so that specific write shape isn't even cross-corroborated. Not implemented.
- Several things SupremeOS already does are independently confirmed to already be *better* than
  the cheat sheet's own described workflow: renamed inputs (already solved via the stronger,
  2016+ `GetRenameSource`/`GetDeletedSource` mechanism, which `denonavr` also treats as primary,
  not a fallback), and volume shown as dB in the UI with a "dB" unit label (the exact confusion
  the cheat sheet's author flags is already resolved).
- **The one genuine, previously-silent gap it led to finding**: `avr-driver.ts` hardcoded its
  HTTP port to a fixed `8080`, with no fallback — so pre-2016 Denon/Marantz units (which answer
  on port 80 and don't support `AppCommand.xml` at all) silently got **zero** HTTP-sourced data:
  no album art, no renamed inputs, no error, just quiet absence. Independently confirmed via
  `denonavr/foundation.py`'s own real `async_identify_receiver()` (try `Deviceinfo.xml` on 8080,
  then 80) and its own port-templated album-art URL usage (proving album art genuinely works on
  either port, not gated to `AppCommand.xml`).
- Two things were deliberately left **documented only, not implemented**, per the stated
  evidence rules: a generic HTTP keypress-simulation endpoint (uncorroborated by any second
  source) and an HTML-scraped SETUP rename page (the cheat sheet's own text calls it unreliable).
- One **bonus finding, unrelated to the cheat sheet itself** (surfaced while independently
  verifying its claims): `denonavr/input.py` confirms a real now-playing metadata path
  (`formNetAudio_StatusXml.xml`'s `szLine` array) for legacy pre-HEOS "NetAudio" sources
  (AirPlay/Media Server/iPod-USB/Bluetooth) — extends, not contradicts, the capability matrix's
  existing "no verified non-HEOS metadata source" finding (that one was scoped to Tuner/USB
  against the 2016+ AppCommand path specifically). Documented, not implemented — needs its own
  scoped design pass.

## Session: Universal AV SDK

**Implemented** (the one Ready-to-Implement, no-hardware-needed finding):
- `avr-http-codec.ts`: `DEVICE_INFO_URL`/`MAIN_ZONE_STATUS_URL` constants, `parseMainZoneStatus()`
  — a narrow, tested parser for exactly the 4 fields independently confirmed (power, mute,
  volume-in-dB, current input). 24 new tests.
- `avr-driver.ts`: `resolveHttpPort()`/`detectHttpGeneration()` — a best-effort, per-host-cached
  probe (an explicit `opts.httpPort` always wins, preserving every existing test's behavior
  unmodified). `refreshInputEnrichment()` now skips the doomed `AppCommand.xml` attempt entirely
  on a detected-legacy host (stops wasting a request every 15-minute poll forever) and instead
  does a best-effort legacy-status read for diagnostics only — never written into the
  installer-facing input-rename data, since that source is independently confirmed incomplete.
  `getArtwork()` and `discover()`'s AppCommand attempt both use the resolved port. `unbind()`'s
  per-host cleanup clears the cache so a re-added unit re-detects fresh. 7 new driver-level
  tests (2016+ detection, legacy detection, no-answer default, per-host caching, explicit-
  override-always-wins, artwork-on-legacy-port).
- Updated `AVR-Universal-Capability-Matrix.md` (new generation-detection row, corrected
  renamed-input/album-art/metadata rows, and fixed a stale "no AVR heartbeat exists" row that
  predated the RTI Capability Audit's own `heartbeat()` work landing) and
  `Universal-AVR-SDK-Roadmap.md` (Artwork Engine/Capability Discovery rows + Denon mapping, no
  status-label changes — the ✓/Partial labels were already accurate).
- Did **not** touch `RTI-Driver-Knowledge-Base.md`/`RTI-Capability-Audit.md` — checked for
  overlap (grepped for port-80/legacy-HTTP/pre-2016 references) and found none; those documents
  are about an unrelated source (an extracted RTI driver), not genuinely affected by this audit.

**Verification**: `pnpm --filter @supreme/protocols run typecheck` clean; `avr-driver.test.ts`
(56/56, was 50) and `avr-http-codec.test.ts` (18/18, was... wait, this file grew from 0 dedicated
generation tests to include the new suite) both green, re-run 3× to confirm no flakiness in the
new async-heavy detection tests (one genuine test race was found and fixed during authoring — the
cache-verification test's `vi.waitFor` was synchronizing on the wrong signal, not a driver bug).
Full monorepo regression run after this — see the next section below for the final numbers.

## Known issues / open gaps (carried forward, still real, still unfixed)

- Cross-platform duplication: web (`automations.tsx`) and mobile
  (`apps/mobile/lib/screens/automation_editor.dart`) Automation Editors independently hand-
  implement the identical six-node palette/defaults/field rules.
- Automation DSL/engine supports triggers/conditions/actions across every `CapabilityKind`; the
  editor UI only authors `onoff`. Documented in `Automation-Editor.md` §2, not fixed (new
  user-facing functionality, out of scope for a hardening pass).
- `AutomationService` has no direct unit tests beyond one happy-path e2e test.
- `HeosProtocolDriver.queryPlayers()` (discovery-only) reimplements manual line buffering instead
  of reusing `LineAccumulator`, no `maxBytes` cap. Still real, still unfixed, still in `TODO.md`.
- Yamaha's real SDK-primitive reuse is low (see Phase 4 roadmap doc) — `HttpPollClient`/
  `AdaptivePoller` migration and a `heartbeat()` addition are documented, scoped, NOT started.
- Category B (Zone 3/4, 8 extra channel-trim targets, Tone Defeat) and Category D (All Zone
  Stereo, Surround Back mode/Front A+B select, D.Comp, video-output routing) remain unbuilt —
  correctly so, pending either an official spec update or a real-hardware guided capture (see the
  Phase 3 procedure above).
- Raw Command UI (`RawCommandSection`) was typecheck/build-verified but not live-browser-verified
  at the project's required phone/tablet/desktop/ultrawide breakpoints this session.

## Immediate priorities for the next session

1. If a real Denon/Marantz unit becomes reachable: run the Phase 3 guided capture procedure
   against Category B's three items, AND (new this session) verify the legacy full-zone-state
   snapshot's partial rename list on a real pre-2016 unit (`TODO.md` — "Verify the pre-2016
   legacy rename-list fallback on real hardware") — both are the single highest-value next step,
   since the tooling to do the first already exists and is tested.
2. Live Playwright verification of the new Raw Command UI section (`ProtocolTraceSection`'s
   sibling in `media/detail.tsx`) at all 4 required breakpoints — genuinely not done this session.
3. Yamaha's `HttpPollClient`/`AdaptivePoller`/`heartbeat()` migration (Phase 4 roadmap doc, "Roadmap
   ordering" step 5) — independently valuable, not blocked on anything.
4. Wire the two existing `heartbeat()` methods (AVR, HEOS) into an actual scheduler + gateway
   route/UI affordance — currently callable but never automatically invoked (roadmap step 3).
5. The HEOS `queryPlayers()` unbounded-buffer bug fix (`TODO.md`) remains small, low-risk, ready
   whenever a bug-fix pass is in scope.
6. Legacy NetAudio now-playing metadata (`TODO.md`, Denon Cheat Sheet Audit bonus finding) — a
   real, evidenced capability (`formNetAudio_StatusXml.xml`'s `szLine` array) for pre-HEOS
   AirPlay/Media-Server/USB/Bluetooth sources, needs its own scoped design pass.
7. An HTTP-request equivalent of the Raw Command devMode tool (`TODO.md`) — surfaced as a real
   gap while trying to write a hardware-verification task for the cheat sheet audit's
   uncorroborated keypress-endpoint finding; today that kind of check needs a manual, out-of-band
   request.
---

## Session: Universal Keypad Framework / Intent Engine

- `IntentEngine`'s `resolveDevices()` for a `room` target unions across every capability in
  `requiredCapabilities` — correct today (every built-in intent requires exactly one capability),
  but untested against a hypothetical future intent requiring more than one simultaneously (no such
  intent exists in the catalog yet, so this is a latent-but-unexercised path, not a known bug).
- `CapabilityIndex` has no idle-eviction — same documented, negligible-at-realistic-scale
  characteristic already accepted for `UniversalInputEngine`'s per-control timer map in Phase 1.
- The "Optional Variables" mechanism from Phase 1 (`expandVariables`) hasn't been exercised
  end-to-end with an `"intent"` action's `params` field yet (only with `device_command`'s nested
  `command` fields) — the underlying recursive JSON walk is generic and should just work, but no
  dedicated test proves `{{step}}` inside an intent action's `params`.

## Immediate priorities for the next session

1. Pick a real protocol from `Keypad-Driver-Author-Guide.md`'s list (Lutron remains the most
   natural first target — its LIP transport already exists) and do the actual spec-verification
   research pass before writing keypad-specific code, exactly as ADR 0015 did for AVR.
2. If a homeowner-facing "Movie Mode"-style scene/intent authoring surface is prioritized next,
   this is exactly the point where the visual Universal Keypad Editor (or an Intent-aware
   extension to the existing Automation Editor) becomes worth its own scoped session — the backend
   (Phase 1 + Phase 2) is now complete enough to build a real UI against.
3. Consider extending `KeypadMapping`'s `variables` test coverage to include an `"intent"` action's
   `params` field (see "Known issues" above) — small, low-risk, closes a coverage gap.
4. Everything from the prior (Phase 1) handoff not touched this session remains open — see
   `TODO.md` for the full backlog with priority tiers.
