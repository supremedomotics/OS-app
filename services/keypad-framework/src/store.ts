import type { KeypadMapping, KeypadMappingId } from "@supreme/domain-model";

/** Persistence boundary for keypad mappings — mirrors `IAutomationStore` exactly. */
export interface IKeypadMappingStore {
  list(): Promise<KeypadMapping[]>;
  get(id: KeypadMappingId): Promise<KeypadMapping | null>;
  put(mapping: KeypadMapping): Promise<void>;
  remove(id: KeypadMappingId): Promise<void>;
}

export class InMemoryKeypadMappingStore implements IKeypadMappingStore {
  private readonly items = new Map<KeypadMappingId, KeypadMapping>();
  async list(): Promise<KeypadMapping[]> {
    return [...this.items.values()];
  }
  async get(id: KeypadMappingId): Promise<KeypadMapping | null> {
    return this.items.get(id) ?? null;
  }
  async put(mapping: KeypadMapping): Promise<void> {
    this.items.set(mapping.id, mapping);
  }
  async remove(id: KeypadMappingId): Promise<void> {
    this.items.delete(id);
  }
}
