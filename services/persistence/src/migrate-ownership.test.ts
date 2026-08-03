import type { DeviceId } from "@supreme/domain-model";
import type { DeviceProviderRecord, IDeviceProviderStore } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { migrateOwnershipToProvider } from "./migrate-ownership.js";
import type { DeviceOwnershipRepo, LegacyDeviceOwnershipRow } from "./repositories/device-ownership-repo.js";

function fakeLegacyRepo(rows: LegacyDeviceOwnershipRow[]): DeviceOwnershipRepo {
  return { list: async () => rows } as DeviceOwnershipRepo;
}

class FakeProviderStore implements IDeviceProviderStore {
  rows: DeviceProviderRecord[] = [];
  async list() { return this.rows; }
  async put(r: DeviceProviderRecord) { this.rows = [...this.rows.filter((x) => x.deviceId !== r.deviceId), r]; }
  async remove(deviceId: DeviceId) { this.rows = this.rows.filter((r) => r.deviceId !== deviceId); }
}

describe("migrateOwnershipToProvider (ADR-0023 § Migration)", () => {
  it("kind=ha -> provider=homeassistant, honestly UNBOUND", async () => {
    const legacy = fakeLegacyRepo([{ deviceId: "d1" as DeviceId, kind: "ha", protocol: null, updatedAt: "2024-01-01" }]);
    const store = new FakeProviderStore();
    const report = await migrateOwnershipToProvider(legacy, store);
    expect(report.migrated).toEqual([{ deviceId: "d1", provider: "homeassistant" }]);
    expect(store.rows[0]).toMatchObject({ deviceId: "d1", provider: "homeassistant", state: "UNBOUND" });
  });

  it("kind=native -> provider is the bound driver's protocol", async () => {
    const legacy = fakeLegacyRepo([{ deviceId: "d2" as DeviceId, kind: "native", protocol: "knx", updatedAt: "2024-01-01" }]);
    const store = new FakeProviderStore();
    const report = await migrateOwnershipToProvider(legacy, store);
    expect(report.migrated).toEqual([{ deviceId: "d2", provider: "knx" }]);
  });

  it("kind=unassigned (or any other kind) is left unresolvable — never guessed", async () => {
    const legacy = fakeLegacyRepo([{ deviceId: "d3" as DeviceId, kind: "unassigned", protocol: null, updatedAt: "2024-01-01" }]);
    const store = new FakeProviderStore();
    const report = await migrateOwnershipToProvider(legacy, store);
    expect(report.migrated).toEqual([]);
    expect(report.unresolvable).toEqual(["d3"]);
    expect(store.rows).toEqual([]);
  });

  it("kind=native with no recorded protocol is unresolvable, not guessed", async () => {
    const legacy = fakeLegacyRepo([{ deviceId: "d4" as DeviceId, kind: "native", protocol: null, updatedAt: "2024-01-01" }]);
    const store = new FakeProviderStore();
    const report = await migrateOwnershipToProvider(legacy, store);
    expect(report.unresolvable).toEqual(["d4"]);
  });

  it("is idempotent — a device already migrated is skipped, never overwritten", async () => {
    const legacy = fakeLegacyRepo([{ deviceId: "d1" as DeviceId, kind: "ha", protocol: null, updatedAt: "2024-01-01" }]);
    const store = new FakeProviderStore();
    store.rows.push({ deviceId: "d1" as DeviceId, provider: "homeassistant", state: "ONLINE", updatedAt: "2024-06-01" });
    const report = await migrateOwnershipToProvider(legacy, store);
    expect(report.migrated).toEqual([]);
    expect(report.skippedAlreadyMigrated).toEqual(["d1"]);
    expect(store.rows[0]!.state).toBe("ONLINE"); // untouched, not reset to UNBOUND
  });
});
