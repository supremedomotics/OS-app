import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { CoolMasterConnection } from "./coolmaster-connection.js";
import { CoolMasterStateCache } from "./coolmaster-cache.js";
import { DEFAULT_CONFIG } from "./coolmaster-constants.js";
import { cmdGroupPower, cmdMainControllerPower, cmdVentilationPower, cmdWaterHeaterPower, cmdWaterHeaterTemp } from "./coolmaster-commands.js";
import { discoverAll } from "./coolmaster-discovery.js";
import { CoolMasterConfigError, CoolMasterUnsupportedCommandError } from "./coolmaster-errors.js";
import { CoolMasterEventBus, type CoolMasterDriverEvent } from "./coolmaster-events.js";
import { CoolMasterLogger, type CoolMasterScopedLogger } from "./coolmaster-logger.js";
import {
  groupDiscoveredDevice,
  indoorUnitCapabilityConfig,
  indoorUnitCommandLines,
  indoorUnitDiscoveredDevice,
  mainControllerDiscoveredDevice,
  mainControllerOnOffState,
  unitOnOffState,
  unitTemperatureState,
  ventilationDiscoveredDevice,
  ventilationFanState,
  waterHeaterDiscoveredDevice,
  waterHeaterOnOffState,
  waterHeaterTemperatureState,
} from "./coolmaster-mapper.js";
import { CoolMasterCommandQueue, CoolMasterPoller } from "./coolmaster-polling.js";
import type {
  CoolMasterDeviceKind,
  CoolMasterDiscoveryResult,
  CoolMasterDriverConfig,
  CoolMasterUnitStatus,
  ResolvedCoolMasterConfig,
} from "./coolmaster-types.js";

export type CoolMasterDriverOptions = CoolMasterDriverConfig;

interface CmBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  /** UID for an indoor unit/water heater/main controller/ventilation unit, or group id
   * for a group — the same field either way since both are opaque CoolMaster addresses. */
  uid: string;
  deviceKind: CoolMasterDeviceKind;
  /** Group members, resolved at bind time from the last discovery pass — only set when
   * deviceKind === "group". */
  groupMembers?: string[];
}

function resolveConfig(opts: CoolMasterDriverConfig): ResolvedCoolMasterConfig {
  if (!opts.host || opts.host.trim().length === 0) {
    throw new CoolMasterConfigError("coolmaster: host is required");
  }
  return { ...DEFAULT_CONFIG, ...opts, host: opts.host.trim() };
}

/**
 * Native CoolMaster (CoolAutomation CoolMasterNet/CoolLinux gateway) driver — ground-up
 * rewrite per docs/coolmaster/. Speaks ASCII_IF (all commands, full discovery) and REST
 * v2 (JSON status polling when reachable, per the documented "REST preferred for status,
 * ASCII_IF where required" — see coolmaster-rest-protocol.ts for the exact scoping).
 * Auto-discovers gateway/lines/indoor-units/groups/water-heaters/ventilation and creates
 * Supreme entities for all of them without any manual mapping step (§ Auto Discovery).
 */
export class CoolMasterProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "coolmaster";

  private readonly config: ResolvedCoolMasterConfig;
  private readonly logger: CoolMasterLogger;
  private readonly log: CoolMasterScopedLogger;
  private readonly events = new CoolMasterEventBus();
  private readonly connection: CoolMasterConnection;
  private readonly unitCache = new CoolMasterStateCache();
  private readonly commandQueue = new CoolMasterCommandQueue();
  private readonly poller: CoolMasterPoller;

  private readonly bindings: CmBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  /** Supreme-facing capability state, one entry per bound device+capability — same
   * shape/convention as every other native driver in this codebase (avr/heos/yamaha). */
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private discoveryResult: CoolMasterDiscoveryResult | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(opts: CoolMasterDriverOptions) {
    this.config = resolveConfig(opts);
    this.logger = new CoolMasterLogger({ debug: this.config.debug });
    this.log = this.logger.child("driver");
    this.connection = new CoolMasterConnection(this.config, this.events, this.logger.child("connection"));
    this.poller = new CoolMasterPoller({
      fastMs: this.config.pollMs,
      slowMs: this.config.slowPollMs,
      discoveryMs: this.config.discoveryIntervalMs,
      onFastPoll: () => this.fastPoll(),
      onSlowPoll: () => this.slowPoll(),
      onDiscoveryDue: () => this.runDiscovery(),
      onError: (tier, err) => this.log.warn(`${tier} poll failed`, { error: (err as Error).message }),
    });
  }

  // ── INativeProtocolDriver ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.unsubscribeEvents = this.events.on((e) => this.onDriverEvent(e));
    await this.connection.connect();
    await this.runDiscovery();
    this.poller.start();
  }

  async disconnect(): Promise<void> {
    this.poller.stop();
    this.connection.disconnect();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const deviceKind = (binding.config?.deviceKind as CoolMasterDeviceKind | undefined) ?? "indoor_unit";
    const groupMembers =
      deviceKind === "group"
        ? this.discoveryResult?.groups.find((g) => g.id === binding.address)?.memberUids
        : undefined;
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, uid: binding.address, deviceKind, groupMembers });
    this.devices.add(binding.deviceId);
    // Seed initial state immediately from whatever discovery/polling already has cached,
    // so a freshly-bound device isn't blank until the next poll cycle.
    this.publishFromCache(binding.deviceId, binding.capability, binding.address, deviceKind);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`coolmaster: ${deviceId} not bound for ${command.capability}`);

    // "toggle" needs the current cached state to resolve to a concrete on/off.
    let resolved = command;
    if (command.capability === "onoff" && command.action === "toggle") {
      const prev = this.states.get(bindingKey(deviceId, "onoff"));
      const on = prev?.kind === "onoff" ? prev.on : false;
      resolved = { capability: "onoff", action: on ? "off" : "on" };
    }

    await this.commandQueue.enqueue(() => this.executeCommand(b, resolved), {
      dedupeKey: `${b.uid}:${command.capability}`,
      priority: 0, // user commands run ahead of routine poll reads
    });
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (!this.discoveryResult) await this.runDiscovery();
    return this.buildDiscoveredDevices(this.discoveryResult!);
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "temperature") return null;
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "temperature" && x.deviceKind === "indoor_unit");
    if (!b) return null;
    const unit = this.unitCache.get(b.uid);
    if (!unit) return null;
    const knownFanSpeeds = this.discoveryResult?.units.map((u) => u.fanSpeed).filter((s): s is string => !!s) ?? [];
    const knownSwing = this.discoveryResult?.units.map((u) => u.swing).filter((s): s is string => !!s) ?? [];
    return indoorUnitCapabilityConfig(unit, [...new Set(knownFanSpeeds)], [...new Set(knownSwing)]) as unknown as Record<string, unknown>;
  }

  // ── Command execution ────────────────────────────────────────────────────────

  /** Sends a command's ASCII_IF line(s), then CONFIRMS the result with an immediate
   * follow-up read rather than an optimistic guess (§ Feedback: "State changes should
   * immediately update Supreme OS entities"). A guessed post-command state could be
   * wrong (the unit might clamp an out-of-range setpoint, ignore an unsupported fan
   * speed, etc.) — an immediate real read is both faster to implement correctly and
   * more honest than assuming the command did exactly what was asked. This runs inside
   * the same command-queue item as the command itself, so it can't create extra,
   * unbounded traffic beyond one confirming read per user action. */
  private async executeCommand(b: CmBinding, command: CapabilityCommand): Promise<void> {
    switch (b.deviceKind) {
      case "indoor_unit": {
        const lines = indoorUnitCommandLines(b.uid, command);
        if (!lines) throw new CoolMasterUnsupportedCommandError(command.capability, b.uid);
        for (const line of lines) await this.connection.executeAscii(line);
        await this.fastPoll();
        return;
      }
      case "water_heater": {
        if (command.capability === "onoff") {
          await this.connection.executeAscii(cmdWaterHeaterPower(b.uid, command.action === "on"));
        } else if (command.capability === "temperature" && typeof command.targetC === "number") {
          await this.connection.executeAscii(cmdWaterHeaterTemp(b.uid, command.targetC));
        } else {
          throw new CoolMasterUnsupportedCommandError(command.capability, b.uid);
        }
        await this.refreshSecondaryDevices();
        return;
      }
      case "ventilation": {
        if (command.capability === "fan" && (command.action === "on" || command.action === "off")) {
          await this.connection.executeAscii(cmdVentilationPower(b.uid, command.action === "on"));
        } else {
          throw new CoolMasterUnsupportedCommandError(command.capability, b.uid);
        }
        await this.refreshSecondaryDevices();
        return;
      }
      case "main_controller": {
        if (command.capability === "onoff") {
          await this.connection.executeAscii(cmdMainControllerPower(b.uid, command.action === "on"));
        } else {
          throw new CoolMasterUnsupportedCommandError(command.capability, b.uid);
        }
        await this.refreshSecondaryDevices();
        return;
      }
      case "group": {
        if (command.capability === "onoff") {
          await this.connection.executeAscii(cmdGroupPower(b.uid, command.action === "on"));
        } else if (command.capability === "temperature" && b.groupMembers) {
          // No native group-level temperature/mode/fan-speed command is documented or
          // safely inferable (unlike on/off) — fan out to every member unit instead.
          for (const memberUid of b.groupMembers) {
            const lines = indoorUnitCommandLines(memberUid, command);
            if (lines) for (const line of lines) await this.connection.executeAscii(line);
          }
        } else {
          throw new CoolMasterUnsupportedCommandError(command.capability, b.uid);
        }
        // Group state is aggregated FROM member indoor units (see publishGroupAggregate)
        // — refreshing them via fastPoll cascades into a fresh group aggregate too, via
        // the same unit-updated event every regular poll already publishes through.
        await this.fastPoll();
        return;
      }
    }
  }

  /** Targeted confirming refresh for water heater / ventilation / main controller
   * commands — these device kinds have no bulk ls2-equivalent read, so re-running their
   * specific discovery list (cheap: these are always small counts, unlike "hundreds of
   * indoor units") and re-publishing is both correct and inexpensive. */
  private async refreshSecondaryDevices(): Promise<void> {
    const result = await discoverAll(this.connection, this.logger.child("discovery"), { enrichWithQuery: false });
    if (this.discoveryResult) {
      this.discoveryResult = { ...this.discoveryResult, waterHeaters: result.waterHeaters, ventilation: result.ventilation, mainControllers: result.mainControllers };
    } else {
      this.discoveryResult = result;
    }
    for (const b of this.bindings) {
      if (b.deviceKind === "water_heater" || b.deviceKind === "ventilation" || b.deviceKind === "main_controller") {
        this.publishFromCache(b.deviceId, b.capability, b.uid, b.deviceKind);
      }
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  private async runDiscovery(): Promise<void> {
    try {
      const result = await discoverAll(this.connection, this.logger.child("discovery"));
      this.discoveryResult = result;
      const nowMs = Date.now();
      for (const unit of result.units) this.unitCache.update(unit, nowMs);
      this.events.emit({ type: "discovery-complete", result });
      // Re-publish state for every already-bound device in case discovery revealed new
      // detail (e.g. query enrichment on first connect).
      for (const b of this.bindings) this.publishFromCache(b.deviceId, b.capability, b.uid, b.deviceKind);
    } catch (err) {
      this.events.emit({ type: "discovery-failed", error: err instanceof Error ? err : new Error(String(err)) });
      this.log.error("discovery failed", { error: (err as Error).message });
    }
  }

  private buildDiscoveredDevices(result: CoolMasterDiscoveryResult): DiscoveredDevice[] {
    const out: DiscoveredDevice[] = [];
    for (const unit of result.units) out.push(indoorUnitDiscoveredDevice(unit, result.gateway));
    for (const wh of result.waterHeaters) out.push(waterHeaterDiscoveredDevice(wh, result.gateway));
    for (const vam of result.ventilation) out.push(ventilationDiscoveredDevice(vam, result.gateway));
    for (const main of result.mainControllers) out.push(mainControllerDiscoveredDevice(main, result.gateway));
    for (const group of result.groups) out.push(groupDiscoveredDevice(group.id, group.label, group.memberUids, result.gateway));
    return out;
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  /** Fast tier: bulk ls2 read (one request covers every indoor unit — never one request
   * per unit, regardless of fleet size, per § Performance). */
  private async fastPoll(): Promise<void> {
    const units = await this.connection.getUnitStatuses();
    const nowMs = Date.now();
    const seen = new Set<string>();
    for (const unit of units) {
      seen.add(unit.uid);
      const { changed, previous } = this.unitCache.update(unit, nowMs);
      if (changed) this.events.emit({ type: "unit-updated", status: unit, previous });
    }
    for (const uid of this.unitCache.knownUids()) {
      if (seen.has(uid)) continue;
      const wentOffline = this.unitCache.markMissedPoll(uid);
      if (wentOffline) this.log.warn("unit stopped reporting (offline)", { uid });
    }
  }

  /** Slow tier: line/configuration info — rarely changes, so it isn't part of the fast
   * cycle (§ Polling Strategy "Slow-changing: Configuration, Line information"). */
  private async slowPoll(): Promise<void> {
    try {
      const result = await discoverAll(this.connection, this.logger.child("discovery"), { enrichWithQuery: false });
      this.discoveryResult = { ...this.discoveryResult, ...result, units: this.discoveryResult?.units ?? result.units };
    } catch (err) {
      this.log.debug("slow poll (line/config refresh) failed", { error: (err as Error).message });
    }
  }

  // ── State publishing ─────────────────────────────────────────────────────────

  private onDriverEvent(e: CoolMasterDriverEvent): void {
    if (e.type === "unit-updated") this.publishUnit(e.status);
    else if (e.type === "connection-state") this.log.info("connection state", { state: e.state });
    else if (e.type === "error") this.log.error(e.error.message, { scope: e.scope });
  }

  private publishUnit(status: CoolMasterUnitStatus): void {
    for (const b of this.bindings) {
      if (b.deviceKind === "indoor_unit" && b.uid === status.uid) {
        this.record(b.deviceId, b.capability, b.capability === "onoff" ? unitOnOffState(status) : unitTemperatureState(status));
      } else if (b.deviceKind === "group" && b.groupMembers?.includes(status.uid)) {
        this.publishGroupAggregate(b);
      }
    }
  }

  private publishFromCache(deviceId: DeviceId, capability: CapabilityKind, uid: string, deviceKind: CoolMasterDeviceKind): void {
    if (deviceKind === "indoor_unit") {
      const unit = this.unitCache.get(uid);
      if (!unit) return;
      this.record(deviceId, capability, capability === "onoff" ? unitOnOffState(unit) : unitTemperatureState(unit));
      return;
    }
    if (deviceKind === "water_heater") {
      const wh = this.discoveryResult?.waterHeaters.find((w) => w.uid === uid);
      if (!wh) return;
      this.record(deviceId, capability, capability === "onoff" ? waterHeaterOnOffState(wh) : waterHeaterTemperatureState(wh));
      return;
    }
    if (deviceKind === "ventilation") {
      const vam = this.discoveryResult?.ventilation.find((v) => v.uid === uid);
      if (vam && capability === "fan") this.record(deviceId, capability, ventilationFanState(vam));
      return;
    }
    if (deviceKind === "main_controller") {
      const main = this.discoveryResult?.mainControllers.find((m) => m.uid === uid);
      if (main && capability === "onoff") this.record(deviceId, capability, mainControllerOnOffState(main));
      return;
    }
    if (deviceKind === "group") {
      const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === capability && x.deviceKind === "group");
      if (b) this.publishGroupAggregate(b);
    }
  }

  /** Groups have no single native status read — state is aggregated from member units
   * (§ Groups "Support: ... State aggregation"): on if ANY member is on; ambient/target
   * temperature averaged across members that report one. */
  private publishGroupAggregate(b: CmBinding): void {
    if (!b.groupMembers || b.groupMembers.length === 0) return;
    const members = b.groupMembers.map((uid) => this.unitCache.get(uid)).filter((u): u is CoolMasterUnitStatus => u !== null);
    if (members.length === 0) return;
    if (b.capability === "onoff") {
      this.record(b.deviceId, "onoff", { kind: "onoff", on: members.some((m) => m.on) });
    } else if (b.capability === "temperature") {
      const roomTemps = members.map((m) => m.roomC).filter((v): v is number => v !== null);
      const setpoints = members.map((m) => m.setpointC).filter((v): v is number => v !== null);
      const onMembers = members.filter((m) => m.on);
      this.record(b.deviceId, "temperature", {
        kind: "temperature",
        ambientC: average(roomTemps) ?? 21,
        targetC: average(setpoints),
        mode: onMembers.length > 0 && onMembers[0]!.mode ? mostCommonMode(onMembers) : "off",
      });
    }
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) l({ deviceId, capability, state, ts: new Date().toISOString() });
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function mostCommonMode(units: CoolMasterUnitStatus[]): "heat" | "cool" | "auto" | "fan_only" {
  const counts = new Map<string, number>();
  for (const u of units) {
    if (!u.mode) continue;
    const key = u.mode === "dry" ? "cool" : u.mode === "fan" ? "fan_only" : u.mode;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: "heat" | "cool" | "auto" | "fan_only" = "auto";
  let bestCount = 0;
  for (const [mode, count] of counts) {
    if (count > bestCount) {
      best = mode as "heat" | "cool" | "auto" | "fan_only";
      bestCount = count;
    }
  }
  return best;
}
