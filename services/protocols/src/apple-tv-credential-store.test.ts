import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createDriverSecretCrypto } from "@supreme/drivers";
import { InMemoryProtocolBindingStore, type StoredProtocolBinding } from "@supreme/integration-layer";
import type { DeviceId } from "@supreme/domain-model";
import { createAppleTvCredentialStore, createBindingConfigKv } from "./apple-tv-credential-store.js";
import { generateControllerIdentity } from "./apple-tv-hap-pairing.js";
import type { PairSetupResult } from "./apple-tv-hap-pairing.js";

function fakeResult(tag: string): PairSetupResult {
  const identity = generateControllerIdentity(Buffer.from(`ctrl-${tag}`));
  return {
    controllerPairingId: identity.pairingId,
    controllerLtskSeed: identity.ltskSeed,
    controllerLtpk: identity.ltpk,
    accessoryPairingId: Buffer.from(`accessory-${tag}`),
    accessoryLtpk: randomBytes(32),
  };
}

describe("Apple TV credential store — real IProtocolBindingStore + DriverSecretCrypto integration (§ Phase 2C)", () => {
  it("persists credentials into the binding's own config, encrypted at rest, without touching other fields", async () => {
    const bindingStore = new InMemoryProtocolBindingStore();
    const deviceId = "appletv-a" as DeviceId;
    const initialBinding: StoredProtocolBinding = {
      deviceId,
      capability: "media",
      address: "192.168.1.10:49152",
      protocol: "appletv",
      config: { someOtherTuning: "keep-me" },
    };
    await bindingStore.put(initialBinding);

    const kv = createBindingConfigKv(bindingStore, "media", "appletv");
    const crypto = createDriverSecretCrypto(randomBytes(32).toString("base64"));
    const store = createAppleTvCredentialStore(crypto, kv);

    const result = fakeResult("a");
    await store.save(deviceId, result);

    const [stored] = await bindingStore.list();
    expect(stored!.address).toBe("192.168.1.10:49152"); // untouched
    expect(stored!.config?.someOtherTuning).toBe("keep-me"); // untouched
    expect(typeof (stored!.config?.appletv as any)?.pairing).toBe("string");
    expect((stored!.config?.appletv as any).pairing).not.toContain("ctrl-a"); // not plaintext

    const loaded = await store.load(deviceId);
    expect(loaded?.accessoryPairingId.equals(result.accessoryPairingId)).toBe(true);
  });

  it("survives a driver restart: same binding store, fresh credential-store instance, credentials still load", async () => {
    const bindingStore = new InMemoryProtocolBindingStore();
    const deviceId = "appletv-restart" as DeviceId;
    await bindingStore.put({ deviceId, capability: "media", address: "10.0.0.5:12345", protocol: "appletv" });

    const crypto = createDriverSecretCrypto(randomBytes(32).toString("base64"));
    const storeBeforeRestart = createAppleTvCredentialStore(crypto, createBindingConfigKv(bindingStore, "media", "appletv"));
    const result = fakeResult("restart");
    await storeBeforeRestart.save(deviceId, result);

    // "Restart": brand-new credential-store object (as a fresh gateway boot would
    // construct), same underlying binding store and same encryption key.
    const storeAfterRestart = createAppleTvCredentialStore(crypto, createBindingConfigKv(bindingStore, "media", "appletv"));
    const loaded = await storeAfterRestart.load(deviceId);
    expect(loaded).not.toBeNull();
    expect(loaded!.accessoryPairingId.equals(result.accessoryPairingId)).toBe(true);
    expect(loaded!.controllerLtskSeed.equals(result.controllerLtskSeed)).toBe(true);
  });

  it("removing the device's binding removes its credentials too (no orphaned secret)", async () => {
    const bindingStore = new InMemoryProtocolBindingStore();
    const deviceId = "appletv-removed" as DeviceId;
    await bindingStore.put({ deviceId, capability: "media", address: "10.0.0.9:1", protocol: "appletv" });
    const crypto = createDriverSecretCrypto(randomBytes(32).toString("base64"));
    const store = createAppleTvCredentialStore(crypto, createBindingConfigKv(bindingStore, "media", "appletv"));
    await store.save(deviceId, fakeResult("removed"));
    expect((await bindingStore.list()).length).toBe(1);

    // The existing, generic device-removal path: IProtocolBindingStore.remove().
    await bindingStore.remove(deviceId, "media");

    expect(await bindingStore.list()).toHaveLength(0);
    const kvAfterRemoval = createBindingConfigKv(bindingStore, "media", "appletv");
    expect(await kvAfterRemoval.get(deviceId)).toBeNull();
  });

  it("two Apple TVs never share credential storage even with the same crypto instance", async () => {
    const bindingStore = new InMemoryProtocolBindingStore();
    const deviceA = "appletv-x" as DeviceId;
    const deviceB = "appletv-y" as DeviceId;
    await bindingStore.put({ deviceId: deviceA, capability: "media", address: "10.0.0.1:1", protocol: "appletv" });
    await bindingStore.put({ deviceId: deviceB, capability: "media", address: "10.0.0.2:1", protocol: "appletv" });
    const crypto = createDriverSecretCrypto(randomBytes(32).toString("base64"));
    const store = createAppleTvCredentialStore(crypto, createBindingConfigKv(bindingStore, "media", "appletv"));

    await store.save(deviceA, fakeResult("x"));
    await store.save(deviceB, fakeResult("y"));

    const loadedA = await store.load(deviceA);
    const loadedB = await store.load(deviceB);
    expect(loadedA!.accessoryPairingId.toString()).toBe("accessory-x");
    expect(loadedB!.accessoryPairingId.toString()).toBe("accessory-y");
  });
});
