import type { UserId } from "@supreme/domain-model";
import type { IPushTokenStore, PushPlatform, PushToken } from "@supreme/notifications";
import type { SqlDb } from "../sql-db.js";

interface TokenRow {
  id: string;
  user_id: string;
  platform: string;
  push_token: string;
  created_at: string;
  last_seen_at: string;
}

function rowToToken(r: TokenRow): PushToken {
  return {
    id: r.id,
    userId: r.user_id as UserId,
    platform: r.platform as PushPlatform,
    token: r.push_token,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

/** Postgres-backed {@link IPushTokenStore} — device push tokens survive restarts. */
export class PushTokenRepo implements IPushTokenStore {
  constructor(private readonly db: SqlDb) {}

  async register(token: PushToken): Promise<void> {
    await this.db.query(
      `INSERT INTO device_clients (id, user_id, platform, push_token, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (push_token)
       DO UPDATE SET user_id=$2, platform=$3, last_seen_at=$6`,
      [token.id, token.userId, token.platform, token.token, token.createdAt, token.lastSeenAt],
    );
  }

  async remove(token: string): Promise<void> {
    await this.db.query("DELETE FROM device_clients WHERE push_token=$1", [token]);
  }

  async listForUser(userId: UserId): Promise<PushToken[]> {
    const { rows } = await this.db.query<TokenRow>(
      "SELECT * FROM device_clients WHERE user_id=$1",
      [userId],
    );
    return rows.map(rowToToken);
  }

  async listAll(): Promise<PushToken[]> {
    const { rows } = await this.db.query<TokenRow>("SELECT * FROM device_clients");
    return rows.map(rowToToken);
  }
}
