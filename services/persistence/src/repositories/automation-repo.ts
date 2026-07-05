import type { Automation, AutomationId, HomeId } from "@supreme/domain-model";
import type { IAutomationStore } from "@supreme/automations";
import type { SqlDb } from "../sql-db.js";

interface AutomationRow {
  id: string;
  home_id: string;
  name: string;
  enabled: boolean;
  triggers: Automation["triggers"];
  conditions: Automation["conditions"];
  actions: Automation["actions"];
  engine: string;
  external_ref: string | null;
  ai_generated: boolean;
}

function rowToAutomation(r: AutomationRow): Automation {
  return {
    id: r.id as AutomationId,
    homeId: r.home_id as HomeId,
    name: r.name,
    enabled: r.enabled,
    triggers: r.triggers,
    conditions: r.conditions,
    actions: r.actions,
    engine: r.engine as Automation["engine"],
    externalRef: r.external_ref,
    aiGenerated: r.ai_generated,
  };
}

const J = (v: unknown) => JSON.stringify(v);

/** Postgres-backed {@link IAutomationStore}. */
export class AutomationRepo implements IAutomationStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<Automation[]> {
    const { rows } = await this.db.query<AutomationRow>("SELECT * FROM automations ORDER BY name");
    return rows.map(rowToAutomation);
  }
  async get(id: AutomationId): Promise<Automation | null> {
    const { rows } = await this.db.query<AutomationRow>("SELECT * FROM automations WHERE id=$1", [id]);
    return rows[0] ? rowToAutomation(rows[0]) : null;
  }
  async put(a: Automation): Promise<void> {
    await this.db.query(
      `INSERT INTO automations (id, home_id, name, enabled, triggers, conditions, actions, engine, external_ref, ai_generated)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         name=$3, enabled=$4, triggers=$5::jsonb, conditions=$6::jsonb, actions=$7::jsonb,
         engine=$8, external_ref=$9, ai_generated=$10`,
      [a.id, a.homeId, a.name, a.enabled, J(a.triggers), J(a.conditions), J(a.actions), a.engine, a.externalRef, a.aiGenerated],
    );
  }
  async remove(id: AutomationId): Promise<void> {
    await this.db.query("DELETE FROM automations WHERE id=$1", [id]);
  }
}
