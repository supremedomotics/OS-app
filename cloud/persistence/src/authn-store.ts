import type { IAuthnStore, RefreshRecord } from "@supreme/cloud-authn";
import type { SqlDb } from "./sql-db.js";

interface RefreshRow {
  hash: string;
  session_id: string;
  family_id: string;
  account_id: string;
  device_id: string;
  created_at: string | number;
  expires_at: string | number;
  used_at: string | number | null;
  rotated_to: string | null;
  revoked_at: string | number | null;
}

const n = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * Postgres-backed {@link IAuthnStore} — durable refresh-token rotation + revocation, so a cloud
 * restart doesn't log everyone out and reuse-detection survives across instances. Revoking a
 * family/session both records the revocation AND stamps `revoked_at` on its outstanding tokens.
 */
export class PgAuthnStore implements IAuthnStore {
  constructor(private readonly db: SqlDb) {}

  async getRefresh(hash: string): Promise<RefreshRecord | undefined> {
    const { rows } = await this.db.query<RefreshRow>("SELECT * FROM refresh_tokens WHERE hash=$1", [hash]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      hash: r.hash,
      sessionId: r.session_id,
      familyId: r.family_id,
      accountId: r.account_id,
      deviceId: r.device_id,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      usedAt: n(r.used_at),
      rotatedTo: r.rotated_to,
      revokedAt: n(r.revoked_at),
    };
  }

  async putRefresh(rec: RefreshRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO refresh_tokens (hash, session_id, family_id, account_id, device_id, created_at,
                                   expires_at, used_at, rotated_to, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (hash) DO UPDATE SET used_at=$8, rotated_to=$9, revoked_at=$10`,
      [
        rec.hash, rec.sessionId, rec.familyId, rec.accountId, rec.deviceId, rec.createdAt,
        rec.expiresAt, rec.usedAt, rec.rotatedTo, rec.revokedAt,
      ],
    );
  }

  async revokeFamily(familyId: string, at: number): Promise<void> {
    await this.db.query(
      "INSERT INTO revoked_families (family_id, at) VALUES ($1,$2) ON CONFLICT (family_id) DO NOTHING",
      [familyId, at],
    );
    await this.db.query(
      "UPDATE refresh_tokens SET revoked_at=$2 WHERE family_id=$1 AND revoked_at IS NULL",
      [familyId, at],
    );
  }

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM revoked_families WHERE family_id=$1", [familyId]);
    return rows.length > 0;
  }

  async revokeSession(sessionId: string, at: number): Promise<void> {
    await this.db.query(
      "INSERT INTO revoked_sessions (session_id, at) VALUES ($1,$2) ON CONFLICT (session_id) DO NOTHING",
      [sessionId, at],
    );
    await this.db.query(
      "UPDATE refresh_tokens SET revoked_at=$2 WHERE session_id=$1 AND revoked_at IS NULL",
      [sessionId, at],
    );
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM revoked_sessions WHERE session_id=$1", [sessionId]);
    return rows.length > 0;
  }
}
