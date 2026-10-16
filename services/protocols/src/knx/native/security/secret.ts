/**
 * Secret-handling primitives (§ KNX Secure — key hygiene). Provider-agnostic: nothing here
 * encodes any KNX security procedure, only the rule that key material must not leak through
 * logging, serialization, inspection or error messages.
 *
 * Limits, stated plainly: JavaScript gives no guaranteed memory zeroization or mlock. `wipe()`
 * overwrites the backing buffer (best effort); copies made by callers, the GC or swap are
 * outside this module's control. See docs/architecture/knx-secure-keyring-threat-model.md.
 */
import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

export class Secret {
  #bytes: Buffer | null;

  constructor(bytes: Uint8Array | Buffer) {
    this.#bytes = Buffer.from(bytes);
  }

  get length(): number { return this.#bytes?.length ?? 0; }
  get wiped(): boolean { return this.#bytes === null; }

  /** Runs `fn` with the raw bytes. The buffer is only valid inside the callback; do not retain it. */
  use<T>(fn: (bytes: Buffer) => T): T {
    if (!this.#bytes) throw new Error("secret has been wiped");
    return fn(this.#bytes);
  }

  /** Best-effort overwrite; idempotent. */
  wipe(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }

  toString(): string { return REDACTED; }
  toJSON(): string { return REDACTED; }
  [inspect.custom](): string { return `Secret(${REDACTED})`; }
}

/** Replaces every occurrence of the given secrets (raw, hex, base64, base64url) in `text`. */
export function redactSecrets(text: string, secrets: ReadonlyArray<Secret>): string {
  let out = text;
  for (const s of secrets) {
    if (s.wiped || s.length === 0) continue;
    s.use((b) => {
      for (const form of new Set([b.toString("hex"), b.toString("hex").toUpperCase(), b.toString("base64"), b.toString("base64url"), b.toString("latin1")])) {
        if (form.length >= 4) out = out.split(form).join(REDACTED);
      }
    });
  }
  return out;
}
