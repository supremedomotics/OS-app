import type { HomeId, UserId } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { sha256Hex } from "@supreme/crypto";

/**
 * Security panel (§16, §11.1). A small, auditable state machine: disarmed →
 * armed_{home,away,night}, with a triggered flag raised when a sensor fires while
 * armed. Sensitive transitions are gated by an optional PIN (slide-to-confirm in
 * the UI). State is in-memory per home for Phase 3 and persisted later.
 *
 * Cameras are ordinary Supreme devices of type `camera`; the gateway lists them
 * from the home topology with their snapshot URL — no streaming engine here yet.
 */
export type SecurityMode = "disarmed" | "armed_home" | "armed_away" | "armed_night";

export interface SecurityState {
  homeId: HomeId;
  mode: SecurityMode;
  triggered: boolean;
  lastChangedBy: UserId | null;
  lastChangedAt: string;
}

/**
 * Persistence seam for the panel (§4). Default = none (in-memory only). A persisted
 * store (Postgres) lets the armed/disarmed state survive a hub restart — important so
 * a reboot never silently disarms the home.
 */
export interface ISecurityStore {
  load(homeId: HomeId): Promise<SecurityState | null>;
  save(state: SecurityState): Promise<void>;
}

export interface SecurityServiceOptions {
  /** Optional PIN; when set, arm/disarm require it. Stored only as a SHA-256 hash. */
  pin?: string;
  /** Called on every state change (the gateway wires this to audit + notifications). */
  onChange?: (state: SecurityState, actorUserId: UserId | null) => void;
  /** Optional persistence; when set, state is written through and restored via {@link hydrate}. */
  store?: ISecurityStore;
}

export class SecurityService {
  private readonly panels = new Map<HomeId, SecurityState>();
  private readonly pinHash: string | null;
  private readonly onChange?: SecurityServiceOptions["onChange"];
  private readonly store?: ISecurityStore;
  /** The most recent write-through, so callers (and shutdown) can await durability. */
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(opts: SecurityServiceOptions = {}) {
    this.pinHash = opts.pin ? sha256Hex(opts.pin) : null;
    this.onChange = opts.onChange;
    this.store = opts.store;
  }

  /**
   * Restore persisted panel state into the in-memory cache. Call on boot (when a DB
   * is configured) so an armed home stays armed across a hub restart. Keeps the
   * public API synchronous: the cache is authoritative at runtime, writes are
   * write-through.
   */
  async hydrate(homeId: HomeId): Promise<void> {
    if (!this.store) return;
    const persisted = await this.store.load(homeId);
    if (persisted) this.panels.set(homeId, persisted);
  }

  getState(homeId: HomeId): SecurityState {
    return this.panels.get(homeId) ?? this.seed(homeId);
  }

  /** Arm the panel in a mode. Requires the PIN when one is configured. */
  arm(homeId: HomeId, mode: Exclude<SecurityMode, "disarmed">, userId: UserId | null, pin?: string): SecurityState {
    this.checkPin(pin);
    return this.transition(homeId, mode, false, userId);
  }

  /** Disarm the panel (clears any trigger). Requires the PIN when configured. */
  disarm(homeId: HomeId, userId: UserId | null, pin?: string): SecurityState {
    this.checkPin(pin);
    return this.transition(homeId, "disarmed", false, userId);
  }

  /**
   * Raise the alarm — called by an automation/sensor when motion or a contact
   * fires while armed. No-op when disarmed.
   */
  trigger(homeId: HomeId): SecurityState {
    const current = this.getState(homeId);
    if (current.mode === "disarmed" || current.triggered) return current;
    return this.transition(homeId, current.mode, true, null);
  }

  private checkPin(pin?: string): void {
    if (this.pinHash && sha256Hex(pin ?? "") !== this.pinHash) {
      throw new SupremeError("forbidden", "incorrect security PIN");
    }
  }

  private transition(homeId: HomeId, mode: SecurityMode, triggered: boolean, userId: UserId | null): SecurityState {
    const state: SecurityState = {
      homeId,
      mode,
      triggered,
      lastChangedBy: userId,
      lastChangedAt: new Date().toISOString(),
    };
    this.panels.set(homeId, state);
    // Write-through so the armed/disarmed state survives a restart. The cache is
    // authoritative at runtime; `flush()` awaits durability for tests/shutdown.
    if (this.store) this.lastWrite = this.store.save(state).catch(() => {});
    this.onChange?.(state, userId);
    return state;
  }

  /** Await the most recent persisted write (graceful shutdown / test determinism). */
  async flush(): Promise<void> {
    await this.lastWrite;
  }

  private seed(homeId: HomeId): SecurityState {
    const state: SecurityState = {
      homeId,
      mode: "disarmed",
      triggered: false,
      lastChangedBy: null,
      lastChangedAt: new Date().toISOString(),
    };
    this.panels.set(homeId, state);
    return state;
  }
}

export {
  planOccupancy,
  occupancyEventsAt,
  OccupancyError,
  type OccupancyConfig,
  type OccupancyEvent,
} from "./occupancy.js";
