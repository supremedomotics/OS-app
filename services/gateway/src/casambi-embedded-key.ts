import { decryptSecret, isEncryptedSecret } from "@supreme/crypto";

/**
 * Standalone, per-hub-only default for the Casambi Cloud API key (never the network admin
 * email/password — those genuinely vary per project and stay UI-editable per driver, see
 * drivers.tsx's CASAMBI_BACKEND_ONLY_KEYS).
 *
 * The API key is the one Casambi credential Supreme Domotics itself owns; system integrators
 * running install.sh on a customer site should never have to see, type, or be handed it in a
 * plaintext file. Storing it ciphertext-in-source (decrypted with a key embedded in this same
 * file) means it "just works" on every install with zero setup step and zero cloud dependency —
 * matching this project's local-first, offline-capable design. This is NOT a defense against a
 * determined reverse-engineer with access to this source tree (no offline, source-available
 * scheme can be); it only removes the key from every place a human installer would otherwise
 * encounter it during normal setup.
 *
 * Precedence is set in config.ts: SUPREME_CASAMBI_API_KEY (env/`_FILE`) always wins when present,
 * so a deployment can still override this — this is only the fallback default.
 */
const EMBEDDED_APP_KEY = "p3V5HQ4IcPn+zJEY192klcshO8fzFaXfVjNPKJ3AuQM=";

/** Fill via `node tools/encrypt-casambi-key.mjs "<real key>"` — see that script's own header. */
const ENCRYPTED_CASAMBI_API_KEY = "";

export function resolveEmbeddedCasambiApiKey(): string | undefined {
  if (!isEncryptedSecret(ENCRYPTED_CASAMBI_API_KEY)) return undefined;
  try {
    return decryptSecret(ENCRYPTED_CASAMBI_API_KEY, EMBEDDED_APP_KEY);
  } catch {
    return undefined;
  }
}
