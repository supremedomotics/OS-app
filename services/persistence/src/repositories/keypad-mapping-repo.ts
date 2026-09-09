import type { KeypadMapping, KeypadMappingId } from "@supreme/domain-model";
import type { IKeypadMappingStore } from "@supreme/keypad-framework";
import type { SqlDb } from "../sql-db.js";

/** § Supreme Universal Keypad, Stage 2 — Postgres-backed {@link IKeypadMappingStore}, mirroring
 * `AutomationRepo` exactly (the mapping engine's own doc comment: "a keypad mapping's actions
 * ARE automation actions, by design"). The Stage 2 additions (`behavior`/`target`/
 * `behaviorState`) round-trip the same way every other JSONB column here does — `KeypadMapping.
 * parse()` is the single source of truth for defaults, never re-derived in SQL. */
interface KeypadMappingRow {
  id: string;
  home_id: string;
  name: string;
  enabled: boolean;
  input: KeypadMapping["input"];
  conditions: KeypadMapping["conditions"];
  actions: KeypadMapping["actions"];
  behavior: string;
  target: KeypadMapping["target"];
  behavior_state: KeypadMapping["behaviorState"];
  variables: KeypadMapping["variables"];
}

function rowToMapping(r: KeypadMappingRow): KeypadMapping {
  return {
    id: r.id as KeypadMappingId,
    homeId: r.home_id as KeypadMapping["homeId"],
    name: r.name,
    enabled: r.enabled,
    input: r.input,
    conditions: r.conditions,
    actions: r.actions,
    behavior: r.behavior as KeypadMapping["behavior"],
    target: r.target,
    behaviorState: r.behavior_state,
    variables: r.variables,
  };
}

const J = (v: unknown) => JSON.stringify(v);

export class KeypadMappingRepo implements IKeypadMappingStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<KeypadMapping[]> {
    const { rows } = await this.db.query<KeypadMappingRow>("SELECT * FROM keypad_mappings ORDER BY name");
    return rows.map(rowToMapping);
  }
  async get(id: KeypadMappingId): Promise<KeypadMapping | null> {
    const { rows } = await this.db.query<KeypadMappingRow>("SELECT * FROM keypad_mappings WHERE id=$1", [id]);
    return rows[0] ? rowToMapping(rows[0]) : null;
  }
  async put(m: KeypadMapping): Promise<void> {
    await this.db.query(
      `INSERT INTO keypad_mappings (id, home_id, name, enabled, input, conditions, actions, behavior, target, behavior_state, variables)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name=$3, enabled=$4, input=$5::jsonb, conditions=$6::jsonb, actions=$7::jsonb,
         behavior=$8, target=$9::jsonb, behavior_state=$10::jsonb, variables=$11::jsonb`,
      [m.id, m.homeId, m.name, m.enabled, J(m.input), J(m.conditions), J(m.actions), m.behavior, J(m.target), J(m.behaviorState), J(m.variables)],
    );
  }
  async remove(id: KeypadMappingId): Promise<void> {
    await this.db.query("DELETE FROM keypad_mappings WHERE id=$1", [id]);
  }
}
