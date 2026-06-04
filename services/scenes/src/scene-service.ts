import {
  CapabilityCommand,
  newId,
  type HomeId,
  type Scene,
  type SceneId,
  type SceneStep,
  type UserId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";
import { InMemorySceneStore, type ISceneStore } from "./store.js";

/**
 * Scene service (§10). Scene definitions are Supreme-owned; activation compiles
 * each step into a Supreme capability command and dispatches it through the SIL.
 * Because activation never touches HA scene entities, a scene authored today keeps
 * working when the backend migrates to a Supreme-native engine.
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
}

export class SceneService {
  private readonly store: ISceneStore;

  constructor(
    private readonly sil: SupremeIntegrationLayer,
    store?: ISceneStore,
  ) {
    this.store = store ?? new InMemorySceneStore();
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
    };
    await this.store.put(scene);
    return scene;
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
   * Activate a scene: dispatch each step as a capability command. Steps are
   * dispatched concurrently; a step whose values don't form a valid command is
   * skipped (defensive — a corrupt definition shouldn't abort the whole scene).
   * Returns the number of steps successfully dispatched.
   */
  async activate(id: SceneId): Promise<number> {
    const scene = await this.get(id);
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
}
