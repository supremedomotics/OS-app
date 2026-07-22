import {
  CapabilityCommand,
  newId,
  type Automation,
  type AutomationAction,
  type HomeId,
  type Scene,
  type SceneId,
  type SceneStep,
  type UserId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";
import type { AutomationEngine } from "@supreme/automations";
import { InMemorySceneStore, type ISceneStore } from "./store.js";

/**
 * Scene service (§10, § ADR 0101 Part 1). Scenes are Supreme-owned, specialized Automations
 * (§ ADR 0100 §8 — never a second Runtime Object type, never a second execution engine).
 * Activation compiles each step into a Supreme capability command and runs it through the
 * SAME `AutomationEngine` real automations use (`runConcurrent` — best-effort, all steps
 * attempted, matching a scene's semantics), so execution history/health reuse the existing
 * Automation Debugger infrastructure automatically. When no engine is attached (older
 * call sites, unit tests) activation falls back to dispatching straight through the SIL —
 * functionally identical, just without a recorded run.
 */
export interface CreateSceneInput {
  homeId: HomeId;
  name: string;
  scope?: "room" | "home";
  roomId?: string | null;
  icon?: string | null;
  ownerUserId?: UserId | null;
  aiGenerated?: boolean;
  steps: SceneStep[];
  sourceDriverId?: string | null;
  sourceSceneId?: string | null;
  imported?: boolean;
}

export class SceneService {
  private readonly store: ISceneStore;
  private engine: AutomationEngine | null = null;

  constructor(
    private readonly sil: SupremeIntegrationLayer,
    store?: ISceneStore,
  ) {
    this.store = store ?? new InMemorySceneStore();
  }

  /** Wired once, after the Automation Engine is constructed (§ ADR 0101 Part 1) — scenes and
   * automations are built in the gateway's composition root in that order, so this is a
   * post-construction attach rather than a constructor argument. */
  attachEngine(engine: AutomationEngine): void {
    this.engine = engine;
  }

  list(): Promise<Scene[]> {
    return this.store.list();
  }

  async get(id: SceneId): Promise<Scene> {
    const scene = await this.store.get(id);
    if (!scene) throw new SupremeError("not_found", "scene not found");
    return scene;
  }

  async create(input: CreateSceneInput): Promise<Scene> {
    const scene: Scene = {
      id: newId("scene") as SceneId,
      homeId: input.homeId,
      name: input.name,
      scope: input.scope ?? "room",
      roomId: (input.roomId ?? null) as Scene["roomId"],
      ownerUserId: (input.ownerUserId ?? null) as Scene["ownerUserId"],
      icon: input.icon ?? null,
      aiGenerated: input.aiGenerated ?? false,
      steps: input.steps,
      sourceDriverId: input.sourceDriverId ?? null,
      sourceSceneId: input.sourceSceneId ?? null,
      imported: input.imported ?? false,
      syncStatus: input.imported ? "synced" : null,
    };
    await this.store.put(scene);
    return scene;
  }

  /** § Part 1/8 — Automatic Scene Discovery + Import Conflict Resolution: upsert-by-source,
   * so re-running an importer against the same driver never creates a duplicate Runtime Scene.
   * An installer's own edits to a previously-imported scene are never silently overwritten —
   * a `steps`/`name` change on our side flips `syncStatus` to "stale" instead of being clobbered
   * by the next sync; only an explicit re-import (caller passes `force: true`) applies the
   * source's current definition over local edits. */
  async importScene(input: CreateSceneInput & { sourceDriverId: string; sourceSceneId: string; force?: boolean }): Promise<Scene> {
    const existing = await this.store.findBySource(input.sourceDriverId, input.sourceSceneId);
    if (!existing) return this.create({ ...input, imported: true });
    if (!input.force && (existing.name !== input.name || JSON.stringify(existing.steps) !== JSON.stringify(input.steps))) {
      const stale: Scene = { ...existing, syncStatus: "stale" };
      await this.store.put(stale);
      return stale;
    }
    const next: Scene = {
      ...existing,
      name: input.name,
      roomId: (input.roomId ?? existing.roomId) as Scene["roomId"],
      icon: input.icon ?? existing.icon,
      steps: input.steps,
      syncStatus: "synced",
    };
    await this.store.put(next);
    return next;
  }

  /** § Part 6 — a source scene that vanished on re-sync is archived (marked, never silently
   * deleted) so an installer sees exactly what happened instead of a scene quietly disappearing. */
  async markSourceMissing(sourceDriverId: string, sourceSceneId: string): Promise<void> {
    const existing = await this.store.findBySource(sourceDriverId, sourceSceneId);
    if (existing) await this.store.put({ ...existing, syncStatus: "source_missing" });
  }

  async update(id: SceneId, patch: Partial<CreateSceneInput>): Promise<Scene> {
    const scene = await this.get(id);
    const next: Scene = {
      ...scene,
      name: patch.name ?? scene.name,
      scope: patch.scope ?? scene.scope,
      roomId: (patch.roomId ?? scene.roomId) as Scene["roomId"],
      icon: patch.icon ?? scene.icon,
      steps: patch.steps ?? scene.steps,
    };
    await this.store.put(next);
    return next;
  }

  async remove(id: SceneId): Promise<void> {
    await this.get(id); // 404 if missing
    await this.store.remove(id);
  }

  /**
   * Activate a scene: dispatch each step as a capability command, best-effort — a step whose
   * values don't form a valid command, or that fails, is skipped rather than aborting the whole
   * scene. Returns the number of steps successfully dispatched.
   *
   * § ADR 0100 §8 / ADR 0101 Part 1: when an {@link AutomationEngine} is attached, this routes
   * through `engine.runConcurrent()` — the SAME action-dispatch and run-history primitives an
   * ordinary automation uses — instead of calling the SIL directly, so a scene's execution
   * history/health show up in the existing Automation Debugger for free. No engine attached
   * (older call sites, unit tests) falls back to the original direct-SIL dispatch.
   */
  async activate(id: SceneId): Promise<number> {
    const scene = await this.get(id);
    if (this.engine) return this.activateViaEngine(scene);
    const dispatched = await Promise.all(
      scene.steps.map(async (step) => {
        const parsed = CapabilityCommand.safeParse({ capability: step.capability, ...step.values });
        if (!parsed.success) return 0;
        try {
          await this.sil.command(step.deviceId, parsed.data);
          return 1;
        } catch {
          return 0;
        }
      }),
    );
    return dispatched.reduce<number>((a, b) => a + b, 0);
  }

  /** Runtime id a scene's synthetic Automation runs under — stable per scene, so its execution
   * history accumulates across activations exactly like a real automation's does. */
  private runtimeAutomationId(sceneId: SceneId): string {
    return `scene:${sceneId}`;
  }

  private async activateViaEngine(scene: Scene): Promise<number> {
    const actions: AutomationAction[] = [];
    for (const step of scene.steps) {
      const parsed = CapabilityCommand.safeParse({ capability: step.capability, ...step.values });
      if (parsed.success) actions.push({ type: "device_command", deviceId: step.deviceId, command: parsed.data });
    }
    const synthetic: Automation = {
      id: this.runtimeAutomationId(scene.id) as Automation["id"],
      homeId: scene.homeId,
      name: scene.name,
      enabled: true,
      triggers: [],
      conditions: [],
      actions,
      engine: "supreme",
      externalRef: null,
      aiGenerated: scene.aiGenerated,
      tags: [],
    };
    const run = await this.engine!.runConcurrent(synthetic, "manual");
    return run.actions.filter((a) => a.ok).length;
  }

  /** § Part 5 — Execution history reuses the existing Automation Debugger infrastructure. */
  recentRuns(id: SceneId, limit?: number) {
    return this.engine?.recentRuns(this.runtimeAutomationId(id), limit) ?? [];
  }

  /** § Part 2 — Health, derived the exact same way an automation's is (§ Phase 1 Health). */
  async health(id: SceneId) {
    if (!this.engine) return null;
    const scene = await this.get(id);
    return this.engine.health({ id: this.runtimeAutomationId(scene.id), enabled: true } as unknown as Automation);
  }
}
