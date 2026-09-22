/**
 * (§ Matter Controller Extension, Phase 2 — Persistence)
 *
 * Persists the Controller's discovered `MatterNodeModel`s — separate from the Matter
 * Bridge's own endpoint-registry file (`../matter-bridge/endpoint-registry.ts`), separate
 * from `@matter/main`'s own fabric/credential storage (which stays authoritative for
 * protocol identity — this store never duplicates certs/keys, per § requirement 10), and
 * separate from the SupremeOS device database. A plain JSON file, same shape of choice as
 * the Bridge's `FileMatterEndpointStore` for the same reason it documents: this is small,
 * infrequently-written, diagnosable-by-hand data, not a workload that needs a database.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MatterNodeModel } from "./device-model.js";

export interface MatterDeviceModelStore {
  get(nodeId: string): MatterNodeModel | undefined;
  put(model: MatterNodeModel): void;
  remove(nodeId: string): void;
  all(): MatterNodeModel[];
}

export class InMemoryMatterDeviceModelStore implements MatterDeviceModelStore {
  private readonly models = new Map<string, MatterNodeModel>();
  get(nodeId: string): MatterNodeModel | undefined {
    return this.models.get(nodeId);
  }
  put(model: MatterNodeModel): void {
    this.models.set(model.nodeId, model);
  }
  remove(nodeId: string): void {
    this.models.delete(nodeId);
  }
  all(): MatterNodeModel[] {
    return [...this.models.values()];
  }
}

/** File-backed store — the whole file is a `MatterNodeModel[]`, rewritten in full on every
 * mutation (mirrors `matter-bridge/endpoint-registry.ts`'s `FileMatterEndpointStore`; this
 * data is small and infrequently written). Never stores Matter credentials/keys — only the
 * discovery-derived model (§ requirement 10). */
export class FileMatterDeviceModelStore implements MatterDeviceModelStore {
  private readonly cache = new Map<string, MatterNodeModel>();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8");
      const parsed: unknown = raw.trim() === "" ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error(`matter-controller: corrupt device model store at ${filePath}`);
      for (const entry of parsed as MatterNodeModel[]) {
        if (this.cache.has(entry.nodeId)) {
          throw new Error(`matter-controller: duplicate nodeId ${entry.nodeId} in device model store`);
        }
        this.cache.set(entry.nodeId, entry);
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  get(nodeId: string): MatterNodeModel | undefined {
    return this.cache.get(nodeId);
  }

  put(model: MatterNodeModel): void {
    this.cache.set(model.nodeId, model);
    this.flush();
  }

  remove(nodeId: string): void {
    this.cache.delete(nodeId);
    this.flush();
  }

  all(): MatterNodeModel[] {
    return [...this.cache.values()];
  }

  private flush(): void {
    writeFileSync(this.filePath, JSON.stringify([...this.cache.values()], null, 2), { mode: 0o600 });
  }
}
