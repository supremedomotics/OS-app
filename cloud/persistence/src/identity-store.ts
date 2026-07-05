import type {
  Account,
  FederatedLink,
  FederatedProvider,
  Identity,
  IdentityKind,
  IIdentityStore,
  PasskeyRecord,
} from "@supreme/cloud-identity";
import type { SqlDb } from "./sql-db.js";

/** Postgres-backed {@link IIdentityStore} — accounts, identities, credentials, passkeys, federated. */
export class PgIdentityStore implements IIdentityStore {
  constructor(private readonly db: SqlDb) {}

  async putAccount(a: Account): Promise<void> {
    await this.db.query(
      "INSERT INTO accounts (id, status, created_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET status=$2",
      [a.id, a.status, a.createdAt],
    );
  }
  async getAccount(id: string): Promise<Account | undefined> {
    const { rows } = await this.db.query<{ id: string; status: string; created_at: string | number }>(
      "SELECT * FROM accounts WHERE id=$1",
      [id],
    );
    const r = rows[0];
    return r ? { id: r.id, status: r.status as Account["status"], createdAt: Number(r.created_at) } : undefined;
  }

  async putIdentity(i: Identity): Promise<void> {
    await this.db.query(
      `INSERT INTO identities (id, account_id, kind, value, value_lc, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, value_lc) DO NOTHING`,
      [i.id, i.accountId, i.kind, i.value, i.value.toLowerCase(), i.verifiedAt],
    );
  }
  async getIdentity(kind: IdentityKind, value: string): Promise<Identity | undefined> {
    const { rows } = await this.db.query<{
      id: string; account_id: string; kind: string; value: string; verified_at: string | number | null;
    }>("SELECT * FROM identities WHERE kind=$1 AND value_lc=$2", [kind, value.toLowerCase()]);
    const r = rows[0];
    return r
      ? { id: r.id, accountId: r.account_id, kind: r.kind as IdentityKind, value: r.value, verifiedAt: r.verified_at === null ? null : Number(r.verified_at) }
      : undefined;
  }

  async setCredential(accountId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      "INSERT INTO credentials (account_id, password_hash) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET password_hash=$2",
      [accountId, passwordHash],
    );
  }
  async getCredential(accountId: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ password_hash: string }>(
      "SELECT password_hash FROM credentials WHERE account_id=$1",
      [accountId],
    );
    return rows[0]?.password_hash;
  }

  async putPasskey(p: PasskeyRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO passkeys (id, account_id, credential_id, public_key, sign_count, name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.accountId, p.credentialId, p.publicKey, p.signCount, p.name, p.createdAt],
    );
  }
  async listPasskeys(accountId: string): Promise<PasskeyRecord[]> {
    const { rows } = await this.db.query<{
      id: string; account_id: string; credential_id: string; public_key: string; sign_count: string | number; name: string | null; created_at: string | number;
    }>("SELECT * FROM passkeys WHERE account_id=$1 ORDER BY created_at", [accountId]);
    return rows.map((r) => ({
      id: r.id, accountId: r.account_id, credentialId: r.credential_id, publicKey: r.public_key,
      signCount: Number(r.sign_count), name: r.name, createdAt: Number(r.created_at),
    }));
  }

  async putFederated(link: FederatedLink): Promise<void> {
    await this.db.query(
      `INSERT INTO federated_identities (provider, subject, account_id, email)
       VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO UPDATE SET account_id=$3, email=$4`,
      [link.provider, link.subject, link.accountId, link.email],
    );
  }
  async getFederated(provider: FederatedProvider, subject: string): Promise<FederatedLink | undefined> {
    const { rows } = await this.db.query<{ provider: string; subject: string; account_id: string; email: string | null }>(
      "SELECT * FROM federated_identities WHERE provider=$1 AND subject=$2",
      [provider, subject],
    );
    const r = rows[0];
    return r ? { provider: r.provider as FederatedProvider, subject: r.subject, accountId: r.account_id, email: r.email } : undefined;
  }
}
