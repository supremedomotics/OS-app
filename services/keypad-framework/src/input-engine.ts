import type { KeypadInputEvent } from "@supreme/domain-model";

/**
 * Universal Input Engine (§ Universal Keypad Framework, deliverable 1).
 *
 * Receives input from any keypad-capable driver via `ingest()`, normalizes it, and
 * publishes protocol-independent {@link KeypadInputEvent}s. This is the ONLY place
 * in the framework that derives semantic press events from raw contact closures —
 * no individual driver reimplements press-timing logic.
 *
 * Design decision (documented, not accidental): `button_pressed`/`button_released`
 * are always passed through verbatim (some installer-facing mappings genuinely want
 * raw "make/break" semantics — a doorbell contact, for instance). From that raw pair
 * this engine ALSO derives two complementary interpretations of a sustained press:
 *   - `long_press` — a single discrete summary event fired on release, carrying the
 *     total `holdMs`. For mappings that want one clean "this was a long press, do X"
 *     trigger (e.g. long-press a scene button to enter an edit mode).
 *   - `hold_start` → `holding` (repeating) → `hold_end` — a continuous stream while
 *     the button stays down. For mappings that want press-and-hold behavior (e.g.
 *     "dim the light while held").
 * Both fire from the same physical press once it crosses `longPressMs`; a mapping
 * only ever needs to listen for the shape it cares about. A press released BEFORE
 * `longPressMs` instead feeds the click-counting state machine, which waits
 * `doublePressWindowMs` after each release to see whether another click follows
 * before deciding `short_press` / `double_press` / `triple_press`.
 *
 * Every other event type (`rotate_clockwise`, `swipe`, `gesture`, or a driver that
 * already reports semantic press events itself because its hardware has onboard
 * timing) passes straight through unchanged — this engine never re-derives an
 * already-semantic event.
 */
export interface UniversalInputEngineOptions {
  /** Where every derived/passed-through normalized event goes (e.g. publish onto
   * the event bus's `subjects.keypadInput` subject, or fan out to mapping/feedback
   * listeners directly). Fire-and-forget by design — a caller that needs to await a
   * downstream write wraps its own promise inside this callback. */
  publish(event: KeypadInputEvent): void;
  /** Ms a press must be held before it's treated as a hold/long-press instead of a
   * click. Default 550ms — comfortably above accidental-tap territory, comfortably
   * below "the user is clearly holding it down." */
  longPressMs?: number;
  /** Ms to wait after a release before deciding the final click count (short/double/
   * triple press). Default 300ms. */
  doublePressWindowMs?: number;
  /** Ms between repeated `holding` events while a button stays down past
   * `longPressMs`. Default 250ms. */
  holdTickMs?: number;
  /** Injectable clock (tests can freeze/advance it); defaults to `Date.now`. */
  now?: () => number;
}

/** The (keypad, control) pair identifying one physical control — every derived event
 * this engine emits is addressed the same way its triggering raw event was. */
type ControlRef = Pick<KeypadInputEvent, "keypadId" | "control">;

interface ControlState {
  pressedAt: number | null;
  clickCount: number;
  holding: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  holdTicker: ReturnType<typeof setInterval> | null;
  decisionTimer: ReturnType<typeof setTimeout> | null;
}

function freshState(): ControlState {
  return { pressedAt: null, clickCount: 0, holding: false, longPressTimer: null, holdTicker: null, decisionTimer: null };
}

export class UniversalInputEngine {
  private readonly publishFn: (event: KeypadInputEvent) => void;
  private readonly longPressMs: number;
  private readonly doublePressWindowMs: number;
  private readonly holdTickMs: number;
  private readonly now: () => number;
  private readonly controls = new Map<string, ControlState>();

  constructor(opts: UniversalInputEngineOptions) {
    this.publishFn = opts.publish;
    this.longPressMs = opts.longPressMs ?? 550;
    this.doublePressWindowMs = opts.doublePressWindowMs ?? 300;
    this.holdTickMs = opts.holdTickMs ?? 250;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Feed one raw or already-semantic event from a driver's `onInputEvent` stream. */
  ingest(event: KeypadInputEvent): void {
    switch (event.type) {
      case "button_pressed":
        this.onPress(event);
        return;
      case "button_released":
        this.onRelease(event);
        return;
      default:
        // Already semantic (rotation/swipe/gesture, or a driver with onboard press
        // timing) — pass through untouched.
        this.publishFn(event);
        return;
    }
  }

  /** Release every timer this engine holds (shutdown/tests). Safe to call twice. */
  dispose(): void {
    for (const st of this.controls.values()) {
      if (st.longPressTimer) clearTimeout(st.longPressTimer);
      if (st.holdTicker) clearInterval(st.holdTicker);
      if (st.decisionTimer) clearTimeout(st.decisionTimer);
    }
    this.controls.clear();
  }

  private controlKey(e: ControlRef): string {
    return `${e.keypadId}#${e.control}`;
  }

  private stateFor(e: ControlRef): ControlState {
    const k = this.controlKey(e);
    let st = this.controls.get(k);
    if (!st) {
      st = freshState();
      this.controls.set(k, st);
    }
    return st;
  }

  private onPress(e: Extract<KeypadInputEvent, { type: "button_pressed" }>): void {
    this.publishFn(e);
    const st = this.stateFor(e);
    if (st.pressedAt !== null) return; // duplicate press with no intervening release — ignore, idempotent
    if (st.decisionTimer) {
      clearTimeout(st.decisionTimer);
      st.decisionTimer = null;
    }
    st.pressedAt = this.now();
    st.longPressTimer = setTimeout(() => this.beginHold(e, st), this.longPressMs);
  }

  private beginHold(e: ControlRef, st: ControlState): void {
    st.longPressTimer = null;
    this.flushClickDecision(e, st); // a hold starting mid-click-sequence still resolves the pending clicks first
    st.holding = true;
    const startedAt = st.pressedAt ?? this.now();
    this.publishFn({ type: "hold_start", keypadId: e.keypadId, control: e.control, ts: this.iso() });
    st.holdTicker = setInterval(() => {
      this.publishFn({
        type: "holding",
        keypadId: e.keypadId,
        control: e.control,
        ts: this.iso(),
        elapsedMs: this.now() - startedAt,
      });
    }, this.holdTickMs);
  }

  private onRelease(e: Extract<KeypadInputEvent, { type: "button_released" }>): void {
    this.publishFn(e);
    const st = this.controls.get(this.controlKey(e));
    if (!st || st.pressedAt === null) return; // release with no matching press — nothing to derive
    if (st.longPressTimer) {
      clearTimeout(st.longPressTimer);
      st.longPressTimer = null;
    }
    const heldMs = this.now() - st.pressedAt;
    st.pressedAt = null;

    if (st.holding) {
      if (st.holdTicker) {
        clearInterval(st.holdTicker);
        st.holdTicker = null;
      }
      st.holding = false;
      this.publishFn({ type: "hold_end", keypadId: e.keypadId, control: e.control, ts: this.iso(), heldMs });
      this.publishFn({ type: "long_press", keypadId: e.keypadId, control: e.control, ts: this.iso(), holdMs: heldMs });
      return;
    }

    st.clickCount = Math.min(st.clickCount + 1, 3);
    if (st.decisionTimer) clearTimeout(st.decisionTimer);
    st.decisionTimer = setTimeout(() => this.flushClickDecision(e, st), this.doublePressWindowMs);
  }

  private flushClickDecision(e: ControlRef, st: ControlState): void {
    if (st.decisionTimer) {
      clearTimeout(st.decisionTimer);
      st.decisionTimer = null;
    }
    if (st.clickCount === 0) return;
    const type = st.clickCount === 1 ? "short_press" : st.clickCount === 2 ? "double_press" : "triple_press";
    this.publishFn({ type, keypadId: e.keypadId as never, control: e.control, ts: this.iso() });
    st.clickCount = 0;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
