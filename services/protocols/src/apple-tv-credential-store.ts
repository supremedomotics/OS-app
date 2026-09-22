/**
 * Per-device Apple TV pairing-credential persistence (§ Apple TV Phase 2C). Reuses the
 * EXISTING secret-encryption primitive — `DriverSecretCrypto`
 * (`services/drivers/src/secret-store.ts`, real AES-256-GCM via `@supreme/crypto`) — the
 * same one every other driver's `secret: true` config fields go through, and the
 * EXISTING per-device persistence seam — `IProtocolBindingStore`
 * (`services/integration-layer/src/protocols/driver.ts`) — the store that already
 * durably persists every commissioned device's `ProtocolBinding` (deviceId + capability +
 * address + `config`) across a hub restart. No second credential database, no second
 * encryption implementation.
 *
 * Why `ProtocolBinding.config`, not `Device.metadata`: a binding is already the
 * per-(device, capability) unit `IProtocolBindingStore` persists and restores on boot —
 * exactly the granularity pairing credentials need (this driver INSTALLATION can bind
 * many Apple TVs; each binding is independently paired). `config?: Record<string,
 * unknown>` is documented on `ProtocolBinding` as "optional per-binding tuning" — the
 * credential blob is exactly that, for this one device. Device removal already calls
 * `IProtocolBindingStore.remove(deviceId, capability)` (see `unbindDevice`/binding-engine
 * call sites) — so a removed Apple TV's credentials are deleted through the SAME existing
 * device-removal path every other binding's config goes through, with no separate
 * cleanup code needed here.
 */
import type { CapabilityKind, DeviceId } from "@supreme/domain-model";
import type { DriverConfigField } from "@supreme/domain-model";
import type { DriverSecretCrypto } from "@supreme/drivers";
import type { IProtocolBindingStore } from "@supreme/integration-layer";
import type { PairSetupResult } from "./apple-tv-hap-pairing.js";

/** Where the encrypted blob is actually read/written. Production wires this to the real
 * `IProtocolBindingStore` (this device's own `ProtocolBinding.config`); tests use an
 * in-memory map. Kept minimal/structural here so this module doesn't need to depend on
 * `@supreme/integration-layer`'s full binding-store surface (list/put semantics for a
 * WHOLE binding) just to read/write one config sub-object. */
export interface AppleTvCredentialKv {
  get(deviceId: DeviceId): Promise<Record<string, unknown> | null>;
  set(deviceId: DeviceId, value: Record<string, unknown> | null): Promise<void>;
}

export interface AppleTvCredentialStore {
  load(deviceId: DeviceId): Promise<PairSetupResult | null>;
  save(deviceId: DeviceId, result: PairSetupResult): Promise<void>;
  clear(deviceId: DeviceId): Promise<void>;
}

const SCHEMA: DriverConfigField[] = [
  { key: "pairing", label: "Apple TV pairing credentials", type: "password", required: false, secret: true },
];

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

/** Real implementation: AES-256-GCM-at-rest (via the real `DriverSecretCrypto`),
 * persisted through an injected key/value slot backed by `IProtocolBindingStore`. Never
 * shares one device's ciphertext or key material with another — `deviceId` scopes every
 * read/write, matching `ProtocolBinding`'s own per-device identity. */
export function createAppleTvCredentialStore(
  crypto: DriverSecretCrypto,
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

/**
 * Real, protocol-agnostic adapter: reads/writes one named sub-object of a device's own
 * `ProtocolBinding.config` through the EXISTING `IProtocolBindingStore`
 * (`services/integration-layer/src/protocols/driver.ts`) — never a new store. Read-
 * modify-writes so a credential save never clobbers the rest of that binding's config
 * (address, capability, protocol, other tuning). Generic on `configKey`/`capability` —
 * any driver with a per-device secret (not just Apple TV) can reuse this the same way.
 */
export function createBindingConfigKv(
  store: IProtocolBindingStore,
  capability: CapabilityKind,
  configKey: string,
): AppleTvCredentialKv {
  return {
    async get(deviceId) {
      const all = await store.list();
      const binding = all.find((b) => b.deviceId === deviceId && b.capability === capability);
      const value = binding?.config?.[configKey];
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    },
    async set(deviceId, value) {
      const all = await store.list();
      const binding = all.find((b) => b.deviceId === deviceId && b.capability === capability);
      if (!binding) {
        // No stored binding yet (pairing happening before commissioning persisted one) —
        // nothing to attach the credential to; the caller's own bind flow is expected to
        // persist the binding first. Silently doing nothing here (rather than inventing a
        // binding with a guessed address/protocol) is the honest behavior.
        return;
      }
      const nextConfig = { ...binding.config };
      if (value === null) delete nextConfig[configKey];
      else nextConfig[configKey] = value;
      await store.put({ ...binding, config: nextConfig });
    },
  };
}

/** An in-memory credential store for tests — real encrypt/decrypt round-trip still goes
 * through the injected `DriverSecretCrypto`, only the persistence layer is in-memory. */
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
