import type { Scene, SceneId } from "@supreme/domain-model";

/**
 * Scene persistence boundary (§10). Scenes are stored as Supreme definitions, not
 * coupled to HA scenes; activation is performed via capability commands so the
 * same definition works against any backend.
 */
export interface ISceneStore {
  list(): Promise<Scene[]>;
  get(id: SceneId): Promise<Scene | null>;
  put(scene: Scene): Promise<void>;
  remove(id: SceneId): Promise<void>;
}

export class InMemorySceneStore implements ISceneStore {
  private readonly scenes = new Map<SceneId, Scene>();
  async list() {
    return [...this.scenes.values()];
  }
  async get(id: SceneId) {
    return this.scenes.get(id) ?? null;
  }
  async put(scene: Scene) {
    this.scenes.set(scene.id, scene);
  }
  async remove(id: SceneId) {
    this.scenes.delete(id);
  }
}
