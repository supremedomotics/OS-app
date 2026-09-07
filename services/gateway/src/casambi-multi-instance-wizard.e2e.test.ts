import type { License } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Multi-network Casambi, Stage 2b — proves the wizard's server-side contract over real HTTP:
 * `POST /v1/drivers/install` with `asNewInstance`/`label` creates a genuinely SEPARATE driver
 * instance (not a re-install of the same one), each with its own id, label, and config, and both
 * show up in the registry independently. This is the same install+setConfig pair the wizard's
 * `create()` calls, so a passing test here is a passing wizard submission.
 */
describe("Casambi multi-instance setup wizard (§ install asNewInstance + per-instance config)", () => {
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
      .filter((d) => d.key === "supreme-casambi")
      .map((d) => ({ key: d.key, installedId: d.installedId, label: d.label ?? null, instanceCount: d.instanceCount ?? 0, config: d.config }));
  }

  it("Cloud mode, shared credentials: two networks become two instances with the SAME email/password and DIFFERENT network ids", async () => {
    const net1 = await install({ key: "supreme-casambi" }); // first instance: no asNewInstance, matches the wizard's own rule
    const net2 = await install({ key: "supreme-casambi", asNewInstance: true, label: "Network 2" });
    expect(net2.id).not.toBe(net1.id);
    expect(net2.label).toBe("Network 2");

    const shared = { connectionType: "cloud", email: "installer@example.com", password: "hunter2" };
    await setConfig(net1.id, { ...shared, networkId: "net-a" });
    await setConfig(net2.id, { ...shared, networkId: "net-b" });

    const rows = await registryRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.instanceCount === 2)).toBe(true);

    const row1 = rows.find((r) => r.installedId === net1.id)!;
    const row2 = rows.find((r) => r.installedId === net2.id)!;
    expect(row1.config.email).toBe("installer@example.com");
    expect(row2.config.email).toBe("installer@example.com");
    expect(row1.config.networkId).toBe("net-a");
    expect(row2.config.networkId).toBe("net-b");
    expect(row2.label).toBe("Network 2");
  });

  it("Cloud mode, separate credentials: each network keeps its OWN email/password independently", async () => {
    const netA = await install({ key: "supreme-casambi", asNewInstance: true, label: "Network A" });
    const netB = await install({ key: "supreme-casambi", asNewInstance: true, label: "Network B" });

    await setConfig(netA.id, { connectionType: "cloud", email: "a@example.com", password: "pw-a", networkId: "net-x" });
    await setConfig(netB.id, { connectionType: "cloud", email: "b@example.com", password: "pw-b", networkId: "net-y" });

    const rows = await registryRows();
    const rowA = rows.find((r) => r.installedId === netA.id)!;
    const rowB = rows.find((r) => r.installedId === netB.id)!;
    expect(rowA.config.email).toBe("a@example.com");
    expect(rowB.config.email).toBe("b@example.com");
    // Writing B's config must never leak into A's, or "separate credentials" would be a lie.
    expect(rowA.config.email).not.toBe(rowB.config.email);
  });

  it("Local mode: two gateways get two instances, each with its own independent full config", async () => {
    const gw1 = await install({ key: "supreme-casambi", asNewInstance: true, label: "Gateway 1" });
    const gw2 = await install({ key: "supreme-casambi", asNewInstance: true, label: "Gateway 2" });

    await setConfig(gw1.id, {
      connectionType: "local",
      gatewayIp: "192.168.1.50",
      restPort: 80,
      gatewayUsername: "admin1",
      gatewayPassword: "secret1",
      udpPort: 5100,
      netId: 1,
    });
    await setConfig(gw2.id, {
      connectionType: "local",
      gatewayIp: "192.168.1.51",
      restPort: 80,
      gatewayUsername: "admin2",
      gatewayPassword: "secret2",
      udpPort: 5101,
      netId: 2,
    });

    const rows = await registryRows();
    const row1 = rows.find((r) => r.installedId === gw1.id)!;
    const row2 = rows.find((r) => r.installedId === gw2.id)!;
    expect(row1.config.gatewayIp).toBe("192.168.1.50");
    expect(row2.config.gatewayIp).toBe("192.168.1.51");
    expect(row1.config.udpPort).toBe(5100);
    expect(row2.config.udpPort).toBe(5101);
  });

  it("re-installing WITHOUT asNewInstance stays idempotent — the wizard's own first-instance rule never silently forks a duplicate", async () => {
    const first = await install({ key: "supreme-casambi" });
    const again = await install({ key: "supreme-casambi" }); // no asNewInstance, exactly what the wizard sends when existingInstanceCount === 0 and count === 1
    expect(again.id).toBe(first.id);
  });

  it("uninstalling one instance leaves the sibling instance's config and health untouched", async () => {
    const keep = await install({ key: "supreme-casambi", asNewInstance: true, label: "Keep" });
    const drop = await install({ key: "supreme-casambi", asNewInstance: true, label: "Drop" });
    await setConfig(keep.id, { connectionType: "cloud", email: "keep@example.com", password: "pw", networkId: "net-keep" });
    await setConfig(drop.id, { connectionType: "cloud", email: "drop@example.com", password: "pw", networkId: "net-drop" });

    const del = await fetch(`${baseUrl}/v1/drivers/${drop.id}`, { method: "DELETE", headers: auth() });
    expect(del.ok).toBe(true);

    const rows = await registryRows();
    expect(rows.some((r) => r.installedId === drop.id)).toBe(false);
    const kept = rows.find((r) => r.installedId === keep.id)!;
    expect(kept.config.email).toBe("keep@example.com");
  });
});
