import { createHash } from "node:crypto";

/**
 * @supreme/backups-cloud — off-site backup vault (blueprint §13, OPTIONAL).
 *
 * ZERO-KNOWLEDGE: the hub encrypts a backup with a key the homeowner controls and uploads only the
 * CIPHERTEXT here. The vault stores the opaque blob + metadata, verifies integrity by content
 * digest, enforces per-home retention, and serves the blob back for a restore — it never holds a
 * decryption key and cannot read a backup. Not on the critical path: a hub backs up and restores
 * locally without it; this is additive off-site durability.
 */

export interface BackupRecord {
  id: string;
  homeId: string;
  createdAt: string;
  /** Hub/schema version the backup was taken at (opaque to the vault). */
  schemaVersion: string;
  /** Size of the stored ciphertext in bytes. */
  sizeBytes: number;
  /** SHA-256 of the ciphertext (integrity; computed and verified by the vault). */
  sha256: string;
}

/** Opaque ciphertext storage. In-memory by default; an S3-compatible impl is the production seam. */
export interface IBackupBlobStore {
  put(homeId: string, id: string, ciphertext: Buffer): Promise<void>;
  get(homeId: string, id: string): Promise<Buffer | undefined>;
  delete(homeId: string, id: string): Promise<void>;
}

export class InMemoryBackupBlobStore implements IBackupBlobStore {
  private blobs = new Map<string, Buffer>();
  private key(homeId: string, id: string) {
    return `${homeId}/${id}`;
  }
  async put(homeId: string, id: string, ciphertext: Buffer) {
    this.blobs.set(this.key(homeId, id), ciphertext);
  }
  async get(homeId: string, id: string) {
    return this.blobs.get(this.key(homeId, id));
  }
  async delete(homeId: string, id: string) {
    this.blobs.delete(this.key(homeId, id));
  }
}

export class BackupVaultError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

let counter = 0;

export interface BackupVaultOptions {
  blobStore?: IBackupBlobStore;
  /** Keep at most this many backups per home; older ones are pruned on upload. */
  retention?: number;
  now?: () => number;
}

export class BackupVaultService {
  private readonly records = new Map<string, BackupRecord[]>(); // homeId → records (newest last)
  private readonly blobs: IBackupBlobStore;
  private readonly retention: number;
  private readonly now: () => number;

  constructor(opts: BackupVaultOptions = {}) {
    this.blobs = opts.blobStore ?? new InMemoryBackupBlobStore();
    this.retention = opts.retention ?? 30;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Store an uploaded ciphertext. Verifies the content digest if the caller supplied one (so a
   * corrupted upload is rejected, not silently kept), records metadata, and prunes beyond retention.
   */
  async store(input: {
    homeId: string;
    id?: string;
    createdAt?: string;
    schemaVersion?: string;
    ciphertext: Buffer;
    expectedSha256?: string;
  }): Promise<BackupRecord> {
    const sha256 = createHash("sha256").update(input.ciphertext).digest("hex");
    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      throw new BackupVaultError("ciphertext digest mismatch — upload corrupted");
    }
    if (input.ciphertext.length === 0) throw new BackupVaultError("empty backup");
    const id = input.id ?? `bkp_${this.now().toString(36)}${(counter++).toString(36)}`;
    const record: BackupRecord = {
      id,
      homeId: input.homeId,
      createdAt: input.createdAt ?? new Date(this.now()).toISOString(),
      schemaVersion: input.schemaVersion ?? "unknown",
      sizeBytes: input.ciphertext.length,
      sha256,
    };
    await this.blobs.put(input.homeId, id, input.ciphertext);
    const list = this.records.get(input.homeId) ?? [];
    list.push(record);
    this.records.set(input.homeId, list);
    await this.prune(input.homeId);
    return record;
  }

  /** Backups for a home, newest first. */
  list(homeId: string): BackupRecord[] {
    return [...(this.records.get(homeId) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Fetch a backup's ciphertext for restore (scoped to the home). */
  async fetch(homeId: string, id: string): Promise<{ record: BackupRecord; ciphertext: Buffer }> {
    const record = (this.records.get(homeId) ?? []).find((r) => r.id === id);
    if (!record) throw new BackupVaultError("backup not found", 404);
    const ciphertext = await this.blobs.get(homeId, id);
    if (!ciphertext) throw new BackupVaultError("backup blob missing", 404);
    return { record, ciphertext };
  }

  async remove(homeId: string, id: string): Promise<void> {
    const list = this.records.get(homeId) ?? [];
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) throw new BackupVaultError("backup not found", 404);
    list.splice(idx, 1);
    await this.blobs.delete(homeId, id);
  }

  private async prune(homeId: string): Promise<void> {
    const list = this.records.get(homeId) ?? [];
    if (list.length <= this.retention) return;
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // oldest first
    const drop = sorted.slice(0, list.length - this.retention);
    for (const r of drop) {
      await this.blobs.delete(homeId, r.id);
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list.splice(i, 1);
    }
  }
}

export { buildBackupServer, type BackupServerOptions } from "./server.js";
