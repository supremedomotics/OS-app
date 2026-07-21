import type {
  AutomationId,
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  Device,
  DeviceId,
  IntentTarget,
  NotificationLevel,
  SceneId,
  UserId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { CapabilityIndex } from "./capability-index.js";
import { validateIntentParams } from "./param-validation.js";
import type { IntentRegistry } from "./registry.js";

/**
 * The Intent Engine's executor seam (§ Universal Intent & Capability Engine).
 * Deliberately generic — like `AutomationExecutors`, this package never imports
 * a concrete service (`@supreme/scenes`, `@supreme/security`, …); the gateway
 * composition root wires these closures to the real services, keeping
 * `@supreme/intent-engine` protocol- AND service-agnostic.
 */
export interface IntentEngineExecutors {
  /** Write a concrete capability command to a device (via the SIL). */
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  /** Read a device's current capability state — for relative operations
   * (`IncreaseBrightness`) and translators that need to know the current value. */
  getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null>;
  /** Optional: a device's real driver-reported capability config (e.g. an AVR's
   * input list). Absent (or returning `null`) → translators requiring it fail
   * with an honest error rather than guessing (see `catalog.ts`'s `inputNext`). */
  getCapabilityConfig?(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null>;
  activateScene(sceneId: SceneId): Promise<void>;
  runAutomation(automationId: AutomationId): Promise<void>;
  notify(input: { level: NotificationLevel; title: string; body: string; userId: UserId | null }): Promise<void>;
  /** Security panel operations — optional; a hub with no security surface wired
   * simply omits this, and Arm/Disarm/Panic fail with an honest
   * `backend_unavailable` rather than a fake no-op. */
  security?: {
    arm(mode: "armed_home" | "armed_away" | "armed_night"): Promise<void>;
    disarm(): Promise<void>;
    panic(): Promise<void>;
  };
}

export interface IntentEngineOptions {
  registry: IntentRegistry<IntentEngineExecutors>;
  capabilityIndex: CapabilityIndex;
  executors: IntentEngineExecutors;
  /** How many recent execution records to retain (mirrors the Automation/Mapping
   * Engines' debugger history). */
  historyLimit?: number;
  /** Monotonic clock for durations (tests can inject); defaults to Date.now. */
  now?: () => number;
}

/** One Intent execution trace — same shape/purpose as `AutomationRun`/
 * `KeypadMappingRun`, so the three engines are observable identically. */
export interface IntentRun {
  id: string;
  intentId: string;
  target: IntentTarget;
  startedAt: string;
  resolvedDeviceIds: DeviceId[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

export class IntentEngine {
  private readonly registry: IntentRegistry<IntentEngineExecutors>;
  private readonly capabilityIndex: CapabilityIndex;
  private readonly executors: IntentEngineExecutors;
  private readonly runs: IntentRun[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private runSeq = 0;

  constructor(opts: IntentEngineOptions) {
    this.registry = opts.registry;
    this.capabilityIndex = opts.capabilityIndex;
    this.executors = opts.executors;
    this.historyLimit = opts.historyLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  recentRuns(intentId?: string, limit = 50): IntentRun[] {
    const all = intentId ? this.runs.filter((r) => r.intentId === intentId) : this.runs;
    return all.slice(-limit).reverse();
  }

  /**
   * Run one Intent against a target — the whole
   * "Universal Intent → Capability Engine → Best Device Capability → Driver
   * Adapter" pipeline in one call. Always records a run trace, even on failure;
   * always re-throws so a caller (a keypad mapping, an automation action, a
   * direct REST invocation) sees the failure too and can record its own trace.
   */
  async run(intentId: string, target: IntentTarget, params: Record<string, unknown> = {}): Promise<IntentRun> {
    const started = new Date();
    const t0 = this.now();
    let resolvedDeviceIds: DeviceId[] = [];
    try {
      const registration = this.registry.get(intentId);
      if (!registration) throw new SupremeError("not_found", `intent "${intentId}" is not registered`);
      const { definition } = registration;
      if (!definition.targetKinds.includes(target.kind)) {
        throw new SupremeError(
          "validation_failed",
          `intent "${intentId}" does not accept a "${target.kind}" target (accepts: ${definition.targetKinds.join(", ")})`,
        );
      }
      const resolvedParams = validateIntentParams(definition, params);

      if (definition.requiredCapabilities.length === 0) {
        // System-level: no device/capability resolution at all.
        if (!registration.runSystem) {
          throw new SupremeError("conflict", `intent "${intentId}" has no runSystem handler wired`);
        }
        await registration.runSystem({ target, params: resolvedParams, executors: this.executors });
      } else {
        const devices = this.resolveDevices(definition.requiredCapabilities, target);
        if (devices.length === 0) {
          throw new SupremeError(
            "backend_unavailable",
            `no device compatible with intent "${intentId}" was found for this target`,
          );
        }
        if (!registration.translate) {
          throw new SupremeError("conflict", `intent "${intentId}" has no translate handler wired`);
        }
        resolvedDeviceIds = devices.map((d) => d.id);
        for (const device of devices) {
          const capability = definition.requiredCapabilities.find((k) => device.capabilities.some((c) => c.kind === k));
          if (!capability) continue; // resolveDevices already filtered on this; defensive only
          const state = await this.executors.getState(device.id, capability);
          const capabilityConfig = this.executors.getCapabilityConfig
            ? await this.executors.getCapabilityConfig(device.id, capability)
            : null;
          const command = registration.translate({ params: resolvedParams, state, capabilityConfig });
          await this.executors.command(device.id, command);
        }
      }

      return this.record({
        id: `int-${started.getTime()}-${this.runSeq++}`,
        intentId,
        target,
        startedAt: started.toISOString(),
        resolvedDeviceIds,
        durationMs: this.now() - t0,
        ok: true,
      });
    } catch (err) {
      this.record({
        id: `int-${started.getTime()}-${this.runSeq++}`,
        intentId,
        target,
        startedAt: started.toISOString(),
        resolvedDeviceIds,
        durationMs: this.now() - t0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Capability Resolution (§ Universal Intent & Capability Engine): find every
   * device satisfying one of the intent's required capabilities, scoped to the
   * target — O(matching devices), never O(every device on the hub). */
  private resolveDevices(requiredCapabilities: CapabilityKind[], target: IntentTarget): Device[] {
    if (target.kind === "device") {
      const device = this.capabilityIndex.get(target.deviceId);
      if (!device) return [];
      const supports = requiredCapabilities.some((k) => device.capabilities.some((c) => c.kind === k));
      return supports ? [device] : [];
    }
    if (target.kind === "room") {
      const seen = new Set<DeviceId>();
      const result: Device[] = [];
      for (const kind of requiredCapabilities) {
        for (const device of this.capabilityIndex.devicesWithCapabilityInRoom(kind, target.roomId)) {
          if (!seen.has(device.id)) {
            seen.add(device.id);
            result.push(device);
          }
        }
      }
      return result;
    }
    return []; // scene/automation/home targets never reach here — those are always system-level intents
  }

  private record(run: IntentRun): IntentRun {
    this.runs.push(run);
    if (this.runs.length > this.historyLimit) this.runs.shift();
    return run;
  }
}
