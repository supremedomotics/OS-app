/**
 * Supreme Intelligence Engine runner — the hub-side orchestrator that turns the pure engine into
 * live behaviour on the minute tick. It (1) builds a presence picture from the hub's own signals,
 * (2) fuses it and folds it into zone/house occupancy, (3) snapshots every device's intelligence
 * state, (4) runs the engine, then (5) applies each suggestion under the home's Auto Pilot mode —
 * auto-executing, asking, or notifying once — and records everything to the local learning/history
 * store. All decision logic lives in @supreme/intelligence (pure + tested); this file is the I/O.
 */
import {
  type AutoPilotSettings,
  type DeviceIntel,
  EnergyIntelligenceModule,
  type EngineEvaluation,
  type HouseOccupancy,
  IntelligenceEngine,
  type PresenceEstimate,
  type PresenceSignal,
  type Suggestion,
  type SuggestionAction,
  type SuggestionState,
  type Zone,
  ZoneOccupancyTracker,
  applyResponse,
  decideAutoPilot,
  fusePresence,
  resetEpisode,
  zoneOfRoom,
} from "@supreme/intelligence";

export interface SieDevice {
  id: string;
  name: string;
  roomId: string | null;
  on: boolean;
  watts?: number;
  intel?: DeviceIntel;
}

export interface SieHistoryInput {
  module: string;
  deviceId?: string;
  roomId?: string | null;
  zoneId?: string;
  ownerUserId?: string;
  action: string;
  reason?: string;
  automatic: boolean;
  userResponse?: string;
  confidence?: Suggestion["confidence"];
  estimatedWatts?: number;
  estimatedKwhSaved?: number;
  estimatedCostSaved?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface SieRunnerDeps {
  homeId: string;
  getZones: () => Promise<Zone[]>;
  /** deviceId → online presence; we treat the app/local-network connection as an app_heartbeat signal. */
  onlineUserIds: () => Promise<string[]>;
  listDevices: () => Promise<SieDevice[]>;
  getSettings: () => Promise<AutoPilotSettings>;
  setSettings: (s: AutoPilotSettings) => Promise<void>;
  getRate: () => Promise<{ ratePerKwh: number; currency: string } | undefined>;
  getSuggestionStates: () => Promise<Record<string, SuggestionState>>;
  setSuggestionStates: (m: Record<string, SuggestionState>) => Promise<void>;
  command: (deviceId: string, on: boolean) => Promise<void>;
  notify: (input: { level: "info" | "warning" | "critical"; title: string; body: string; context: Record<string, unknown> }) => Promise<void>;
  recordHistory?: (h: SieHistoryInput) => Promise<void>;
  /** Hours of runtime we assume an auto/confirmed off avoids, for the savings estimate. Default 1h. */
  savingsHours?: number;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const MIN = 60_000;

export class SieRunner {
  private readonly engine: IntelligenceEngine;
  private readonly zoneTracker = new ZoneOccupancyTracker();
  /** deviceId → ms-epoch it was first seen ON (drives on-duration; cleared when it turns off). */
  private readonly onSince = new Map<string, number>();
  private readonly now: () => number;

  private lastPresence: PresenceEstimate[] = [];
  private lastHouse: HouseOccupancy | null = null;
  private lastSuggestions: Suggestion[] = [];
  private lastErrors: Record<string, string> = {};

  constructor(private readonly deps: SieRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.engine = new IntelligenceEngine({ log: deps.log }).register(new EnergyIntelligenceModule());
  }

  /** Read-only snapshots for the REST surface (populated by the most recent tick). */
  get presence(): PresenceEstimate[] {
    return this.lastPresence;
  }
  get house(): HouseOccupancy | null {
    return this.lastHouse;
  }
  get suggestions(): Suggestion[] {
    return this.lastSuggestions;
  }
  get moduleErrors(): Record<string, string> {
    return this.lastErrors;
  }

  /** Build the world snapshot, run the engine, and act on its suggestions. */
  async tick(): Promise<void> {
    const now = this.now();
    const [zones, online, devices, settings, rate] = await Promise.all([
      this.deps.getZones(),
      this.deps.onlineUserIds(),
      this.deps.listDevices(),
      this.deps.getSettings(),
      this.deps.getRate(),
    ]);

    // (1) Presence signals from what the hub knows now: a live app/LAN connection = app_heartbeat.
    const signals: PresenceSignal[] = online.map((userId) => ({ source: "app_heartbeat", userId, present: true, strength: 1, roomId: null, ts: now }));
    const estimates = fusePresence(signals, { now });
    const house = this.zoneTracker.update(zones, estimates, now);

    // (2) Per-device snapshot, tracking on-duration across ticks.
    const energyDevices = devices.map((d) => {
      if (d.on) {
        if (!this.onSince.has(d.id)) this.onSince.set(d.id, now);
      } else if (this.onSince.has(d.id)) {
        this.onSince.delete(d.id);
      }
      return {
        deviceId: d.id,
        name: d.name,
        roomId: d.roomId,
        zoneId: zoneOfRoom(zones, d.roomId),
        on: d.on,
        onSinceMs: this.onSince.get(d.id) ?? null,
        watts: d.watts,
        intel: d.intel,
      };
    });

    // (3) Run the engine.
    const evaluation: EngineEvaluation = await this.engine.evaluate({
      homeId: this.deps.homeId,
      now,
      energy: { now, devices: energyDevices, presence: estimates, house, ratePerKwh: rate?.ratePerKwh, currency: rate?.currency },
    });
    this.lastPresence = estimates;
    this.lastHouse = house;
    this.lastSuggestions = evaluation.suggestions;
    this.lastErrors = evaluation.errors;

    // (4) Apply each suggestion under the Auto Pilot mode, with anti-spam suppression.
    const states = await this.deps.getSuggestionStates();
    const liveKeys = new Set<string>();
    // A device that turned off since last tick ends its on-episode: drop transient state, but keep
    // permanent (always_ignore) / day-scoped (ignore_today) suppressions by resetting just the episode.
    for (const [key, st] of Object.entries(states)) {
      if (!key.startsWith("energy:idle:")) continue;
      const dev = key.slice("energy:idle:".length);
      if (this.onSince.has(dev)) continue; // still on
      if (st.alwaysIgnore || st.ignoreUntilMs !== undefined) states[key] = resetEpisode(st);
      else delete states[key];
    }

    for (const suggestion of evaluation.suggestions) {
      liveKeys.add(suggestion.key);
      const decision = decideAutoPilot(suggestion, states[suggestion.key], settings, now);
      if (decision.action === "suppress") continue;

      if (decision.action === "execute") {
        await this.act(suggestion, "auto_off", true, rate?.ratePerKwh);
        states[suggestion.key] = { ...(states[suggestion.key] ?? { key: suggestion.key }), executedAt: now };
        continue;
      }
      // notify | approval
      const prefix = decision.kind === "approval" ? "Approve turning off" : "Left on while away";
      await this.deps.notify({
        level: "warning",
        title: prefix,
        body: this.notificationBody(suggestion),
        context: { sie: true, suggestionKey: suggestion.key, deviceId: suggestion.deviceId, actions: suggestion.actions, confidence: suggestion.confidence, estimatedCostToday: suggestion.estimatedCostToday, currency: suggestion.currency },
      });
      const prev = states[suggestion.key] ?? { key: suggestion.key };
      states[suggestion.key] = { ...prev, firstNotifiedAt: prev.firstNotifiedAt ?? now, lastNotifiedAt: now };
      await this.record({
        module: "energy",
        deviceId: suggestion.deviceId,
        roomId: suggestion.roomId,
        zoneId: suggestion.zoneId,
        ownerUserId: suggestion.ownerUserId,
        action: decision.kind === "approval" ? "approval_requested" : "notified",
        automatic: false,
        confidence: suggestion.confidence,
        estimatedWatts: suggestion.estimatedWatts,
        currency: suggestion.currency,
      });
    }

    // Drop state for suggestions that are no longer live and carry nothing durable.
    for (const key of Object.keys(states)) {
      const st = states[key]!;
      if (!liveKeys.has(key) && !st.alwaysIgnore && st.ignoreUntilMs === undefined) delete states[key];
    }
    await this.deps.setSuggestionStates(states);
  }

  /** Apply a user's response to a suggestion (from the REST surface). Returns the resolved action. */
  async respond(key: string, action: SuggestionAction): Promise<{ ok: true; executed: boolean }> {
    const now = this.now();
    const states = await this.deps.getSuggestionStates();
    const prev = states[key] ?? { key };
    const next = applyResponse(prev, action, now);
    states[key] = next;

    let executed = false;
    const suggestion = this.lastSuggestions.find((s) => s.key === key);
    const deviceId = suggestion?.deviceId ?? (key.startsWith("energy:idle:") ? key.slice("energy:idle:".length) : undefined);

    if (action === "turn_off" && deviceId) {
      await this.deps.command(deviceId, false);
      executed = true;
      const rate = await this.deps.getRate();
      await this.act(suggestion ?? ({ key, deviceId } as Suggestion), "user_off", false, rate?.ratePerKwh);
    } else if (action === "enable_auto_pilot") {
      const settings = await this.deps.getSettings();
      await this.deps.setSettings({ ...settings, mode: "auto_pilot" });
      await this.record({ module: "energy", deviceId, action: "enable_auto_pilot", automatic: false, userResponse: action });
    } else {
      await this.record({ module: "energy", deviceId, action: this.historyAction(action), automatic: false, userResponse: action, confidence: suggestion?.confidence });
    }
    await this.deps.setSuggestionStates(states);
    return { ok: true, executed };
  }

  private historyAction(action: SuggestionAction): string {
    switch (action) {
      case "keep_on":
        return "keep_on";
      case "ignore_today":
        return "ignored_today";
      case "always_ignore":
        return "always_ignore";
      default:
        return action;
    }
  }

  /** Turn a device off (auto or user-confirmed) and record the savings to history. */
  private async act(suggestion: Suggestion, action: "auto_off" | "user_off", automatic: boolean, ratePerKwh?: number): Promise<void> {
    if (action === "auto_off" && suggestion.deviceId) await this.deps.command(suggestion.deviceId, false);
    // Savings estimate: avoiding `savingsHours` of further runtime at the device's rated power.
    const hours = this.deps.savingsHours ?? 1;
    const kwhSaved = suggestion.estimatedWatts ? round3((suggestion.estimatedWatts / 1000) * hours) : undefined;
    const costSaved = kwhSaved !== undefined && ratePerKwh !== undefined ? round2(kwhSaved * ratePerKwh) : undefined;
    if (automatic) {
      await this.deps.notify({ level: "info", title: "Turned off automatically", body: `${suggestion.title} — ${suggestion.body}`, context: { sie: true, auto: true, deviceId: suggestion.deviceId } });
    }
    await this.record({
      module: "energy",
      deviceId: suggestion.deviceId,
      roomId: suggestion.roomId,
      zoneId: suggestion.zoneId,
      ownerUserId: suggestion.ownerUserId,
      action,
      automatic,
      confidence: suggestion.confidence,
      estimatedWatts: suggestion.estimatedWatts,
      estimatedKwhSaved: kwhSaved,
      estimatedCostSaved: costSaved,
      currency: suggestion.currency,
    });
  }

  private notificationBody(s: Suggestion): string {
    const cost = s.estimatedCostToday !== undefined && s.currency ? ` Estimated cost so far: ${s.currency} ${s.estimatedCostToday}.` : "";
    const watts = s.estimatedWatts ? ` (~${s.estimatedWatts}W)` : "";
    return `${s.body}${watts}.${cost}`;
  }

  private async record(h: SieHistoryInput): Promise<void> {
    try {
      await this.deps.recordHistory?.(h);
    } catch (err) {
      this.deps.log?.("sie history record failed", { error: (err as Error).message });
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
