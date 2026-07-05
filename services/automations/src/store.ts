import type { Automation, AutomationId } from "@supreme/domain-model";

/** Persistence boundary for automations (§5, §10). */
export interface IAutomationStore {
  list(): Promise<Automation[]>;
  get(id: AutomationId): Promise<Automation | null>;
  put(automation: Automation): Promise<void>;
  remove(id: AutomationId): Promise<void>;
}

export class InMemoryAutomationStore implements IAutomationStore {
  private readonly items = new Map<AutomationId, Automation>();
  async list() {
    return [...this.items.values()];
  }
  async get(id: AutomationId) {
    return this.items.get(id) ?? null;
  }
  async put(a: Automation) {
    this.items.set(a.id, a);
  }
  async remove(id: AutomationId) {
    this.items.delete(id);
  }
}
