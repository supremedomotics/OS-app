import type { Home, HomeId, User, UserId } from "@supreme/domain-model";
import type { IIdentityStore, StoredCredential } from "@supreme/identity";
import type { SqlDb } from "../sql-db.js";

interface HomeRow {
  id: string;
  name: string;
  address: string | null;
  tier: string;
  master_user_id: string;
  created_at: string;
}
interface UserRow {
  id: string;
  home_id: string;
  email: string;
  phone: string | null;
  display_name: string;
  user_type: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}
interface CredRow {
  user_id: string;
  password_hash: string;
  mfa_secret: string | null;
  recovery_codes: string[] | null;
}

export function rowToHome(r: HomeRow): Home {
  return {
    id: r.id as HomeId,
    name: r.name,
    address: r.address,
    tier: r.tier as Home["tier"],
    masterUserId: r.master_user_id as UserId,
    createdAt: r.created_at,
  };
}

export function rowToUser(r: UserRow): User {
  return {
    id: r.id as UserId,
    homeId: r.home_id as HomeId,
    email: r.email,
    phone: r.phone,
    displayName: r.display_name,
    userType: r.user_type as User["userType"],
    status: r.status as User["status"],
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Postgres-backed {@link IIdentityStore}. */
export class IdentityRepo implements IIdentityStore {
  constructor(private readonly db: SqlDb) {}

  async getHome(): Promise<Home | null> {
    const { rows } = await this.db.query<HomeRow>("SELECT * FROM homes LIMIT 1");
    return rows[0] ? rowToHome(rows[0]) : null;
  }
  async putHome(home: Home): Promise<void> {
    await this.db.query(
      `INSERT INTO homes (id, name, address, tier, master_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, address=$3, tier=$4, master_user_id=$5`,
      [home.id, home.name, home.address, home.tier, home.masterUserId, home.createdAt],
    );
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [email],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }
  async getUser(id: UserId): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>("SELECT * FROM users WHERE id=$1", [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }
  async listUsers(): Promise<User[]> {
    const { rows } = await this.db.query<UserRow>("SELECT * FROM users ORDER BY created_at");
    return rows.map(rowToUser);
  }
  async putUser(user: User): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id, home_id, email, phone, display_name, user_type, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         email=$3, phone=$4, display_name=$5, user_type=$6, status=$7, expires_at=$9`,
      [
        user.id,
        user.homeId,
        user.email,
        user.phone,
        user.displayName,
        user.userType,
        user.status,
        user.createdAt,
        user.expiresAt,
      ],
    );
  }

  async deleteUser(id: UserId): Promise<void> {
    // Remove the user's dependent rows first (favorites/grants/sessions carry a plain user_id, no FK),
    // then the user itself — `auth_credentials` is FK ON DELETE CASCADE, so it goes automatically.
    await this.db.query("DELETE FROM favorites WHERE user_id=$1", [id]);
    await this.db.query("DELETE FROM grants WHERE user_id=$1", [id]);
    await this.db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await this.db.query("DELETE FROM users WHERE id=$1", [id]);
  }

  async getCredential(userId: UserId): Promise<StoredCredential | null> {
    const { rows } = await this.db.query<CredRow>(
      "SELECT * FROM auth_credentials WHERE user_id=$1",
      [userId],
    );
    const r = rows[0];
    return r
      ? { userId: r.user_id as UserId, passwordHash: r.password_hash, mfaSecret: r.mfa_secret, recoveryCodes: r.recovery_codes ?? [] }
      : null;
  }
  async putCredential(cred: StoredCredential): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_credentials (user_id, password_hash, mfa_secret, recovery_codes)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET password_hash=$2, mfa_secret=$3, recovery_codes=$4::jsonb`,
      [cred.userId, cred.passwordHash, cred.mfaSecret, JSON.stringify(cred.recoveryCodes ?? [])],
    );
  }
}
