import type { AureonTransaction, AureonTransactionId } from "@supreme/domain-model";

/**
 * Aureon transaction history, MVP slice. In-memory only for this phase — the real,
 * DURABLE record of every Aureon-initiated change is the existing hash-chained
 * `audit_log` (`AureonActionEngine.execute()` always records there via
 * `AuditService`, regardless of this store). This store exists only to make undo
 * possible within a process's lifetime.
 *
 * PLANNED (§ AUREON-ARCHITECTURE.md §12 risk 6, not yet done): persist transactions
 * to Postgres via a new `aureon_transaction_repo.ts` + migration, mirroring
 * `notification-repo.ts`'s pattern, so undo survives a gateway restart. Flagged
 * explicitly rather than silently left in-memory.
 */
export class InMemoryAureonTransactionStore {
  private readonly byId = new Map<AureonTransactionId, AureonTransaction>();

  save(tx: AureonTransaction): void {
    this.byId.set(tx.id, tx);
  }

  get(id: AureonTransactionId): AureonTransaction | null {
    return this.byId.get(id) ?? null;
  }
}
