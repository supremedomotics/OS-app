import { decryptSecret, encryptSecret, isEncryptedSecret } from "@supreme/crypto";
import type { DriverConfigField, InstalledDriver } from "@supreme/domain-model";
import type { IInstalledDriverStore } from "./store.js";

/**
 * Encryption-at-rest for driver config secret fields (§ Production Readiness Audit — "driver/
 * integration secrets stored as plaintext JSON at rest," Critical Blocker C2/H3). Operates only
 * on fields a driver's own manifest marks `secret: true` — the exact same field list
 * `maskSecrets()` (gateway API layer) already uses, so encryption-at-rest and API masking are two
 * independent layers over one single source of truth for "which fields are sensitive," never two
 * separately-maintained lists that could drift.
 *
 * Both directions are idempotent by construction (via `isEncryptedSecret`): encrypting an
 * already-ciphertext value, or decrypting a still-legacy-plaintext value, are each a safe no-op.
 * This matters because `config.ts`'s `validateDriverConfig` carries a masked/omitted secret field
 * forward from `existing` verbatim (§ "secret preservation") — by the time that value reaches
 * `encryptFields` again on the next save, it may already be ciphertext.
 */
export interface DriverSecretCrypto {
  encryptFields(config: Record<string, unknown>, schema: DriverConfigField[]): Record<string, unknown>;
  decryptFields(config: Record<string, unknown>, schema: DriverConfigField[]): Record<string, unknown>;
}

/** Real AES-256-GCM implementation, keyed by a base64 key from {@link generateEncryptionKey}. */
export function createDriverSecretCrypto(keyB64: string): DriverSecretCrypto {
  return {
    encryptFields(config, schema) {
      const out = { ...config };
      for (const field of schema) {
        if (!field.secret) continue;
        const value = out[field.key];
        if (typeof value !== "string" || value === "" || isEncryptedSecret(value)) continue;
        out[field.key] = encryptSecret(value, keyB64);
      }
      return out;
    },
    decryptFields(config, schema) {
      const out = { ...config };
      for (const field of schema) {
        if (!field.secret) continue;
        const value = out[field.key];
        if (!isEncryptedSecret(value)) continue; // legacy plaintext, or absent — pass through
        out[field.key] = decryptSecret(value, keyB64);
      }
      return out;
    },
  };
}

/**
 * Decorates any {@link IInstalledDriverStore} with transparent secret encryption: every read
 * decrypts, every write encrypts. `DriverManager` and every caller above it continue to see and
 * pass around plaintext exactly as before this existed — only what actually reaches the
 * underlying store (Postgres in production) differs. `schemaFor` is a function rather than a full
 * `ICatalog` dependency so this stays trivially testable without constructing a real catalog.
 */
export function withSecretEncryption(
  inner: IInstalledDriverStore,
  crypto: DriverSecretCrypto,
  schemaFor: (key: string) => Promise<DriverConfigField[]>,
): IInstalledDriverStore {
  const decrypt = async (d: InstalledDriver | null): Promise<InstalledDriver | null> => {
    if (!d) return d;
    const schema = await schemaFor(d.key);
    return { ...d, config: crypto.decryptFields(d.config, schema) };
  };
  return {
    async list() {
      const rows = await inner.list();
      return Promise.all(rows.map(async (r) => (await decrypt(r))!));
    },
    async get(id) {
      return decrypt(await inner.get(id));
    },
    async getByKey(key) {
      return decrypt(await inner.getByKey(key));
    },
    async put(driver) {
      const schema = await schemaFor(driver.key);
      await inner.put({ ...driver, config: crypto.encryptFields(driver.config, schema) });
    },
    async remove(id) {
      await inner.remove(id);
    },
  };
}

/**
 * One-time, idempotent boot migration: re-encrypts any driver whose config still holds a
 * plaintext value in a `secret: true` field (§ same finding as above — protects data that was
 * written before this encryption layer existed). Operates directly on the RAW, undecorated store
 * so it can tell plaintext apart from ciphertext; writing back through it re-persists as
 * ciphertext. Cheap to run every boot — a no-op once every driver's secrets are encrypted,
 * following the exact pattern `migrateOwnershipToProvider` (ADR-0023) already established.
 */
export async function migrateDriverSecretsToEncrypted(
  rawStore: IInstalledDriverStore,
  crypto: DriverSecretCrypto,
  schemaFor: (key: string) => Promise<DriverConfigField[]>,
): Promise<{ migrated: string[] }> {
  const migrated: string[] = [];
  for (const d of await rawStore.list()) {
    const schema = await schemaFor(d.key);
    const hasPlaintextSecret = schema.some((f) => {
      const value = d.config[f.key];
      return f.secret && typeof value === "string" && value !== "" && !isEncryptedSecret(value);
    });
    if (!hasPlaintextSecret) continue;
    await rawStore.put({ ...d, config: crypto.encryptFields(d.config, schema) });
    migrated.push(d.key);
  }
  return { migrated };
}
