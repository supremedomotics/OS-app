/**
 * SupremeOS Driver Lifecycle (§ Driver Lifecycle Completion). The mandatory,
 * platform-wide lifecycle every driver in the fleet follows — not an AVR-specific
 * concept. Two distinct scopes, deliberately not conflated:
 *
 *   1. **Orchestration lifecycle** (Driver Manager, one per PROTOCOL instance):
 *      Create → Initialize → Register → Bind → Start → Stop → Unbind → Destroy.
 *      Already real and working — `services/gateway/src/installer-context.ts`'s
 *      `runDriverLifecycle()`/`DriverLifecycleStage` (registering → validating →
 *      restoring_bindings → rebinding_devices → recalculating_providers → publishing
 *      → ready, plus the teardown branch). This file does not replace that; it adds
 *      the missing per-DEVICE half described below, which that pipeline was never
 *      built to cover (it manages one driver INSTANCE, not individual device
 *      bindings within a still-running instance).
 *
 *   2. **Per-device lifecycle** (this file, `DriverLifecycleController`): the 20-state
 *      sequence a single Supreme device goes through inside a driver that's already
 *      running — Created → Initialized → Registered → Discovering → Discovered →
 *      Binding → Bound → Connecting → Connected → Capability Discovery → State
 *      Synchronization → Ready → Operational → Reconnecting → Disconnected →
 *      Unbinding → Unbound → Destroyed. A driver instance serves MANY devices (often
 *      sharing one physical link — HEOS's one-socket-many-players pattern is the
 *      extreme case); each device's OWN position in this sequence is independent, so
 *      this controller is created per-device-binding, not per-driver-instance.
 *
 * The states that matter for enforcement are: `bound` (a binding exists),
 * `connected`/`ready` (safe to command), `unbinding`/`unbound` (resource cleanup in
 * progress/complete), and `destroyed` (terminal — further use is a programming error,
 * not a warning). The states in between (discovering/discovered/capability_discovery/
 * state_sync/operational/reconnecting/disconnected) are real and drivers pass through
 * them, but are observational, not gates — no driver author needs to call
 * `transition()` for every single one if their protocol's shape doesn't distinguish
 * them (e.g. HEOS has no capability-discovery step at all; that's fine, skipping a
 * state is not an error, only moving BACKWARD or transitioning from `destroyed` is).
 */

export type DriverLifecycleState =
  | "created"
  | "initialized"
  | "registered"
  | "discovering"
  | "discovered"
  | "binding"
  | "bound"
  | "connecting"
  | "connected"
  | "capability_discovery"
  | "state_sync"
  | "ready"
  | "operational"
  | "reconnecting"
  | "disconnected"
  | "unbinding"
  | "unbound"
  | "destroyed";

/** Ordering used only to reject a backward transition into an EARLIER "forward"
 * state (e.g. `ready` → `binding`) — `reconnecting`/`disconnected`/`unbinding` are
 * legitimate returns from almost anywhere and are handled as explicit exceptions
 * below, not by this linear order. */
const FORWARD_ORDER: DriverLifecycleState[] = [
  "created", "initialized", "registered", "discovering", "discovered",
  "binding", "bound", "connecting", "connected", "capability_discovery",
  "state_sync", "ready", "operational",
];

/** States any of `reconnecting`/`operational`/`ready`/`connected` may legitimately
 * fall back to without that being a "backward" violation — real network life. */
const RECOVERABLE_TARGETS = new Set<DriverLifecycleState>(["reconnecting", "disconnected", "connecting"]);

/** Thrown only for a genuinely invalid transition (backward through the forward
 * sequence, or any transition attempted after `destroyed`) — never for skipping an
 * intermediate state, which is always allowed (see module doc). */
export class InvalidLifecycleTransitionError extends Error {
  constructor(from: DriverLifecycleState, to: DriverLifecycleState) {
    super(`invalid driver lifecycle transition: ${from} → ${to}`);
    this.name = "InvalidLifecycleTransitionError";
  }
}

export type CleanupFn = () => void | Promise<void>;

/**
 * Per-device-binding lifecycle tracker + resource-cleanup registry — the Driver SDK
 * primitive every driver composes (not extends; this fleet has no shared driver base
 * class, and introducing one now would mean rewriting 22 working drivers to inherit
 * from it, which is exactly the kind of "rewrite working code" this effort was
 * explicitly told not to do). A driver creates one of these per device (or per
 * physical link, for drivers where the link IS the natural unit — see the Driver
 * Author Guide), calls `.transition()` as it moves through real states, and calls
 * `.registerCleanup()` every time it acquires something that must be released
 * (a timer, a socket, a subscription). `.runCleanups()` (called from the driver's
 * own `unbind()`) releases EVERYTHING registered, in reverse-registration order
 * (LIFO — mirrors a stack unwind, so a later resource that depends on an earlier one
 * is released first), tolerating an individual cleanup's failure so one broken
 * release never blocks the rest.
 */
export class DriverLifecycleController {
  private state: DriverLifecycleState = "created";
  private readonly cleanups: { id: number; fn: CleanupFn }[] = [];
  private nextCleanupId = 0;

  get currentState(): DriverLifecycleState {
    return this.state;
  }

  /** Idempotent: transitioning to the CURRENT state is always a safe no-op (repeated
   * calls must be safe, per the mandate) — e.g. calling `unbind()` twice both times
   * tries `transition("unbinding")`, and the second call is a no-op, not an error. */
  transition(next: DriverLifecycleState): void {
    if (next === this.state) return;
    if (this.state === "destroyed") {
      throw new InvalidLifecycleTransitionError(this.state, next);
    }
    if (RECOVERABLE_TARGETS.has(next)) {
      this.state = next;
      return;
    }
    const fromIdx = FORWARD_ORDER.indexOf(this.state);
    const toIdx = FORWARD_ORDER.indexOf(next);
    // Both in the forward sequence: only forward (or from a recoverable state back
    // into the forward sequence, e.g. "disconnected" → "connecting" on reconnect
    // success) is allowed — never backward through it.
    if (fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx) {
      throw new InvalidLifecycleTransitionError(this.state, next);
    }
    this.state = next;
  }

  /** Register a resource to release on `runCleanups()`. Returns an "unregister" fn
   * for the rare case a driver wants to release something EARLY, before the whole
   * device unbinds (e.g. one of several timers is no longer needed after a config
   * change) — calling the returned fn removes it from the registry WITHOUT running
   * it (the caller is expected to have already cleaned it up itself). */
  registerCleanup(fn: CleanupFn): () => void {
    const id = this.nextCleanupId++;
    this.cleanups.push({ id, fn });
    return () => {
      const idx = this.cleanups.findIndex((c) => c.id === id);
      if (idx !== -1) this.cleanups.splice(idx, 1);
    };
  }

  /** How many cleanups are currently registered — used by tests to assert "nothing
   * leaked" (this should be 0 after `runCleanups()` completes). */
  get pendingCleanupCount(): number {
    return this.cleanups.length;
  }

  /**
   * Run every registered cleanup exactly once, LIFO order, tolerating individual
   * failures (collected and reported, never thrown mid-unwind — a failing socket
   * close must not prevent a timer from also being cleared). Safe to call more than
   * once: a second call runs against an empty registry and does nothing. Transitions
   * through `unbinding` → `unbound` → `destroyed` as it runs.
   */
  async runCleanups(): Promise<{ ok: boolean; errors: unknown[] }> {
    if (this.state === "destroyed") return { ok: true, errors: [] };
    this.transition("unbinding");
    const errors: unknown[] = [];
    // Drain LIFO, popping as we go so a cleanup that itself calls registerCleanup()
    // (unlikely, but not forbidden) doesn't get skipped or double-run.
    while (this.cleanups.length > 0) {
      const entry = this.cleanups.pop()!;
      try {
        await entry.fn();
      } catch (err) {
        errors.push(err);
      }
    }
    this.transition("unbound");
    this.transition("destroyed");
    return { ok: errors.length === 0, errors };
  }
}
