import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime secrets store (§12). Holds secrets the hub GENERATES at runtime — chiefly the
 * Home Assistant long-lived token minted during headless provisioning — so they survive
 * restarts without ever touching `.env` or the installer. Each secret is a 0600 file in
 * the secrets dir (a Docker volume in production). Reads also honour values already
 * provided via env/`*_FILE` (handled by config), so this is purely the write-back path.
 *
 * When no directory is configured (dev/tests) it degrades to an in-memory map, so the
 * standalone slice needs no filesystem.
 */
export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
}

class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}
  private path(name: string): string {
    // Defensive: secret names are internal constants, but never allow path escapes.
    if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`invalid secret name: ${name}`);
    return join(this.dir, name);
  }
  get(name: string): string | null {
    const p = this.path(name);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
  }
  set(name: string, value: string): void {
    mkdirSync(this.dir, { recursive: true });
    const p = this.path(name);
    writeFileSync(p, value, { mode: 0o600 });
  }
}

class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  get(name: string): string | null {
    return this.map.get(name) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name, value);
  }
}

/** Build a secrets store: file-backed when a directory is configured, else in-memory. */
export function createSecretStore(dir: string | undefined): SecretStore {
  return dir ? new FileSecretStore(dir) : new MemorySecretStore();
}
