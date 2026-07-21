import {
  AutomationAction,
  AutomationCondition,
  KeypadMapping,
  newId,
  type HomeId,
  type KeypadInputEvent,
  type KeypadMappingId,
  type KeypadMappingInput,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { KeypadMappingEngine } from "./mapping-engine.js";
import { InMemoryKeypadMappingStore, type IKeypadMappingStore } from "./store.js";
import { expandVariables } from "./variables.js";

/**
 * Keypad Mapping service (§ Universal Keypad Framework, deliverable 8): CRUD over
 * the mapping DSL plus the executing {@link KeypadMappingEngine} — mirrors
 * `AutomationService` exactly (reload-after-write, engine kept in sync with the
 * store). `actions`/`conditions` are accepted here as raw JSON (may contain
 * `"{{name}}"` variable references anywhere a literal would go) and are expanded +
 * validated into concrete `AutomationAction`/`AutomationCondition`s before ever
 * reaching the store or the engine (§ Optional Variables, `variables.ts`).
 */
export interface CreateKeypadMappingInput {
  homeId: HomeId;
  name: string;
  enabled?: boolean;
  input: KeypadMappingInput;
  /** Raw JSON, `AutomationCondition`-shaped once `variables` are expanded. */
  conditions?: unknown[];
  /** Raw JSON, `AutomationAction`-shaped once `variables` are expanded. */
  actions: unknown[];
  variables?: Record<string, string | number | boolean>;
}

export interface UpdateKeypadMappingInput {
  name?: string;
  enabled?: boolean;
  input?: KeypadMappingInput;
  conditions?: unknown[];
  actions?: unknown[];
  variables?: Record<string, string | number | boolean>;
}

export class KeypadMappingService {
  private readonly store: IKeypadMappingStore;
  readonly engine: KeypadMappingEngine;
  private loaded = false;

  constructor(engine: KeypadMappingEngine, store?: IKeypadMappingStore) {
    this.engine = engine;
    this.store = store ?? new InMemoryKeypadMappingStore();
  }

  /** Load persisted mappings into the engine (call on boot). */
  async start(): Promise<void> {
    await this.reload();
    this.loaded = true;
  }

  list(): Promise<KeypadMapping[]> {
    return this.store.list();
  }

  async get(id: KeypadMappingId): Promise<KeypadMapping> {
    const m = await this.store.get(id);
    if (!m) throw new SupremeError("not_found", "keypad mapping not found");
    return m;
  }

  async create(input: CreateKeypadMappingInput): Promise<KeypadMapping> {
    const variables = input.variables ?? {};
    const conditions = AutomationCondition.array().parse((input.conditions ?? []).map((c) => expandVariables(c, variables)));
    const actions = AutomationAction.array().parse(input.actions.map((a) => expandVariables(a, variables)));
    const mapping = KeypadMapping.parse({
      id: newId("keypadMapping"),
      homeId: input.homeId,
      name: input.name,
      enabled: input.enabled ?? true,
      input: input.input,
      conditions,
      actions,
      variables,
    });
    await this.store.put(mapping);
    await this.reload();
    return mapping;
  }

  async update(id: KeypadMappingId, patch: UpdateKeypadMappingInput): Promise<KeypadMapping> {
    const current = await this.get(id);
    const variables = patch.variables ?? current.variables;
    const conditions = patch.conditions
      ? AutomationCondition.array().parse(patch.conditions.map((c) => expandVariables(c, variables)))
      : current.conditions;
    const actions = patch.actions
      ? AutomationAction.array().parse(patch.actions.map((a) => expandVariables(a, variables)))
      : current.actions;
    const next = KeypadMapping.parse({
      ...current,
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      input: patch.input ?? current.input,
      conditions,
      actions,
      variables,
    });
    await this.store.put(next);
    await this.reload();
    return next;
  }

  async setEnabled(id: KeypadMappingId, enabled: boolean): Promise<KeypadMapping> {
    return this.update(id, { enabled });
  }

  async remove(id: KeypadMappingId): Promise<void> {
    await this.get(id);
    await this.store.remove(id);
    await this.reload();
  }

  /** Manually run a mapping's actions now (the future editor's "Test" button). */
  async testRun(id: KeypadMappingId): Promise<void> {
    await this.engine.run(await this.get(id));
  }

  /** Recent execution traces (optionally scoped to one mapping). */
  recentRuns(id?: KeypadMappingId, limit?: number) {
    return this.engine.recentRuns(id, limit);
  }

  /** Feed a normalized keypad input event to the engine (only once mappings are loaded). */
  onInputEvent(event: KeypadInputEvent): Promise<void> {
    return this.loaded ? this.engine.onInputEvent(event) : Promise.resolve();
  }

  private async reload(): Promise<void> {
    this.engine.setMappings(await this.store.list());
  }
}
