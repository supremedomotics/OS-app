import {
  newId,
  type Action,
  type HomeId,
  type ResourceType,
  type UserId,
} from "@supreme/domain-model";
import { canonicalJson, sha256Hex } from "@supreme/crypto";
import type { SqlDb } from "@supreme/persistence";

/**
 * Advanced audit (§8, §12): an append-only, hash-chained log. Each entry's
 * `entryHash = SHA-256(prevHash || canonical(entry))`, so altering or removing any
 * historical entry breaks every subsequent hash — making tampering detectable via
 * {@link AuditService.verify}. The log is queryable and exportable by Master/Admin.
 */
export interface AuditEntry {
  id: string;
  homeId: HomeId;
  seq: number;
  actorUserId: UserId | null;
  action: Action | string;
  resourceType: ResourceType | string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  prevHash: string;
  entryHash: string;
}

export interface RecordAuditInput {
  homeId: HomeId;
  actorUserId?: UserId | null;
  action: Action | string;
  resourceType: ResourceType | string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

const GENESIS = "0".repeat(64);

export class AuditService {
  /** Serializes appends per home so the seq/hash chain stays consistent. */
  private chains = new Map<HomeId, Promise<unknown>>();

  constructor(private readonly db: SqlDb) {}

  /** Append an event to the chain. Returns the persisted entry. */
  record(input: RecordAuditInput): Promise<AuditEntry> {
    const prior = this.chains.get(input.homeId) ?? Promise.resolve();
    const next = prior.then(() => this.append(input));
    this.chains.set(
      input.homeId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async append(input: RecordAuditInput): Promise<AuditEntry> {
    const { rows } = await this.db.query<{ seq: number; entry_hash: string }>(
      "SELECT seq, entry_hash FROM audit_log WHERE home_id=$1 ORDER BY seq DESC LIMIT 1",
      [input.homeId],
    );
    const last = rows[0];
    const seq = (last ? Number(last.seq) : 0) + 1;
    const prevHash = last ? last.entry_hash : GENESIS;
    const createdAt = new Date().toISOString();

    const body = {
      homeId: input.homeId,
      seq,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
      createdAt,
    };
    const entryHash = sha256Hex(prevHash + canonicalJson(body));
    const entry: AuditEntry = { id: newId("audit"), prevHash, entryHash, ...body };

    await this.db.query(
      `INSERT INTO audit_log (id, home_id, seq, actor_user_id, action, resource_type, resource_id, metadata, ip, created_at, prev_hash, entry_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [entry.id, entry.homeId, entry.seq, entry.actorUserId, entry.action, entry.resourceType,
        entry.resourceId, JSON.stringify(entry.metadata), entry.ip, entry.createdAt, entry.prevHash, entry.entryHash],
    );
    return entry;
  }

  /** Recent entries (newest first). */
  async list(homeId: HomeId, limit = 100): Promise<AuditEntry[]> {
    const { rows } = await this.db.query<AuditRow>(
      "SELECT * FROM audit_log WHERE home_id=$1 ORDER BY seq DESC LIMIT $2",
      [homeId, limit],
    );
    return rows.map(rowToEntry);
  }

  /**
   * Verify the chain integrity for a home. Returns ok=true when every entry's hash
   * recomputes correctly and links to its predecessor; otherwise the first broken
   * sequence number.
   */
  async verify(homeId: HomeId): Promise<{ ok: boolean; brokenAtSeq?: number }> {
    const { rows } = await this.db.query<AuditRow>(
      "SELECT * FROM audit_log WHERE home_id=$1 ORDER BY seq ASC",
      [homeId],
    );
    let prevHash = GENESIS;
    for (const r of rows) {
      const body = {
        homeId: r.home_id,
        seq: Number(r.seq),
        actorUserId: r.actor_user_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.created_at,
      };
      const expected = sha256Hex(prevHash + canonicalJson(body));
      if (r.prev_hash !== prevHash || r.entry_hash !== expected) {
        return { ok: false, brokenAtSeq: Number(r.seq) };
      }
      prevHash = r.entry_hash;
    }
    return { ok: true };
  }
}

interface AuditRow {
  id: string;
  home_id: string;
  seq: number;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  prev_hash: string;
  entry_hash: string;
}

function rowToEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    homeId: r.home_id as HomeId,
    seq: Number(r.seq),
    actorUserId: (r.actor_user_id as UserId | null) ?? null,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata,
    ip: r.ip,
    createdAt: r.created_at,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
  };
}
