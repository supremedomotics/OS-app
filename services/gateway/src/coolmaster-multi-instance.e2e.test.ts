import { InMemoryInstalledDriverStore } from "@supreme/drivers";
import type { License } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { scopeCoolMasterBackendId } from "./native-driver-factory.js";
import { buildServer } from "./server.js";

/**
 * § Multi-instance CoolMaster (REQUIREMENT 3) — proves the generic install/config/registry
 * machinery (already fully generic per § Multi-network Casambi — see native-driver-factory.test.ts
 * for the address-scoping wrapper's own unit tests) supports N independent CoolMaster gateway
 * instances with zero CoolMaster-specific core changes: `POST /v1/drivers/install` with
 * `asNewInstance`/`label` creates a genuinely separate instance, each with its own id, label, and
 * config, all visible in the registry independently. Mirrors casambi-multi-instance-wizard.e2e.test.ts.
 */
describe("§ Gateway Auto-Discovery route (GET /v1/commissioning/coolmaster/gateways)", () => {
  // A real (unscoped) call performs an actual LAN scan — appropriate for an installer-
  // triggered "scan" button, but far too slow/environment-dependent for an automated
  // test (`discoverCoolMasterGateways()`'s own 14-test suite already covers the scan
  // logic itself against fake TCP servers with explicit `candidateHosts`). This test
  // only proves the ROUTE is wired and auth-gated, matching the KNX discovery route's
  // own untested-beyond-wiring precedent.
  it("requires authentication, same as every other commissioning route", async () => {
    const ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    const app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const addr = app.server.address();
      const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const res = await fetch(`${baseUrl}/v1/commissioning/coolmaster/gateways`);
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("CoolMaster multi-instance install (§ install asNewInstance + per-instance config)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;

    const issued = (await (
      await fetch(`${baseUrl}/v1/license/dev-issue`, { method: "POST", headers: auth(), body: JSON.stringify({ sku: "pro", seats: 10 }) })
    ).json()) as { token: License };
    await fetch(`${baseUrl}/v1/license/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ token: issued.token }) });
  });
  afterAll(async () => {
    await app.close();
  });

  function auth() {
    return { "content-type": "application/json", authorization: `Bearer ${token}` };
  }

  async function install(body: Record<string, unknown>): Promise<{ id: string; label: string | null }> {
    const res = await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify(body) });
    expect(res.ok).toBe(true);
    const { driver } = (await res.json()) as { driver: { id: string; label?: string | null } };
    return { id: driver.id, label: driver.label ?? null };
  }

  async function setConfig(id: string, config: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${baseUrl}/v1/drivers/${id}/config`, { method: "PUT", headers: auth(), body: JSON.stringify({ config }) });
    expect(res.ok).toBe(true);
  }

  async function registryRows(): Promise<Array<{ key: string; installedId: string | null; label: string | null; instanceCount: number; config: Record<string, unknown> }>> {
    const res = await fetch(`${baseUrl}/v1/drivers/registry`, { headers: auth() });
    const { drivers } = (await res.json()) as { drivers: Array<{ key: string; installedId: string | null; label?: string | null; instanceCount?: number; config: Record<string, unknown> }> };
    return drivers
      .filter((d) => d.key === "supreme-coolmaster")
      .map((d) => ({ key: d.key, installedId: d.installedId, label: d.label ?? null, instanceCount: d.instanceCount ?? 0, config: d.config }));
  }

  it("§ REQUIREMENT 7 — a brand-new install with no explicit config defaults to autoDiscover: true (schema default), never requiring a host up front", async () => {
    const gw = await install({ key: "supreme-coolmaster", asNewInstance: true });
    const res = await fetch(`${baseUrl}/v1/drivers/${gw.id}/config`, { headers: auth() });
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config.autoDiscover).toBe(true);
    expect(config.host).toBeUndefined();
  });

  it("a fresh single gateway (count === 1, nothing pre-existing) installs with NO label, identical to the pre-multi-instance flow", async () => {
    const gw1 = await install({ key: "supreme-coolmaster" });
    expect(gw1.label).toBeNull();
    await setConfig(gw1.id, { host: "192.168.1.50" });
    const rows = await registryRows();
    const row = rows.find((r) => r.installedId === gw1.id)!;
    expect(row.instanceCount).toBe(1);
    expect(row.label).toBeNull();
  });

  it("two gateways become two instances with independent host/port config — changing one never touches the other", async () => {
    const gw1 = await install({ key: "supreme-coolmaster" });
    const gw2 = await install({ key: "supreme-coolmaster", asNewInstance: true, label: "Gateway 2" });
    expect(gw2.id).not.toBe(gw1.id);
    expect(gw2.label).toBe("Gateway 2");

    await setConfig(gw1.id, { host: "192.168.1.50", asciiPort: 10102 });
    await setConfig(gw2.id, { host: "192.168.1.51", asciiPort: 10102 });

    const rows = await registryRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.instanceCount === 2)).toBe(true);
    const row1 = rows.find((r) => r.installedId === gw1.id)!;
    const row2 = rows.find((r) => r.installedId === gw2.id)!;
    expect(row1.config.host).toBe("192.168.1.50");
    expect(row2.config.host).toBe("192.168.1.51");

    // Changing gateway 2's config must never leak into gateway 1's.
    await setConfig(gw2.id, { host: "192.168.1.99", asciiPort: 10102 });
    const rowsAfter = await registryRows();
    expect(rowsAfter.find((r) => r.installedId === gw1.id)!.config.host).toBe("192.168.1.50");
    expect(rowsAfter.find((r) => r.installedId === gw2.id)!.config.host).toBe("192.168.1.99");
  });

  it("§ Gateway Auto-Discovery config: a gateway can be configured with autoDiscover instead of a host, independently of a sibling manual gateway", async () => {
    const manual = await install({ key: "supreme-coolmaster", asNewInstance: true, label: "Manual Gateway" });
    const auto = await install({ key: "supreme-coolmaster", asNewInstance: true, label: "Auto Gateway" });
    await setConfig(manual.id, { host: "192.168.1.50" });
    await setConfig(auto.id, { autoDiscover: true, gatewaySerial: "GW-SN-123" });

    const rows = await registryRows();
    const manualRow = rows.find((r) => r.installedId === manual.id)!;
    const autoRow = rows.find((r) => r.installedId === auto.id)!;
    expect(manualRow.config.host).toBe("192.168.1.50");
    expect(autoRow.config.autoDiscover).toBe(true);
    expect(autoRow.config.gatewaySerial).toBe("GW-SN-123");
  });

  it("re-installing WITHOUT asNewInstance stays idempotent", async () => {
    const first = await install({ key: "supreme-coolmaster" });
    const again = await install({ key: "supreme-coolmaster" });
    expect(again.id).toBe(first.id);
  });

  it("uninstalling one gateway instance leaves the sibling instance's config untouched", async () => {
    const keep = await install({ key: "supreme-coolmaster", asNewInstance: true, label: "Keep" });
    const drop = await install({ key: "supreme-coolmaster", asNewInstance: true, label: "Drop" });
    await setConfig(keep.id, { host: "192.168.1.60" });
    await setConfig(drop.id, { host: "192.168.1.61" });

    const del = await fetch(`${baseUrl}/v1/drivers/${drop.id}`, { method: "DELETE", headers: auth() });
    expect(del.ok).toBe(true);

    const rows = await registryRows();
    expect(rows.some((r) => r.installedId === drop.id)).toBe(false);
    expect(rows.find((r) => r.installedId === keep.id)!.config.host).toBe("192.168.1.60");
  });
});

/**
 * § Multi-instance CoolMaster — labels and per-instance config must survive a genuine restart,
 * mirroring Casambi's Stage 2b review test exactly.
 */
describe("CoolMaster instance labels survive a restart", () => {
  it("label and per-instance config are both intact after a fresh AppContext boot against the same store", async () => {
    const driverStore = new InMemoryInstalledDriverStore();
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });

    const firstBoot = await AppContext.create(config, { driverStore });
    const primary = await firstBoot.installer.drivers.install("supreme-coolmaster");
    const secondary = await firstBoot.installer.drivers.install("supreme-coolmaster", undefined, { asNewInstance: true, label: "Gateway 2" });
    await firstBoot.installer.drivers.setConfig(secondary.id, { host: "192.168.1.51" });

    const secondBoot = await AppContext.create(config, { driverStore });
    const rows = await secondBoot.installer.drivers.registry();
    const coolmasterRows = rows.filter((r) => r.key === "supreme-coolmaster");

    expect(coolmasterRows).toHaveLength(2);
    const primaryRow = coolmasterRows.find((r) => r.installedId === primary.id)!;
    const secondaryRow = coolmasterRows.find((r) => r.installedId === secondary.id)!;
    expect(primaryRow.label).toBeNull();
    expect(secondaryRow.label).toBe("Gateway 2");
    expect(secondaryRow.config.host).toBe("192.168.1.51");

    const instances = await secondBoot.installer.drivers.listInstances("supreme-coolmaster");
    expect(instances[0]!.id).toBe(primary.id);
    expect(instances[1]!.id).toBe(secondary.id);
  });
});

/**
 * § Multi-instance CoolMaster — SCALE. Uses the direct installer API (not HTTP) for speed at
 * this instance count; the HTTP-level wiring itself is already proven by the smaller tests
 * above. Proves the architecture doesn't degrade or collide as instance count grows — every
 * instance gets a distinct id/label/config, and (the actual collision risk this whole feature
 * exists to prevent) the address-scoping wrapper produces a DISTINCT scoped address for the
 * identical UID "L1.100" for every single one of them.
 */
describe("CoolMaster multi-instance — scale", () => {
  it("50 gateway instances each get a distinct id, config, and a non-colliding scoped address for the identical UID", async () => {
    const driverStore = new InMemoryInstalledDriverStore();
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });
    const boot = await AppContext.create(config, { driverStore });

    const COUNT = 50;
    const instances = [];
    for (let i = 0; i < COUNT; i++) {
      const inst = await boot.installer.drivers.install("supreme-coolmaster", undefined, i === 0 ? {} : { asNewInstance: true, label: `Gateway ${i + 1}` });
      await boot.installer.drivers.setConfig(inst.id, { host: `192.168.50.${i + 1}` });
      instances.push(inst);
    }

    // 50 distinct ids.
    expect(new Set(instances.map((i) => i.id)).size).toBe(COUNT);

    // Each instance's own config is independently correct (not sharing/overwriting a neighbor's).
    const rows = await boot.installer.drivers.registry();
    const coolmasterRows = rows.filter((r) => r.key === "supreme-coolmaster");
    expect(coolmasterRows).toHaveLength(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const row = coolmasterRows.find((r) => r.installedId === instances[i]!.id)!;
      expect(row.config.host).toBe(`192.168.50.${i + 1}`);
    }

    // The actual collision risk this feature exists to prevent: every instance's own
    // scoped address for the IDENTICAL UID must be distinct from every other's.
    const scoped = instances.map((i) => scopeCoolMasterBackendId("L1.100", i.id));
    expect(new Set(scoped).size).toBe(COUNT);
  });
});

/**
 * § REQUIREMENT 7 — the new `autoDiscover` schema default must NEVER retroactively affect a
 * driver instance installed before this field existed. Simulates that exact scenario: a
 * persisted config record with NO `autoDiscover` key at all (bypassing `install()`/`setConfig()`,
 * which always run the CURRENT schema — a real legacy row, untouched since before this field
 * shipped, looks exactly like this).
 */
describe("§ REQUIREMENT 7 — autoDiscover default never breaks a pre-existing manual configuration", () => {
  it("a config record with no autoDiscover key at all is reconciled with its host preserved and is never silently switched into auto-discovery mode", async () => {
    const driverStore = new InMemoryInstalledDriverStore();
    const config = loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_DEV_MODE: "1" });

    const boot = await AppContext.create(config, { driverStore });
    const legacy = await boot.installer.drivers.install("supreme-coolmaster");
    // Overwrite the store record directly with a config shape that predates `autoDiscover`
    // entirely — no install()/setConfig() call (both apply the CURRENT schema) touches this.
    const stored = await driverStore.get(legacy.id);
    await driverStore.put({ ...stored!, config: { host: "192.168.1.77" } });

    // A fresh boot re-reads this exact legacy record and reconciles it.
    const reboot = await AppContext.create(config, { driverStore });
    const rows = await reboot.installer.drivers.registry();
    const row = rows.find((r) => r.installedId === legacy.id)!;

    expect(row.config.host).toBe("192.168.1.77"); // untouched
    expect(row.config.autoDiscover).toBeUndefined(); // never backfilled by the new default
  });
});
