import type { UserId } from "@supreme/domain-model";
import type { ISessionStore, Session } from "@supreme/identity";
import type { SqlDb } from "../sql-db.js";

interface SessionRow {
  id: string;
  user_id: string;
  current_jti: string;
  revoked: boolean;
  created_at: string;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id as UserId,
    currentJti: r.current_jti,
    revoked: r.revoked,
    createdAt: r.created_at,
  };
}

/** Postgres-backed {@link ISessionStore} — revocation/rotation survives restarts. */
export class SessionRepo implements ISessionStore {
  constructor(private readonly db: SqlDb) {}

  async create(session: Session): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (id, user_id, current_jti, revoked, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET current_jti=$3, revoked=$4`,
      [session.id, session.userId, session.currentJti, session.revoked, session.createdAt],
    );
  }
  async get(id: string): Promise<Session | null> {
    const { rows } = await this.db.query<SessionRow>("SELECT * FROM sessions WHERE id=$1", [id]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }
  async setCurrentJti(id: string, jti: string): Promise<void> {
    await this.db.query("UPDATE sessions SET current_jti=$2 WHERE id=$1", [id, jti]);
  }
  async revoke(id: string): Promise<void> {
    await this.db.query("UPDATE sessions SET revoked=TRUE WHERE id=$1", [id]);
  }
}
