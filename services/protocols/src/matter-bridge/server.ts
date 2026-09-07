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
  /** True once at least one fabric has admitted this node — mirrors `@matter/main`'s own
   * `CommissioningServer.state.commissioned`, not a SupremeOS-invented boolean. */
  commissioned: boolean;
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

  /** Add one bridged On/Off Light endpoint at a SPECIFIC, caller-assigned endpoint number
   * (the `MatterEndpointRegistry`'s persisted allocation — never left to the server to pick,
   * so identity survives restart). Idempotent: re-adding the same endpoint number on a
   * subsequent boot must not throw. */
  addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void>;

  /** Remove a previously-added endpoint (device unbridged/deleted). */
  removeEndpoint(endpointNumber: number): Promise<void>;

  /** Write the On/Off attribute for an endpoint — a STATE REPORT, not a command. Must never
   * itself invoke the server's own command handler (that would be the feedback loop §11
   * explicitly warns about); a real Matter attribute write is not a command re-entry, only a
   * genuine ecosystem-issued On/Off cluster invocation is. */
  setOnOffState(endpointNumber: number, on: boolean): Promise<void>;

  /** Fires once per genuine On/Off cluster command the server received from a Matter
   * controller (Apple/Google/Alexa/a test controller/…). Returns an unsubscribe function. */
  onCommand(listener: (endpointNumber: number, on: boolean) => void): () => void;

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
