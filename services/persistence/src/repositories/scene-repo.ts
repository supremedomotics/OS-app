import type { HomeId, RoomId, Scene, SceneId, UserId } from "@supreme/domain-model";
import type { ISceneStore } from "@supreme/scenes";
import type { SqlDb } from "../sql-db.js";

interface SceneRow {
  id: string;
  home_id: string;
  name: string;
  scope: string;
  room_id: string | null;
  owner_user_id: string | null;
  icon: string | null;
  ai_generated: boolean;
  steps: Scene["steps"];
}

function rowToScene(r: SceneRow): Scene {
  return {
    id: r.id as SceneId,
    homeId: r.home_id as HomeId,
    name: r.name,
    scope: r.scope as Scene["scope"],
    roomId: (r.room_id as RoomId | null) ?? null,
    ownerUserId: (r.owner_user_id as UserId | null) ?? null,
    icon: r.icon,
    aiGenerated: r.ai_generated,
    steps: r.steps,
  };
}

/** Postgres-backed {@link ISceneStore}. */
export class SceneRepo implements ISceneStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<Scene[]> {
    const { rows } = await this.db.query<SceneRow>("SELECT * FROM scenes ORDER BY name");
    return rows.map(rowToScene);
  }
  async get(id: SceneId): Promise<Scene | null> {
    const { rows } = await this.db.query<SceneRow>("SELECT * FROM scenes WHERE id=$1", [id]);
    return rows[0] ? rowToScene(rows[0]) : null;
  }
  async put(scene: Scene): Promise<void> {
    await this.db.query(
      `INSERT INTO scenes (id, home_id, name, scope, room_id, owner_user_id, icon, ai_generated, steps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name=$3, scope=$4, room_id=$5, owner_user_id=$6, icon=$7, ai_generated=$8, steps=$9::jsonb`,
      [
        scene.id, scene.homeId, scene.name, scene.scope, scene.roomId,
        scene.ownerUserId, scene.icon, scene.aiGenerated, JSON.stringify(scene.steps),
      ],
    );
  }
  async remove(id: SceneId): Promise<void> {
    await this.db.query("DELETE FROM scenes WHERE id=$1", [id]);
  }
}
