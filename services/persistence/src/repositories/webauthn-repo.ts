import type { UserId } from "@supreme/domain-model";
import type { IWebAuthnStore, WebAuthnCredentialMeta, WebAuthnCredentialRecord } from "@supreme/identity";
import type { SqlDb } from "../sql-db.js";

interface Row {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_pem: string;
  sign_count: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const META_COLS = "id, user_id, credential_id, sign_count, name, created_at, last_used_at";

function rowToMeta(r: Omit<Row, "public_key_pem">): WebAuthnCredentialMeta {
  return {
    id: r.id,
    userId: r.user_id as UserId,
    credentialId: r.credential_id,
    signCount: r.sign_count,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  };
}

/** Postgres-backed passkey/WebAuthn credential store (§ Security Center). */
export class WebAuthnRepo implements IWebAuthnStore {
  constructor(private readonly db: SqlDb) {}

  async create(rec: WebAuthnCredentialRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key_pem, sign_count, name, created_at, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rec.id, rec.userId, rec.credentialId, rec.publicKeyPem, rec.signCount, rec.name, rec.createdAt, rec.lastUsedAt],
    );
  }

  async findByCredentialId(credentialId: string): Promise<WebAuthnCredentialRecord | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM webauthn_credentials WHERE credential_id=$1", [credentialId]);
    const r = rows[0];
    return r ? { ...rowToMeta(r), publicKeyPem: r.public_key_pem } : null;
  }

  async listByUser(userId: UserId): Promise<WebAuthnCredentialMeta[]> {
    const { rows } = await this.db.query<Omit<Row, "public_key_pem">>(
      `SELECT ${META_COLS} FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(rowToMeta);
  }

  async get(userId: UserId, id: string): Promise<WebAuthnCredentialRecord | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM webauthn_credentials WHERE user_id=$1 AND id=$2", [userId, id]);
    const r = rows[0];
    return r ? { ...rowToMeta(r), publicKeyPem: r.public_key_pem } : null;
  }

  async updateSignCount(id: string, signCount: number, lastUsedAt: string): Promise<void> {
    await this.db.query("UPDATE webauthn_credentials SET sign_count=$2, last_used_at=$3 WHERE id=$1", [id, signCount, lastUsedAt]);
  }

  async remove(userId: UserId, id: string): Promise<void> {
    await this.db.query("DELETE FROM webauthn_credentials WHERE user_id=$1 AND id=$2", [userId, id]);
  }
}
