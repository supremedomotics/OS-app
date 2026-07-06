import type { UserId } from "@supreme/domain-model";
import type { ApiTokenRecord, ApiTokenRecordMeta, IApiTokenStore } from "@supreme/identity";
import type { SqlDb } from "../sql-db.js";

interface ApiTokenRow {
  id: string;
  home_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

const META_COLS = "id, home_id, user_id, name, prefix, created_at, last_used_at, revoked";

function rowToMeta(r: Omit<ApiTokenRow, "token_hash">): ApiTokenRecordMeta {
  return {
    id: r.id,
    homeId: r.home_id,
    userId: r.user_id as UserId,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
    revoked: r.revoked,
  };
}

/** Postgres-backed API-token store (§ Security Center). Metadata queries never load the hash. */
export class ApiTokenRepo implements IApiTokenStore {
  constructor(private readonly db: SqlDb) {}

  async create(rec: ApiTokenRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO api_tokens (id, home_id, user_id, name, token_hash, prefix, created_at, last_used_at, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [rec.id, rec.homeId, rec.userId, rec.name, rec.tokenHash, rec.prefix, rec.createdAt, rec.lastUsedAt, rec.revoked],
    );
  }

  async findByHash(hash: string): Promise<ApiTokenRecord | null> {
    const { rows } = await this.db.query<ApiTokenRow>("SELECT * FROM api_tokens WHERE token_hash=$1", [hash]);
    const r = rows[0];
    return r ? { ...rowToMeta(r), tokenHash: r.token_hash } : null;
  }

  async listByUser(userId: UserId): Promise<ApiTokenRecordMeta[]> {
    const { rows } = await this.db.query<Omit<ApiTokenRow, "token_hash">>(
      `SELECT ${META_COLS} FROM api_tokens WHERE user_id=$1 AND revoked=FALSE ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(rowToMeta);
  }

  async get(userId: UserId, id: string): Promise<ApiTokenRecord | null> {
    const { rows } = await this.db.query<ApiTokenRow>("SELECT * FROM api_tokens WHERE user_id=$1 AND id=$2", [userId, id]);
    const r = rows[0];
    return r ? { ...rowToMeta(r), tokenHash: r.token_hash } : null;
  }

  async revoke(userId: UserId, id: string): Promise<void> {
    await this.db.query("UPDATE api_tokens SET revoked=TRUE WHERE user_id=$1 AND id=$2", [userId, id]);
  }

  async touch(id: string, lastUsedAt: string): Promise<void> {
    await this.db.query("UPDATE api_tokens SET last_used_at=$2 WHERE id=$1", [id, lastUsedAt]);
  }
}
