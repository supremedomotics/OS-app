import type { UserId } from "@supreme/domain-model";
import type { ISessionStore, Session } from "@supreme/identity";
import type { SqlDb } from "../sql-db.js";

interface SessionRow {
  id: string;
  user_id: string;
  current_jti: string;
  revoked: boolean;
  created_at: string;
  ip: string | null;
  user_agent: string | null;
  last_seen_at: string | null;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id as UserId,
    currentJti: r.current_jti,
    revoked: r.revoked,
    createdAt: r.created_at,
    ip: r.ip ?? null,
    userAgent: r.user_agent ?? null,
    lastSeenAt: r.last_seen_at ?? null,
  };
}

/** Postgres-backed {@link ISessionStore} — revocation/rotation + login history survive restarts. */
export class SessionRepo implements ISessionStore {
  constructor(private readonly db: SqlDb) {}

  async create(session: Session): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (id, user_id, current_jti, revoked, created_at, ip, user_agent, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET current_jti=$3, revoked=$4, last_seen_at=$8`,
      [
        session.id,
        session.userId,
        session.currentJti,
        session.revoked,
        session.createdAt,
        session.ip ?? null,
        session.userAgent ?? null,
        session.lastSeenAt ?? null,
      ],
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
  async listByUser(userId: UserId): Promise<Session[]> {
    const { rows } = await this.db.query<SessionRow>(
      "SELECT * FROM sessions WHERE user_id=$1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToSession);
  }
  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.db.query("UPDATE sessions SET last_seen_at=$2 WHERE id=$1", [id, lastSeenAt]);
  }
}
