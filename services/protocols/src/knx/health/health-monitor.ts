/**
 * KNX device health monitor (§ Supreme KNX Health). Collects evidence (passive telegrams, answers to bounded active GroupValueReads, path state),
 * schedules active checks under strict load limits, and exposes honest per-device states via the pure rules in health-model.ts
 * (docs/knx/knx-device-health-design.md). Clock-injected: no wall time, no hidden timers beyond one tick timer and per-check wait timers, all
 * cleared by stop(). It can READ and nothing else: its only outbound dependency is {@link ReadOnlyGroupBus}.
 */
import type { Clock, TimerHandle } from "../native/transport.js";
import { parseGroupAddress, parseIndividualAddress } from "../native/address.js";
import {
  activeCapability, DEFAULT_HEALTH_CONFIG, evaluateDevice,
  type ActiveCheckCapability, type BusCommunication, type Confidence, type DeviceRecord, type EvidenceKind, type GatewayReachability,
  type HealthConfig, type HealthReason, type HealthState, type InterfaceConnectivity, type PathObservation,
} from "./health-model.js";

/** The monitor's ONLY way to touch the bus. No write method exists by design. */
export interface ReadOnlyGroupBus {
  /** Sends one GroupValueRead. Resolves when the interface accepted it; rejects if it was refused (not a statement about the device). */
  readGroup(destination: number): Promise<void>;
}

export interface MonitoredDeviceInput {
  deviceId: string;
  individualAddress: number | null;
  statusGroups?: number[];
  activeCheck?: "allowed" | "disabled";
}

export interface ObservedTelegram { source: number; destination: number; service: "read" | "response" | "write" }
export type SendOutcome = "confirmed" | "bus_error" | "not_confirmed";

export interface DeviceHealth {
  deviceId: string;
  individualAddress: number | null;
  state: HealthState;
  confidence: Confidence;
  reason: HealthReason;
  lastSeenAt: number | null;
  lastSeenKind: EvidenceKind | null;
  lastResponseAt: number | null;
  lastResponseLatencyMs: number | null;
  consecutiveFailures: number;
  checkMethod: "passive_only" | "group_read";
  activeCheck: ActiveCheckCapability;
  lastCheck: DeviceRecord["lastCheck"];
  nextCheckAt: number | null;
}

export interface HealthLoad {
  checksStarted: number;
  readsSent: number;
  checksSucceeded: number;
  checksFailed: number;
  checksInconclusive: number;
  ticksSuspended: number;
  ticksDeferredForControlTraffic: number;
  maxConcurrentObserved: number;
  /** Checkable devices that are due but not recently heard right now: persistently high ⇒ the fleet does not fit the configured probe budget (devices will age to `stale_evidence`). */
  overdueChecks: number;
}

export interface HealthSnapshot {
  at: number;
  path: PathObservation;
  devices: DeviceHealth[];
  load: HealthLoad;
}

export interface HealthEvent {
  at: number;
  kind: "state_change" | "path_change" | "check";
  deviceId: string | null;
  from?: string;
  to?: string;
  reason: string;
}

interface Entry {
  rec: DeviceRecord;
  nextCheckAt: number;
  checking: boolean;
  last: HealthState;
  lastReason: HealthReason;
}

interface Pending { deviceId: string; ga: number; sentAt: number; settle: (latency: number | null) => void }

const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export class KnxHealthMonitor {
  private readonly cfg: HealthConfig;
  private readonly devices = new Map<string, Entry>();
  private readonly byIa = new Map<number, string>();
  private gateway: GatewayReachability = "unknown";
  private iface: InterfaceConnectivity = "unknown";
  private busErrors = 0;
  private busErrorSeq = 0;
  private lastBusErrorAt = Number.NEGATIVE_INFINITY;
  private lastBusOkAt = Number.NEGATIVE_INFINITY;
  private lastControlAt = Number.NEGATIVE_INFINITY;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private cycleStarts: number[] = [];
  private inflight = 0;
  private generation = 0;
  private running = false;
  private tickTimer: TimerHandle | null = null;
  private readonly pending = new Set<Pending>();
  private readonly waiters = new Set<{ timer: TimerHandle; done: () => void }>();
  private readonly log: HealthEvent[] = [];
  private readonly listeners = new Set<(e: HealthEvent) => void>();
  private lastPathKey = "";
  private readonly load: HealthLoad = { checksStarted: 0, readsSent: 0, checksSucceeded: 0, checksFailed: 0, checksInconclusive: 0, ticksSuspended: 0, ticksDeferredForControlTraffic: 0, maxConcurrentObserved: 0, overdueChecks: 0 };

  constructor(private readonly clock: Clock, private readonly bus: ReadOnlyGroupBus, config: Partial<HealthConfig> = {}) {
    this.cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------------------------------------------- registration

  registerDevice(input: MonitoredDeviceInput): void {
    if (this.devices.has(input.deviceId)) throw new Error(`device ${input.deviceId} already registered`);
    if (input.individualAddress !== null) {
      if (!Number.isInteger(input.individualAddress) || input.individualAddress < 0 || input.individualAddress > 0xffff) throw new Error("individualAddress out of range");
      const other = this.byIa.get(input.individualAddress);
      if (other) throw new Error(`individual address already monitored as ${other}`);
      this.byIa.set(input.individualAddress, input.deviceId);
    }
    const now = this.clock.now();
    const rec: DeviceRecord = {
      deviceId: input.deviceId, individualAddress: input.individualAddress, statusGroups: [...(input.statusGroups ?? [])],
      activeCheck: input.activeCheck ?? "allowed", lastSeenAt: null, lastSeenKind: null, lastResponseAt: null, lastResponseLatencyMs: null,
      proven: false, consecutiveFailures: 0, ring: [], lastCheck: null,
    };
    // deterministic stagger so a fleet registered together does not probe together
    const entry: Entry = { rec, nextCheckAt: now + (hash(input.deviceId) % this.cfg.checkIntervalMs), checking: false, last: "unknown", lastReason: "not_monitored" };
    this.devices.set(input.deviceId, entry);
    this.reevaluate(entry);
  }

  unregisterDevice(deviceId: string): void {
    const e = this.devices.get(deviceId);
    if (!e) return;
    for (const p of [...this.pending]) if (p.deviceId === deviceId) { this.pending.delete(p); p.settle(null); }
    if (e.rec.individualAddress !== null) this.byIa.delete(e.rec.individualAddress);
    this.devices.delete(deviceId);
  }

  // -------------------------------------------------------------------------------------------------------------- inputs

  setPath(p: Partial<{ gateway: GatewayReachability; interface: InterfaceConnectivity }>): void {
    if (p.gateway) this.gateway = p.gateway;
    if (p.interface) this.iface = p.interface;
    const key = `${this.gateway}/${this.iface}`;
    if (key !== this.lastPathKey) { this.emit({ at: this.clock.now(), kind: "path_change", deviceId: null, from: this.lastPathKey || "-", to: key, reason: "path" }); this.lastPathKey = key; }
    this.reevaluateAll();
  }

  /** Telegram received from the line (group services). Passive evidence + response matching. */
  observeTelegram(t: ObservedTelegram): void {
    const now = this.clock.now();
    this.lastBusOkAt = now;                       // the line carries traffic; a degraded verdict from OUR failed sends no longer stands
    this.busErrors = 0;
    const id = this.byIa.get(t.source);
    if (id === undefined) return;
    const e = this.devices.get(id);
    if (!e) return;
    if (t.service === "response" && e.rec.statusGroups.includes(t.destination)) e.rec.proven = true;   // it answers reads on that object
    let latency: number | null = null;
    for (const p of [...this.pending]) {
      if (p.deviceId === id && t.service === "response" && p.ga === t.destination) { latency = now - p.sentAt; this.pending.delete(p); p.settle(latency); }
    }
    if (latency !== null) this.recordActiveSuccess(e, now, latency);
    else this.recordEvidence(e, "passive_telegram", now);
    this.reevaluate(e);
  }

  /** Outcome of ANY send through the interface (ours or the integration's). `bus_error` feeds the bus verdict; `not_confirmed` is ambiguous and ignored. */
  noteSendOutcome(o: SendOutcome): void {
    const now = this.clock.now();
    if (o === "bus_error") { this.busErrors++; this.busErrorSeq++; this.lastBusErrorAt = now; }
    else if (o === "confirmed") { this.busErrors = 0; this.lastBusOkAt = now; }
    this.reevaluateAll();
  }

  /** Call for every command the integration issues: active probing keeps out of the way of control traffic. */
  noteControlTraffic(): void { this.lastControlAt = this.clock.now(); }

  // -------------------------------------------------------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => { this.tick(); if (this.running) this.tickTimer = this.clock.setTimeout(loop, this.cfg.tickMs); };
    this.tickTimer = this.clock.setTimeout(loop, this.cfg.tickMs);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.tickTimer) this.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    for (const w of [...this.waiters]) { this.clock.clearTimeout(w.timer); this.waiters.delete(w); w.done(); }
    for (const p of [...this.pending]) { this.pending.delete(p); p.settle(null); }
  }

  /** One scheduling pass (also driven by the tick timer). Synchronous: starts at most `maxChecksPerTick` asynchronous checks. */
  tick(): void {
    const now = this.clock.now();
    this.reevaluateAll();
    const path = this.currentPath();
    if (path.gateway !== "reachable" || path.interface !== "up" || path.bus === "degraded") { this.load.ticksSuspended++; return; }
    if (now - this.lastControlAt < this.cfg.controlQuietMs) { this.load.ticksDeferredForControlTraffic++; return; }
    this.cycleStarts = this.cycleStarts.filter((t) => now - t < 60_000);
    const due = [...this.devices.values()]
      .filter((e) => !e.checking && this.checkable(e) && now >= e.nextCheckAt && !this.recentlyHeard(e, now))
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt || (a.rec.deviceId < b.rec.deviceId ? -1 : 1));
    let started = 0;
    for (const e of due) {
      if (started >= this.cfg.maxChecksPerTick || this.inflight >= this.cfg.maxConcurrentChecks) break;
      if (now - this.lastReadAt < this.cfg.minReadGapMs) break;
      if (this.cycleStarts.length >= this.cfg.maxChecksPerMinute) break;
      this.cycleStarts.push(now);
      started++;
      void this.runCheck(e);
    }
  }

  // -------------------------------------------------------------------------------------------------------------- outputs

  snapshot(): HealthSnapshot {
    const now = this.clock.now();
    const devices = [...this.devices.values()].map((e): DeviceHealth => {
      const ev = evaluateDevice(e.rec, now, this.currentPath(), this.cfg);
      const cap = activeCapability(e.rec);
      return {
        deviceId: e.rec.deviceId, individualAddress: e.rec.individualAddress, ...ev,
        lastSeenAt: e.rec.lastSeenAt, lastSeenKind: e.rec.lastSeenKind, lastResponseAt: e.rec.lastResponseAt, lastResponseLatencyMs: e.rec.lastResponseLatencyMs,
        consecutiveFailures: e.rec.consecutiveFailures, checkMethod: cap === "candidate" || cap === "proven" ? "group_read" : "passive_only",
        activeCheck: cap, lastCheck: e.rec.lastCheck ? { ...e.rec.lastCheck } : null, nextCheckAt: this.checkable(e) ? e.nextCheckAt : null,
      };
    }).sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    const overdue = [...this.devices.values()].filter((e) => this.checkable(e) && now >= e.nextCheckAt && !this.recentlyHeard(e, now)).length;
    return { at: now, path: this.currentPath(), devices, load: { ...this.load, overdueChecks: overdue } };
  }

  events(): readonly HealthEvent[] { return this.log; }
  onEvent(fn: (e: HealthEvent) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  get pendingChecks(): number { return this.inflight; }

  // -------------------------------------------------------------------------------------------------------------- internals

  private currentPath(): PathObservation {
    const now = this.clock.now();
    let bus: BusCommunication = "unknown";
    if (this.busErrors >= this.cfg.busErrorThreshold && now - this.lastBusErrorAt < this.cfg.busFreshnessMs) bus = "degraded";
    else if (now - this.lastBusOkAt < this.cfg.busFreshnessMs) bus = "ok";
    return { gateway: this.gateway, interface: this.iface, bus };
  }

  private checkable(e: Entry): boolean {
    const c = activeCapability(e.rec);
    return c === "candidate" || c === "proven";
  }

  private recentlyHeard(e: Entry, now: number): boolean {
    return e.rec.lastSeenAt !== null && now - e.rec.lastSeenAt < this.cfg.checkIntervalMs;   // passive evidence is enough; do not probe
  }

  private recordEvidence(e: Entry, kind: EvidenceKind, at: number): void {
    if (e.rec.consecutiveFailures >= this.cfg.offlineAfterFailures) e.rec.ring = [];   // a confirmed outage that has ended is not "intermittence"
    e.rec.lastSeenAt = at; e.rec.lastSeenKind = kind; e.rec.consecutiveFailures = 0;
  }

  private recordActiveSuccess(e: Entry, at: number, latency: number): void {
    this.recordEvidence(e, "active_response", at);
    e.rec.lastResponseAt = at; e.rec.lastResponseLatencyMs = latency; e.rec.proven = true;
    this.pushRing(e.rec, true);
    e.rec.lastCheck = { at, outcome: "success" };
    e.nextCheckAt = at + this.cfg.checkIntervalMs;
  }

  private pushRing(r: DeviceRecord, ok: boolean): void { r.ring.push(ok); while (r.ring.length > this.cfg.ringSize) r.ring.shift(); }

  private gapRemaining(): number { return this.cfg.minReadGapMs - (this.clock.now() - this.lastReadAt); }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const w = { timer: this.clock.setTimeout(() => { this.waiters.delete(w); resolve(); }, ms), done: resolve };
      this.waiters.add(w);
    });
  }

  /** Bounded check cycle: up to `maxAttempts` reads. Outcome: success, a conclusive failure, or inconclusive (never counted). */
  private async runCheck(e: Entry): Promise<void> {
    const gen = this.generation;
    e.checking = true; this.inflight++; this.load.checksStarted++;
    this.load.maxConcurrentObserved = Math.max(this.load.maxConcurrentObserved, this.inflight);
    const busSeq = this.busErrorSeq;
    const startedAt = this.clock.now();
    let outcome: "success" | "failure" | "inconclusive" = "failure";
    try {
      for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
        if (gen !== this.generation) { outcome = "inconclusive"; break; }
        const ga = e.rec.statusGroups[(attempt - 1) % e.rec.statusGroups.length]!;
        // global spacing of ALL reads (first attempts and retries of every cycle alike)
        for (let gap = this.gapRemaining(); gap > 0; gap = this.gapRemaining()) { await this.sleep(gap); if (gen !== this.generation) break; }
        if (gen !== this.generation) { outcome = "inconclusive"; break; }
        const wait = this.waitForResponse(e.rec.deviceId, ga);
        this.lastReadAt = this.clock.now(); this.load.readsSent++;
        try { await this.bus.readGroup(ga); } catch { wait.cancel(); outcome = "inconclusive"; break; }   // refused by the interface: says nothing about the device
        const latency = await wait.promise;
        if (gen !== this.generation) { outcome = "inconclusive"; break; }
        if (latency !== null) { outcome = "success"; break; }
        if (attempt < this.cfg.maxAttempts) await this.sleep(this.cfg.retryDelayMs);
      }
    } finally {
      this.inflight--; e.checking = false;
    }
    if (gen !== this.generation || !this.devices.has(e.rec.deviceId)) return;
    const now = this.clock.now();
    const path = this.currentPath();
    // A late answer (or any telegram from the device) that arrived during the cycle is evidence of life: such a cycle is not a failure.
    if (outcome === "failure" && e.rec.lastSeenAt !== null && e.rec.lastSeenAt >= startedAt) outcome = "inconclusive";
    const conclusive = path.gateway === "reachable" && path.interface === "up" && path.bus !== "degraded" && this.busErrorSeq === busSeq;
    if (outcome === "success") {
      this.load.checksSucceeded++;                                       // recordActiveSuccess already ran in observeTelegram
      this.emit({ at: now, kind: "check", deviceId: e.rec.deviceId, to: "success", reason: "active_response" });
    } else if (outcome === "failure" && conclusive) {
      e.rec.consecutiveFailures++; this.pushRing(e.rec, false);
      e.rec.lastCheck = { at: now, outcome: "failure" };
      e.nextCheckAt = now + (e.rec.consecutiveFailures >= this.cfg.offlineAfterFailures ? this.cfg.offlineProbeIntervalMs : this.cfg.failureRecheckMs);
      this.load.checksFailed++;
      this.emit({ at: now, kind: "check", deviceId: e.rec.deviceId, to: "failure", reason: `no_response_after_${this.cfg.maxAttempts}_attempts` });
    } else {
      e.rec.lastCheck = { at: now, outcome: "inconclusive" };
      e.nextCheckAt = now + this.cfg.failureRecheckMs;
      this.load.checksInconclusive++;
      this.emit({ at: now, kind: "check", deviceId: e.rec.deviceId, to: "inconclusive", reason: outcome === "failure" ? "path_or_bus_not_healthy" : (e.rec.lastSeenAt !== null && e.rec.lastSeenAt >= startedAt ? "device_spoke_during_check" : "send_refused_or_cancelled") });
    }
    this.reevaluate(e);
  }

  private waitForResponse(deviceId: string, ga: number): { promise: Promise<number | null>; cancel(): void } {
    let settle!: (v: number | null) => void;
    const promise = new Promise<number | null>((r) => { settle = r; });
    const p: Pending = { deviceId, ga, sentAt: this.clock.now(), settle: (v) => { this.clock.clearTimeout(timer); settle(v); } };
    const timer = this.clock.setTimeout(() => { this.pending.delete(p); settle(null); }, this.cfg.responseTimeoutMs);
    this.pending.add(p);
    return { promise, cancel: () => { this.pending.delete(p); this.clock.clearTimeout(timer); settle(null); } };
  }

  private reevaluateAll(): void { for (const e of this.devices.values()) this.reevaluate(e); }

  private reevaluate(e: Entry): void {
    const ev = evaluateDevice(e.rec, this.clock.now(), this.currentPath(), this.cfg);
    if (ev.state !== e.last || ev.reason !== e.lastReason) {
      this.emit({ at: this.clock.now(), kind: "state_change", deviceId: e.rec.deviceId, from: `${e.last}/${e.lastReason}`, to: `${ev.state}/${ev.reason}`, reason: ev.reason });
      e.last = ev.state; e.lastReason = ev.reason;
    }
  }

  private emit(ev: HealthEvent): void {
    this.log.push(ev);
    while (this.log.length > this.cfg.eventLogSize) this.log.shift();
    for (const l of [...this.listeners]) { try { l(ev); } catch { /* listeners never affect monitoring */ } }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
/** Structural subset of the ETS project model (`@supreme/commissioning` KnxDeviceInstance + KnxCommunicationObject) — no cross-package import. */
export interface EtsLikeDevice {
  id: string;
  individualAddress: string | null;
  comObjects: Array<{ flags: { read: boolean }; sendGroupAddresses: string[] }>;
}

/**
 * Builds a monitored-device registration from ETS data: status groups = group addresses that the device's OWN communication objects send on and that
 * carry the Read flag (so the device is configured to answer reads there). `secure` devices (Data Secure groups) are never probed. Unparseable
 * addresses are skipped — nothing is guessed.
 */
export function monitoredDeviceFromEts(d: EtsLikeDevice, opts: { secure?: boolean } = {}): MonitoredDeviceInput {
  let ia: number | null = null;
  try { ia = d.individualAddress ? parseIndividualAddress(d.individualAddress) : null; } catch { ia = null; }
  const groups = new Set<number>();
  for (const co of d.comObjects) {
    if (!co.flags.read) continue;
    for (const ga of co.sendGroupAddresses) { try { groups.add(parseGroupAddress(ga)); } catch { /* skip */ } }
  }
  return { deviceId: d.id, individualAddress: ia, statusGroups: [...groups].sort((a, b) => a - b), activeCheck: opts.secure ? "disabled" : "allowed" };
}
