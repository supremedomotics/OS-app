/** One Matter fabric this node is a member of (§ Phase 4 §5 — multi-fabric is native Matter
 * behavior, not a SupremeOS invention: a node commissioned into Apple Home AND Google Home
 * simultaneously is normal, unrelated to any "one bridge = one ecosystem" assumption). */
export interface MatterBridgeFabricInfo {
  fabricIndex: number;
  /** The admin's own human-readable label for this fabric, if it set one (e.g. "Apple Home") —
   * null when the controller never provided one; SupremeOS never invents ecosystem names. */
  label: string | null;
  rootVendorId: number | null;
}

/** § Phase 4 — commissioning/fabric state, read directly from `@matter/main`'s own live state
 * (never a SupremeOS-maintained parallel copy — §4: "do not recreate the Matter node/fabric on
 * every startup" applies equally to not re-deriving this data structure by hand). `pairing` is
 * SENSITIVE (§10 security review) — callers must gate exposure (RBAC-restricted API, never
 * logged wholesale, never in an unauthenticated diagnostic response). */
export interface MatterBridgeCommissioningState {
  /** § Matter Bridge Phase 1.2B — "commissioned" means EXACTLY "at least one fabric has
   * admitted this node" (`fabrics.length > 0`), never "a controller is currently connected" or
   * "the commissioning window happens to be closed right now." Sourced from `@matter/main`'s own
   * `CommissioningServer.state.commissioned` — verified against its real source
   * (`behavior/system/commissioning/CommissioningServer.js`): it is LITERALLY
   * `!!FabricManager.fabrics.length`, kept live via a real fabric-change event listener, not a
   * cached/derived value. A commissioned bridge STAYS commissioned even after the commissioning
   * window closes (§ Part F/G) — closing the pairing window has nothing to do with whether an
   * already-admitted fabric (Apple Home, Google Home, ...) still exists. Multi-fabric native:
   * Apple Home is ONE possible fabric among several a bridge can hold simultaneously — this
   * field is never "is Apple Home specifically connected," only "is ANY fabric commissioned." */
  commissioned: boolean;
  /** Redundant with `fabrics.length` but exposed explicitly (§ Part F) so a caller/UI never has
   * to re-derive "how many controllers" from the array itself. */
  fabricCount: number;
  /** § Part F — a SEPARATE concept from `commissioned`: whether this node is CURRENTLY
   * commissionable. § live-confirmed via a real repro against this SDK — the
   * AdministratorCommissioning cluster's `windowStatus` attribute alone is NOT sufficient: a
   * freshly-started, never-paired node reads `windowStatus === 0` (WindowNotOpen) even while
   * genuinely advertising/accepting PASE, because the SDK's auto-opened-at-boot commissioning
   * path (`CommissioningServer`'s `#enterOnlineMode()`) never drives that cluster's formal
   * command flow — only an EXPLICIT `OpenCommissioningWindow`/`OpenBasicCommissioningWindow`
   * command sets it. So this is `windowStatus !== 0` (an admin explicitly (re)opened a window —
   * e.g. to admit a SECOND ecosystem after the first) OR `!commissioned` (the auto-opened window
   * for a node with no fabric yet). A freshly-started, never-paired node has this `true` while
   * `commissioned` is `false`. An already-commissioned node with no explicit re-open normally has
   * this `false` while `commissioned` stays `true` — the exact distinction the old single
   * `commissioned` boolean collapsed, producing "Commissioning: No — ready to pair" even once
   * Apple Home had a live fabric. */
  commissioningWindowOpen: boolean;
  fabrics: MatterBridgeFabricInfo[];
  /** The manual pairing code / QR payload / discriminator — the SAME values every time
   * (persisted by `@matter/main`, §2: never regenerated on restart) for as long as this node's
   * storage exists. Present whenever the SDK has generated commissioning credentials (always,
   * once `start()` has completed) — NOT limited to "only while uncommissioned," since
   * `allowBasicCommissioning()` (re-opening a window post-commissioning, e.g. to add a second
   * ecosystem) reuses this SAME code, per the SDK's own source (`DeviceCommissioner.
   * allowBasicCommissioning` reads the persisted passcode, never generates a new one). */
  pairing: { manualPairingCode: string; qrPairingCode: string; discriminator: number };
}

import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { MatterDeviceTypeId } from "./endpoint-registry.js";

/** What one bridged endpoint should look like, device-type-agnostic (§ Matter Bridge Phase 1
 * foundation). `initialState` is the driving SupremeOS capability's current state (see
 * `matter-device-types.ts`'s `primaryCapability` doc — exactly one capability's state is enough
 * to seed every cluster a Phase 1 device type requires) — `null` when SupremeOS has no state
 * for it yet (a device that's never reported in), in which case the server seeds honest
 * defaults (off, 0%, etc.) rather than fabricating a plausible-looking value. */
export interface MatterBridgeEndpointSpec {
  endpointNumber: number;
  name: string;
  deviceTypeId: MatterDeviceTypeId;
  initialState: CapabilityState | null;
  /** § Matter Bridge Phase 1.2 — the device's full declared SupremeOS capability-kind set (see
   * `endpoint-registry.ts`'s `MatterEndpointMapping.capabilityKinds` doc). Lets `real-server.ts`
   * route the OnOff/LevelControl clusters of a Color Temperature/Extended Color Light through
   * whichever of `onoff`/`brightness` the device ACTUALLY declares, instead of a single
   * hard-coded `primaryCapability` — this is what makes On/Off and dimming work identically for
   * a KNX device (`["onoff","brightness","color"]`) and a Casambi device
   * (`["brightness","color"]"`), no protocol-specific branching. Defaults to `[]` when unknown. */
  capabilityKinds?: string[];
}

/**
 * Matter Bridge server transport seam (§ Matter Bridge Phase 1). Mirrors `MatterController`'s
 * existing pattern in `matter-driver.ts`: production wiring is a real `@matter/main`
 * `ServerNode` (see `real-server.ts`), kept behind this interface so the Bridge's endpoint-
 * mapping and command-routing logic is unit-testable without opening real UDP/mDNS sockets —
 * this sandbox has no LAN path to a real ecosystem, so that is the honest boundary of what
 * can be verified here (§29: NOT VERIFIED — REQUIRES REAL HARDWARE / ECOSYSTEM covers real
 * commissioning + real Apple/Google/Alexa/SmartThings interop).
 */
export interface MatterBridgeServer {
  start(): Promise<void>;
  /** A clean shutdown — MUST NOT touch node identity, fabrics, credentials, or endpoint
   * state. `start()` after `stop()` resumes the SAME node (§ Phase 4 §7: driver
   * restart/SupremeOS restart/driver upgrade/driver rollback are all "stop, then start" — none
   * of them may ever imply {@link factoryReset}). */
  stop(): Promise<void>;

  /** Add one bridged endpoint of the given Matter Device Type at a SPECIFIC, caller-assigned
   * endpoint number (the `MatterEndpointRegistry`'s persisted allocation — never left to the
   * server to pick, so identity survives restart). Idempotent: re-adding the same endpoint
   * number on a subsequent boot must not throw. § Matter Bridge Phase 1 foundation — this
   * replaces the old `addOnOffLight`, which could only ever construct one device type; the
   * concrete implementation (`real-server.ts`) dispatches on `deviceTypeId` to compose the
   * right `@matter/main` device definition + cluster adapters, exactly the "Device Type →
   * required/optional cluster set → cluster adapters → Matter endpoint" pipeline this Phase
   * establishes. */
  addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void>;

  /** Remove a previously-added endpoint (device unbridged/deleted). */
  removeEndpoint(endpointNumber: number): Promise<void>;

  /** § Matter Bridge Phase 1.2 — update an EXISTING endpoint's user-facing name (the
   * BridgedDeviceBasicInformation cluster's `NodeLabel` attribute — the field Apple Home/
   * Google Home/Alexa/SmartThings all read for a bridged accessory's display name) WITHOUT
   * touching endpoint identity, device type, or any capability state. Separate from
   * `addEndpoint` because `addEndpoint` is idempotent (a no-op once the endpoint number
   * already exists, by design — re-adding on every restart must never rebuild an unchanged
   * endpoint) — a rename must propagate even when the endpoint already exists, so it needs its
   * own call that isn't swallowed by that idempotency guard. A no-op if the endpoint doesn't
   * exist (mirrors `setCapabilityState`'s own defensive-no-op convention). */
  updateEndpointName(endpointNumber: number, name: string): Promise<void>;

  /** Write an endpoint's driving-capability state onto its Matter attributes — a STATE REPORT,
   * not a command. Must never itself invoke the server's own command handler (that would be the
   * feedback loop §11 explicitly warns about); a real Matter attribute write is not a command
   * re-entry, only a genuine ecosystem-issued cluster command is. */
  setCapabilityState(endpointNumber: number, state: CapabilityState): Promise<void>;

  /** § Matter Bridge Phase 2B — reports ONE real Universal Input Event (already classified by
   * SupremeOS's own Input Engine — this never re-derives short-vs-long-vs-multi itself) onto a
   * Generic Switch endpoint. Implemented by driving REAL `currentPosition` transitions through
   * `endpoint.set()` (never manual event injection) — `@matter/node`'s own spec-compliant
   * `SwitchServer` derives the correct `initialPress`/`shortRelease`/`longPress`/`longRelease`/
   * `multiPressComplete` event sequence from those transitions, exactly the same "drive real SDK
   * state, let the SDK do the rest" convention `setCapabilityState` already uses for every other
   * cluster. A no-op if the endpoint doesn't exist (mirrors `setCapabilityState`'s own defensive
   * no-op) or isn't a Generic Switch. */
  reportKeypadPress(endpointNumber: number, press: "short" | "long" | "double" | "triple"): Promise<void>;

  /** Fires once per genuine cluster command the server received from a Matter controller
   * (Apple/Google/Alexa/a test controller/…), already translated into the SAME
   * `CapabilityCommand` shape the REST API/automations issue — the caller never sees a raw
   * Matter cluster/attribute id. Returns an unsubscribe function. */
  onCommand(listener: (endpointNumber: number, command: CapabilityCommand) => void): () => void;

  /** § Phase 4 — this node's REAL, live commissioning/fabric state (never a fabricated
   * placeholder). Throws if called before `start()`.
   *
   * NOTE on "open commissioning window" (§6's requested Action): `@matter/main@0.17.9`
   * automatically opens a basic commissioning window on `start()` whenever the node is not
   * yet commissioned (`CommissioningServer`'s own `#enterOnlineMode()` — verified against its
   * real, installed source) — so the window a fresh/factory-reset bridge needs IS already open
   * without any extra call. A manual "re-open after already commissioned" action (to admit a
   * SECOND ecosystem) would call the SDK's internal `CommissioningServer.
   * enterCommissionableMode()`, but that behavior class is not exported through `@matter/main`'s
   * public package surface at this SDK version (verified: absent from `@matter/node`'s own
   * public `index.ts` and from every `@matter/main/behaviors/*`/`@matter/main/endpoints/*`
   * forward) — reaching it would mean importing an unexported internal path, which this
   * codebase does not do for any other SDK. Deliberately NOT implemented rather than faked;
   * real Matter's own answer for this case is usually the ALREADY-PAIRED controller issuing the
   * AdministratorCommissioning cluster's `OpenCommissioningWindow` command over the wire, which
   * needs no SupremeOS-side action at all. Left as a disclosed gap for a future SDK version or
   * a verified internal-API decision, not implemented here. */
  getCommissioningState(): MatterBridgeCommissioningState;

  /** § Phase 4 §7 — DELIBERATE, DESTRUCTIVE factory reset: erases node identity, fabrics,
   * operational credentials, and every endpoint's Matter-side state, delegating to
   * `@matter/main`'s own `ServerNode.erase()` (never a SupremeOS-hand-rolled wipe of the
   * storage directory — the SDK owns exactly what "erase" means for its own files). Distinct
   * from {@link stop} on purpose: nothing in the driver lifecycle (restart, SupremeOS restart,
   * driver upgrade, driver rollback) may ever call this — only an explicit, human-initiated
   * "Matter factory reset" action may (§6's Actions contract; no route wired to it yet, per
   * "do not build a large UI yet" — this is the primitive a future route calls). Does NOT
   * touch the SupremeOS-owned endpoint-registry file — a factory-reset bridge still remembers
   * which SupremeOS device used to map to which endpoint number, so re-commissioning re-uses
   * the same numbers rather than renumbering (§ endpoint-registry.ts's "never reissue" rule
   * survives a Matter-level reset, deliberately — only a SupremeOS-level device removal frees
   * a number). */
  factoryReset(): Promise<void>;
}
