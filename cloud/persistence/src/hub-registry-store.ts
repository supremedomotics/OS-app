import type {
  ClaimCode,
} from "@supreme/hub-identity";
import type {
  HomeRecord,
  HubRecord,
  IHubRegistryStore,
  MembershipRecord,
} from "@supreme/hub-registry";
import type { SqlDb } from "./sql-db.js";

/**
 * Postgres-backed {@link IHubRegistryStore} — the durable hub↔account ownership graph (hubs,
 * homes, memberships) plus single-use enrollment nonces and revoked cert serials. This is what
 * takes the Hub Registry from an in-memory seam to production: an enrolled/claimed hub survives a
 * restart, anti-replay holds across process instances, and revocation is durable.
 *
 * Claim codes are intentionally kept IN-MEMORY here — they are short-lived ephemeral state
 * (Redis in a multi-instance deployment), not durable records (blueprint §6, §7).
 */
interface HubRow {
  hub_uuid: string;
  status: string;
  public_key: string;
  model: string;
  fw_version: string;
  cert_serial: string | null;
  claimed_by_account_id: string | null;
  dealer_org_id: string | null;
  created_at: string | number;
  last_seen_at: string | number | null;
}

function num(v: string | number | null): number | null {
  return v === null ? null : Number(v);
}

function rowToHub(r: HubRow): HubRecord {
  return {
    hubUuid: r.hub_uuid,
    status: r.status as HubRecord["status"],
    publicKey: r.public_key,
    model: r.model,
    fwVersion: r.fw_version,
    certSerial: r.cert_serial,
    claimedByAccountId: r.claimed_by_account_id,
    dealerOrgId: r.dealer_org_id,
    createdAt: Number(r.created_at),
    lastSeenAt: num(r.last_seen_at),
  };
}

export class PgHubRegistryStore implements IHubRegistryStore {
  private readonly claimCodes = new Map<string, ClaimCode>();
  constructor(private readonly db: SqlDb) {}

  async getHub(hubUuid: string): Promise<HubRecord | undefined> {
    const { rows } = await this.db.query<HubRow>("SELECT * FROM hubs WHERE hub_uuid = $1", [hubUuid]);
    return rows[0] ? rowToHub(rows[0]) : undefined;
  }

  async putHub(hub: HubRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO hubs (hub_uuid, status, public_key, model, fw_version, cert_serial,
                         claimed_by_account_id, dealer_org_id, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (hub_uuid) DO UPDATE SET
         status = EXCLUDED.status, public_key = EXCLUDED.public_key, model = EXCLUDED.model,
         fw_version = EXCLUDED.fw_version, cert_serial = EXCLUDED.cert_serial,
         claimed_by_account_id = EXCLUDED.claimed_by_account_id,
         dealer_org_id = EXCLUDED.dealer_org_id, last_seen_at = EXCLUDED.last_seen_at`,
      [
        hub.hubUuid, hub.status, hub.publicKey, hub.model, hub.fwVersion, hub.certSerial,
        hub.claimedByAccountId, hub.dealerOrgId, hub.createdAt, hub.lastSeenAt,
      ],
    );
  }

  async listHubsForAccount(accountId: string): Promise<HubRecord[]> {
    const { rows } = await this.db.query<HubRow>(
      "SELECT * FROM hubs WHERE claimed_by_account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return rows.map(rowToHub);
  }

  /** Atomic single-use insert: a duplicate nonce conflicts and returns 0 rows ⇒ replay. */
  async recordNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const { rows } = await this.db.query<{ nonce: string }>(
      "INSERT INTO enroll_nonces (nonce, expires_at) VALUES ($1,$2) ON CONFLICT (nonce) DO NOTHING RETURNING nonce",
      [nonce, expiresAt],
    );
    return rows.length > 0;
  }

  async revoked(serial: string): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM revoked_certs WHERE serial = $1", [serial]);
    return rows.length > 0;
  }

  async revoke(serial: string): Promise<void> {
    await this.db.query(
      "INSERT INTO revoked_certs (serial, revoked_at) VALUES ($1,$2) ON CONFLICT (serial) DO NOTHING",
      [serial, Date.now()],
    );
  }

  async putClaimCode(code: ClaimCode): Promise<void> {
    this.claimCodes.set(code.hubUuid, code);
  }

  async getClaimCode(hubUuid: string): Promise<ClaimCode | undefined> {
    return this.claimCodes.get(hubUuid);
  }

  async putHome(home: HomeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO homes (id, name, owner_account_id, hub_uuid, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [home.id, home.name, home.ownerAccountId, home.hubUuid, home.createdAt],
    );
  }

  async putMembership(m: MembershipRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO memberships (id, home_id, account_id, role, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [m.id, m.homeId, m.accountId, m.role, m.createdAt],
    );
  }

  async membershipsForHub(hubUuid: string): Promise<MembershipRecord[]> {
    const { rows } = await this.db.query<{
      id: string; home_id: string; account_id: string; role: string; created_at: string | number;
    }>(
      `SELECT mb.* FROM memberships mb JOIN homes h ON h.id = mb.home_id WHERE h.hub_uuid = $1`,
      [hubUuid],
    );
    return rows.map((r) => ({
      id: r.id,
      homeId: r.home_id,
      accountId: r.account_id,
      role: r.role as MembershipRecord["role"],
      createdAt: Number(r.created_at),
    }));
  }
}
