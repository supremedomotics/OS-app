import { canonicalJson, sha256Hex } from "@supreme/crypto";

/**
 * @supreme/cloud-audit — append-only, hash-chained, tamper-evident audit log (blueprint §12,
 * §17). Every entry's hash covers its content AND the previous entry's hash, so any insertion,
 * deletion, or modification breaks the chain and is detectable by `verify`. Spans cloud + hub
 * security events (claims, role changes, remote-service grants, logins, unlocks).
 */

export type ActorKind = "user" | "hub" | "dealer" | "system";

export interface AuditInput {
  scope: "cloud" | "home";
  homeId?: string | null;
  actorAccountId?: string | null;
  actorKind: ActorKind;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  createdAt: number;
  prevHash: string;
  entryHash: string;
}

const GENESIS = "0".repeat(64);

/** Compute an entry's hash over its canonical content + the previous hash (chain link). */
export function hashEntry(entry: Omit<AuditEntry, "entryHash">): string {
  return sha256Hex(canonicalJson({
    seq: entry.seq,
    createdAt: entry.createdAt,
    scope: entry.scope,
    homeId: entry.homeId ?? null,
    actorAccountId: entry.actorAccountId ?? null,
    actorKind: entry.actorKind,
    action: entry.action,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    prevHash: entry.prevHash,
  }));
}

export interface IAuditStore {
  append(entry: AuditEntry): void;
  all(): AuditEntry[];
  tip(): AuditEntry | undefined;
}

export class InMemoryAuditStore implements IAuditStore {
  private entries: AuditEntry[] = [];
  append(entry: AuditEntry) {
    this.entries.push(entry);
  }
  all() {
    return [...this.entries];
  }
  tip() {
    return this.entries[this.entries.length - 1];
  }
}

export interface VerifyResult {
  valid: boolean;
  /** Sequence number of the first broken entry, if any. */
  brokenAt?: number;
  reason?: string;
}

export class AuditLog {
  private readonly store: IAuditStore;
  private readonly now: () => number;

  constructor(opts: { store?: IAuditStore; now?: () => number } = {}) {
    this.store = opts.store ?? new InMemoryAuditStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Append an entry, chaining it to the current tip. Returns the sealed entry. */
  append(input: AuditInput): AuditEntry {
    const tip = this.store.tip();
    const base: Omit<AuditEntry, "entryHash"> = {
      ...input,
      seq: tip ? tip.seq + 1 : 0,
      createdAt: this.now(),
      prevHash: tip ? tip.entryHash : GENESIS,
    };
    const entry: AuditEntry = { ...base, entryHash: hashEntry(base) };
    this.store.append(entry);
    return entry;
  }

  entries(): AuditEntry[] {
    return this.store.all();
  }

  query(filter: { homeId?: string; action?: string; since?: number }): AuditEntry[] {
    return this.store.all().filter(
      (e) =>
        (filter.homeId === undefined || e.homeId === filter.homeId) &&
        (filter.action === undefined || e.action === filter.action) &&
        (filter.since === undefined || e.createdAt >= filter.since),
    );
  }

  /** Verify the entire chain: hashes recompute and each links to the prior. */
  verify(): VerifyResult {
    const all = this.store.all();
    let prev = GENESIS;
    for (const e of all) {
      if (e.prevHash !== prev) return { valid: false, brokenAt: e.seq, reason: "prevHash mismatch" };
      const { entryHash, ...rest } = e;
      if (hashEntry(rest) !== entryHash) return { valid: false, brokenAt: e.seq, reason: "content hash mismatch" };
      prev = e.entryHash;
    }
    return { valid: true };
  }
}
