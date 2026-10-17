/**
 * Pluggable key-unlock providers (§ KNX Secure — key unlock). The key store never talks to
 * a TPM or the filesystem for its key-encryption secret directly; it asks a provider. The
 * provider's `mode` is bound into the store header, so a store created under one mode can
 * ONLY be opened by that same mode — there is no silent fallback to a weaker mechanism.
 *
 * Status of each mode (honest):
 *   passphrase         implemented, tested. Dev / recovery / explicitly configured deployments.
 *   external_key_file  implemented, tested. TRANSITIONAL: protects only against theft of the
 *                      main disk when the file lives on a separate protected mount.
 *   tpm                SEAM ONLY. No concrete TPM 2.0 driver is shipped and nothing has been
 *                      validated on the target hub hardware. Without an injected driver it
 *                      fails closed. Must not be described as hardware-backed security.
 */
import { lstatSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { Secret } from "./secret.js";

export type UnlockMode = "passphrase" | "external_key_file" | "tpm";

export type UnlockErrorCode =
  | "passphrase_invalid" | "key_file_unsafe" | "key_file_invalid" | "tpm_unavailable" | "tpm_unseal_failed";

export class UnlockError extends Error {
  constructor(readonly code: UnlockErrorCode, message: string) {
    super(message);
    this.name = "UnlockError";
  }
}

export interface KeyUnlockProvider {
  readonly mode: UnlockMode;
  /** True for options that must be reported as weaker/transitional in diagnostics. */
  readonly transitional: boolean;
  obtain(): Promise<Secret> | Secret;
}

export class PassphraseUnlockProvider implements KeyUnlockProvider {
  readonly mode = "passphrase" as const;
  readonly transitional = false;
  constructor(private readonly passphrase: Secret) {}
  obtain(): Secret {
    if (this.passphrase.wiped || this.passphrase.length < 12) throw new UnlockError("passphrase_invalid", "passphrase must be at least 12 bytes; there is no default passphrase");
    return this.passphrase;
  }
}

const KEY_FILE_MIN = 32;
const KEY_FILE_MAX = 4096;

export class ExternalKeyFileUnlockProvider implements KeyUnlockProvider {
  readonly mode = "external_key_file" as const;
  readonly transitional = true;
  constructor(private readonly path: string) {}
  obtain(): Secret {
    let st;
    try { st = lstatSync(this.path); } catch { throw new UnlockError("key_file_invalid", "key file is missing or unreadable"); }
    if (st.isSymbolicLink() || !st.isFile()) throw new UnlockError("key_file_unsafe", "key file must be a regular file, not a symlink");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new UnlockError("key_file_unsafe", "key file is accessible to group/other; chmod 600");
    if (st.size < KEY_FILE_MIN || st.size > KEY_FILE_MAX) throw new UnlockError("key_file_invalid", `key file must be ${KEY_FILE_MIN}..${KEY_FILE_MAX} bytes`);
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(fstatSync(fd).size);
      readSync(fd, buf, 0, buf.length, 0);
      const s = new Secret(buf);
      buf.fill(0);
      return s;
    } finally { closeSync(fd); }
  }
}

/** The platform seam a real TPM 2.0 integration would implement. Deliberately minimal. */
export interface TpmSealedKeyDriver {
  /** Resolves true only if a usable TPM is present and the sealed object exists. */
  available(): Promise<boolean>;
  /** Unseals the key-encryption secret. May fail after firmware/boot-state changes (PCR policy). */
  unseal(): Promise<Secret>;
}

export class TpmUnlockProvider implements KeyUnlockProvider {
  readonly mode = "tpm" as const;
  readonly transitional = false;
  constructor(private readonly driver?: TpmSealedKeyDriver) {}
  async obtain(): Promise<Secret> {
    if (!this.driver) throw new UnlockError("tpm_unavailable", "TPM unlock selected but no TPM driver is configured; refusing to fall back to a weaker mode");
    let ok = false;
    try { ok = await this.driver.available(); } catch { ok = false; }
    if (!ok) throw new UnlockError("tpm_unavailable", "TPM or sealed key not available; refusing to fall back to a weaker mode");
    try { return await this.driver.unseal(); } catch {
      throw new UnlockError("tpm_unseal_failed", "TPM refused to unseal the key (platform state changed?); recovery procedure required, no fallback attempted");
    }
  }
}
