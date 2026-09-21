/**
 * Per-device Apple TV pairing-credential persistence (§ Apple TV Phase 2B). Reuses the
 * EXISTING secret-encryption primitive — `DriverSecretCrypto`
 * (`services/drivers/src/secret-store.ts`, real AES-256-GCM via `@supreme/crypto`) — the
 * same one every other driver's `secret: true` config fields go through. No second
 * credential store is created.
 *
 * Why this ISN'T just another `secret: true` `DriverConfigField`: that mechanism encrypts
 * fields on a driver's own INSTALLATION config (one shared blob per driver instance —
 * e.g. one MQTT broker's password). Apple TV pairing credentials are inherently
 * per-DEVICE (this driver installation can have many Apple TVs, each independently
 * paired) — there is no existing per-binding secret slot in this codebase to reuse
 * (`ProtocolBinding.config` is the closest per-device slot, but nothing currently
 * persists it durably outside commissioning). Rather than invent a new encrypted-at-rest
 * primitive, this module is a thin adapter: it serializes a `PairSetupResult` to JSON and
 * runs it through the SAME `DriverSecretCrypto.encryptFields`/`decryptFields` used
 * elsewhere, storing the result via an injected key/value persistence function — in
 * production this is `Device.metadata.appletv.pairing`, the existing per-device metadata
 * slot other drivers already use for a device-specific, non-capability distinction (see
 * `climate-console.tsx`'s `device.metadata.<domain>.kind` convention referenced in
 * CLAUDE.md's coding standards) — never a new database, never a new file store.
 */
import type { DeviceId } from "@supreme/domain-model";
import type { PairSetupResult } from "./apple-tv-hap-pairing.js";

/** The minimal shape `DriverSecretCrypto.encryptFields`/`decryptFields` need — a config
 * object plus a schema naming which fields are secret. Structurally compatible with
 * `services/drivers/src/secret-store.ts`'s real interface without importing it (this
 * package doesn't depend on `@supreme/drivers`) — the gateway wires the real
 * implementation in at bootstrap. */
export interface AppleTvSecretCrypto {
  encryptFields(config: Record<string, unknown>, schema: { key: string; secret?: boolean }[]): Record<string, unknown>;
  decryptFields(config: Record<string, unknown>, schema: { key: string; secret?: boolean }[]): Record<string, unknown>;
}

/** Where the encrypted blob is actually read/written — production wires this to
 * `Device.metadata.appletv.pairing` via `HomeService`; tests use an in-memory map. */
export interface AppleTvCredentialKv {
  get(deviceId: DeviceId): Promise<Record<string, unknown> | null>;
  set(deviceId: DeviceId, value: Record<string, unknown> | null): Promise<void>;
}

export interface AppleTvCredentialStore {
  load(deviceId: DeviceId): Promise<PairSetupResult | null>;
  save(deviceId: DeviceId, result: PairSetupResult): Promise<void>;
  clear(deviceId: DeviceId): Promise<void>;
}

const SCHEMA = [{ key: "pairing", secret: true }];

function toJson(result: PairSetupResult): Record<string, unknown> {
  return {
    pairing: JSON.stringify({
      controllerPairingId: result.controllerPairingId.toString("base64"),
      controllerLtskSeed: result.controllerLtskSeed.toString("base64"),
      controllerLtpk: result.controllerLtpk.toString("base64"),
      accessoryPairingId: result.accessoryPairingId.toString("base64"),
      accessoryLtpk: result.accessoryLtpk.toString("base64"),
    }),
  };
}

function fromJson(config: Record<string, unknown>): PairSetupResult | null {
  const raw = config.pairing;
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(raw) as Record<string, string>;
  return {
    controllerPairingId: Buffer.from(parsed.controllerPairingId!, "base64"),
    controllerLtskSeed: Buffer.from(parsed.controllerLtskSeed!, "base64"),
    controllerLtpk: Buffer.from(parsed.controllerLtpk!, "base64"),
    accessoryPairingId: Buffer.from(parsed.accessoryPairingId!, "base64"),
    accessoryLtpk: Buffer.from(parsed.accessoryLtpk!, "base64"),
  };
}

/** Real implementation: AES-256-GCM-at-rest (via the injected `DriverSecretCrypto`),
 * persisted through an injected key/value slot. Never shares one device's ciphertext or
 * key material with another — `deviceId` scopes every read/write. */
export function createAppleTvCredentialStore(
  crypto: AppleTvSecretCrypto,
  kv: AppleTvCredentialKv,
): AppleTvCredentialStore {
  return {
    async load(deviceId) {
      const stored = await kv.get(deviceId);
      if (!stored) return null;
      const decrypted = crypto.decryptFields(stored, SCHEMA);
      return fromJson(decrypted);
    },
    async save(deviceId, result) {
      const encrypted = crypto.encryptFields(toJson(result), SCHEMA);
      await kv.set(deviceId, encrypted);
    },
    async clear(deviceId) {
      await kv.set(deviceId, null);
    },
  };
}

/** An in-memory credential store for tests — real encrypt/decrypt round-trip still goes
 * through the injected `AppleTvSecretCrypto`, only the persistence layer is in-memory. */
export function createInMemoryCredentialKv(): AppleTvCredentialKv {
  const map = new Map<DeviceId, Record<string, unknown>>();
  return {
    async get(deviceId) {
      return map.get(deviceId) ?? null;
    },
    async set(deviceId, value) {
      if (value === null) map.delete(deviceId);
      else map.set(deviceId, value);
    },
  };
}
