import { generateEncryptionKey } from "@supreme/crypto";
import { newId, type DriverConfigField, type DriverId, type HomeId, type InstalledDriver } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { InMemoryInstalledDriverStore } from "./store.js";
import { createDriverSecretCrypto, migrateDriverSecretsToEncrypted, withSecretEncryption } from "./secret-store.js";

const homeId = newId("home") as HomeId;

const CASAMBI_SCHEMA: DriverConfigField[] = [
  { key: "gatewayIp", label: "Gateway IP", type: "host", required: true, secret: false },
  { key: "apiKey", label: "API Key", type: "password", required: false, secret: true },
  { key: "email", label: "Email", type: "text", required: false, secret: true },
  { key: "password", label: "Password", type: "password", required: false, secret: true },
];

function schemaFor(_key: string): Promise<DriverConfigField[]> {
  return Promise.resolve(CASAMBI_SCHEMA);
}

function driver(config: Record<string, unknown>): InstalledDriver {
  return {
    id: newId("driver") as DriverId,
    homeId,
    key: "supreme-casambi",
    version: "1.0.0",
    channel: "official",
    category: "lighting",
    installedAt: new Date().toISOString(),
    enabled: true,
    status: "active",
    config,
  };
}

describe("createDriverSecretCrypto", () => {
  it("encrypts only fields the schema marks secret", () => {
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const encrypted = crypto.encryptFields({ gatewayIp: "192.168.1.90", apiKey: "sekret" }, CASAMBI_SCHEMA);
    expect(encrypted.gatewayIp).toBe("192.168.1.90"); // not secret, untouched
    expect(encrypted.apiKey).not.toBe("sekret");
    expect(String(encrypted.apiKey)).toMatch(/^enc:v1:/);
  });

  it("round-trips through encrypt then decrypt", () => {
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const config = { gatewayIp: "192.168.1.90", apiKey: "key123", email: "a@b.com", password: "hunter2" };
    const encrypted = crypto.encryptFields(config, CASAMBI_SCHEMA);
    const decrypted = crypto.decryptFields(encrypted, CASAMBI_SCHEMA);
    expect(decrypted).toEqual(config);
  });

  it("is idempotent — encrypting an already-encrypted value is a safe no-op", () => {
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const once = crypto.encryptFields({ password: "hunter2" }, CASAMBI_SCHEMA);
    const twice = crypto.encryptFields(once, CASAMBI_SCHEMA);
    expect(twice.password).toBe(once.password); // not double-wrapped
    expect(crypto.decryptFields(twice, CASAMBI_SCHEMA).password).toBe("hunter2");
  });

  it("decryptFields passes through legacy plaintext values unchanged", () => {
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const legacy = { gatewayIp: "192.168.1.90", apiKey: "never-encrypted-plaintext" };
    expect(crypto.decryptFields(legacy, CASAMBI_SCHEMA)).toEqual(legacy);
  });

  it("skips empty/undefined secret values on encrypt", () => {
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const encrypted = crypto.encryptFields({ gatewayIp: "1.2.3.4", apiKey: "" }, CASAMBI_SCHEMA);
    expect(encrypted.apiKey).toBe("");
  });
});

describe("withSecretEncryption", () => {
  it("stores ciphertext in the underlying store but hands back plaintext to callers", async () => {
    const raw = new InMemoryInstalledDriverStore();
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const store = withSecretEncryption(raw, crypto, schemaFor);

    const d = driver({ gatewayIp: "192.168.1.90", apiKey: "realkey", email: "a@b.com", password: "hunter2" });
    await store.put(d);

    // The raw, underlying store holds ciphertext.
    const rawRow = await raw.get(d.id);
    expect(rawRow!.config.apiKey).not.toBe("realkey");
    expect(String(rawRow!.config.apiKey)).toMatch(/^enc:v1:/);
    expect(rawRow!.config.gatewayIp).toBe("192.168.1.90"); // non-secret field stored plainly

    // The decorated store hands back real plaintext.
    const decorated = await store.get(d.id);
    expect(decorated!.config.apiKey).toBe("realkey");
    expect(decorated!.config.password).toBe("hunter2");

    const viaGetByKey = await store.getByKey(d.key);
    expect(viaGetByKey!.config.apiKey).toBe("realkey");

    const viaList = await store.list();
    expect(viaList[0]!.config.apiKey).toBe("realkey");
  });

  it("get()/list() on a missing id/empty store stay null/empty, never throw", async () => {
    const raw = new InMemoryInstalledDriverStore();
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    const store = withSecretEncryption(raw, crypto, schemaFor);
    expect(await store.get(newId("driver") as DriverId)).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});

describe("migrateDriverSecretsToEncrypted", () => {
  it("re-encrypts drivers with plaintext secrets and reports which ones changed", async () => {
    const raw = new InMemoryInstalledDriverStore();
    const crypto = createDriverSecretCrypto(generateEncryptionKey());

    const legacy = driver({ gatewayIp: "192.168.1.90", apiKey: "still-plaintext-from-before" });
    await raw.put(legacy);

    const result = await migrateDriverSecretsToEncrypted(raw, crypto, schemaFor);
    expect(result.migrated).toEqual(["supreme-casambi"]);

    const after = await raw.get(legacy.id);
    expect(String(after!.config.apiKey)).toMatch(/^enc:v1:/);
    expect(crypto.decryptFields(after!.config, CASAMBI_SCHEMA).apiKey).toBe("still-plaintext-from-before");
  });

  it("is idempotent — a second run migrates nothing further", async () => {
    const raw = new InMemoryInstalledDriverStore();
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    await raw.put(driver({ gatewayIp: "192.168.1.90", apiKey: "plaintext" }));

    await migrateDriverSecretsToEncrypted(raw, crypto, schemaFor);
    const second = await migrateDriverSecretsToEncrypted(raw, crypto, schemaFor);
    expect(second.migrated).toEqual([]);
  });

  it("does nothing when every secret field is already ciphertext or absent", async () => {
    const raw = new InMemoryInstalledDriverStore();
    const crypto = createDriverSecretCrypto(generateEncryptionKey());
    await raw.put(driver({ gatewayIp: "192.168.1.90" })); // no secret fields set at all

    const result = await migrateDriverSecretsToEncrypted(raw, crypto, schemaFor);
    expect(result.migrated).toEqual([]);
  });
});
