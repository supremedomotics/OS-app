import {
  newId,
  type Automation,
  type AutomationAction,
  type AutomationCondition,
  type AutomationId,
  type AutomationTrigger,
  type HomeId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { AutomationEngine, type DeviceStateEvent } from "./engine.js";
import { InMemoryAutomationStore, type IAutomationStore } from "./store.js";

/**
 * Automation service (§10): CRUD over the DSL plus a native execution engine. After
 * any change it reloads the engine so edits take effect immediately. Device-state
 * deltas and a once-per-minute clock are fed in by the gateway composition root.
 */
export interface CreateAutomationInput {
  homeId: HomeId;
  name: string;
  triggers: AutomationTrigger[];
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
  engine?: "ha" | "supreme";
  enabled?: boolean;
  aiGenerated?: boolean;
}

export class AutomationService {
  private readonly store: IAutomationStore;
  readonly engine: AutomationEngine;
  private loaded = false;

  constructor(engine: AutomationEngine, store?: IAutomationStore) {
    this.engine = engine;
    this.store = store ?? new InMemoryAutomationStore();
  }

  /** Load persisted automations into the engine (call on boot). */
  async start(): Promise<void> {
    await this.reload();
    this.loaded = true;
  }

  list(): Promise<Automation[]> {
    return this.store.list();
  }

  async get(id: AutomationId): Promise<Automation> {
    const a = await this.store.get(id);
    if (!a) throw new SupremeError("not_found", "automation not found");
    return a;
  }

  async create(input: CreateAutomationInput): Promise<Automation> {
    const automation: Automation = {
      id: newId("automation") as AutomationId,
      homeId: input.homeId,
      name: input.name,
      enabled: input.enabled ?? true,
      triggers: input.triggers,
      conditions: input.conditions ?? [],
      actions: input.actions,
      engine: input.engine ?? "supreme",
      externalRef: null,
      aiGenerated: input.aiGenerated ?? false,
    };
    await this.store.put(automation);
    await this.reload();
    return automation;
  }

  async update(id: AutomationId, patch: Partial<CreateAutomationInput>): Promise<Automation> {
    const current = await this.get(id);
    const next: Automation = {
      ...current,
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      triggers: patch.triggers ?? current.triggers,
      conditions: patch.conditions ?? current.conditions,
      actions: patch.actions ?? current.actions,
      engine: patch.engine ?? current.engine,
    };
    await this.store.put(next);
    await this.reload();
    return next;
  }

  async setEnabled(id: AutomationId, enabled: boolean): Promise<Automation> {
    return this.update(id, { enabled });
  }

  async remove(id: AutomationId): Promise<void> {
    await this.get(id);
    await this.store.remove(id);
    await this.reload();
  }

  /** Manually run an automation's actions now (the Builder's "Test" button). */
  async testRun(id: AutomationId): Promise<void> {
    await this.engine.run(await this.get(id));
  }

  /** Recent execution traces for the Automation Debugger (optionally scoped to one automation). */
  recentRuns(id?: AutomationId, limit?: number) {
    return this.engine.recentRuns(id, limit);
  }

  /** Feed a normalized device-state delta to the engine. */
  onDeviceState(event: DeviceStateEvent): Promise<void> {
    return this.loaded ? this.engine.onDeviceState(event) : Promise.resolve();
  }

  /** Drive time/interval triggers (gateway calls this once a minute). */
  tick(now?: Date): Promise<void> {
    return this.engine.tick(now);
  }

  private async reload(): Promise<void> {
    this.engine.setAutomations(await this.store.list());
  }
}
