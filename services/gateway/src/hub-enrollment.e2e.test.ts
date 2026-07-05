import { buildHubRegistryServer } from "@supreme/hub-registry";
import { DevHubCA, verifyDeviceCredential } from "@supreme/hub-identity";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubAgent, type FetchLike } from "./hub-agent.js";
import { createSecretStore } from "./secrets.js";

/**
 * End-to-end C0 proof: a hub boots, generates its identity, enrolls with the cloud Hub
 * Registry over HTTP, and an owner then claims it — creating the home + owner membership.
 * No HA, no hardware, no inbound ports. The agent talks to the registry through a fetch shim
 * routed at the real Fastify server via `inject`, so the actual HTTP surface is exercised.
 */
describe("C0 end-to-end: hub enrollment + claim", () => {
  let registry: FastifyInstance;
  let ca: DevHubCA;
  /** Route the agent's fetch through the in-process registry server. */
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const res = await registry.inject({
      method: init.method as "POST",
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.payload) };
  };

  beforeAll(async () => {
    ca = DevHubCA.generate();
    registry = buildHubRegistryServer({ ca, brokerEndpoint: "https://broker.test", logLevel: "silent" });
    await registry.ready();
  });
  afterAll(async () => {
    await registry.close();
  });

  it("generates identity once and persists it across restarts", () => {
    const store = createSecretStore(undefined); // in-memory
    const a1 = new HubAgent({ store, registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl });
    const a2 = new HubAgent({ store, registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl });
    expect(a2.hubUuid).toBe(a1.hubUuid); // same identity reloaded from the sealed store
    expect(a1.fingerprint).toHaveLength(32);
  });

  it("enrolls the hub and stores a CA-issued credential", async () => {
    const store = createSecretStore(undefined);
    const agent = new HubAgent({ store, registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl });

    const state = await agent.ensureEnrolled();
    expect(state.enrolled).toBe(true);
    expect(state.brokerEndpoint).toBe("https://broker.test");
    expect(state.credential).not.toBeNull();
    expect(verifyDeviceCredential(state.credential!, ca.caPublicKey).valid).toBe(true);

    // Idempotent: a second boot reuses the stored, still-valid credential (no re-issue).
    const again = await agent.ensureEnrolled();
    expect(again.credential!.serial).toBe(state.credential!.serial);
  });

  it("lets an owner claim the enrolled hub → home + owner membership", async () => {
    const store = createSecretStore(undefined);
    const agent = new HubAgent({ store, registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl });
    await agent.ensureEnrolled();

    const claim = await agent.requestClaimCode();
    expect(claim).not.toBeNull();

    // The owner app calls the registry with its account session + the displayed code.
    const claimed = await registry.inject({
      method: "POST",
      url: `/v1/hubs/${agent.hubUuid}/claim`,
      headers: { "content-type": "application/json", "x-account-id": "acct-owner" },
      payload: JSON.stringify({ code: claim!.code, homeName: "Mumbai Villa" }),
    });
    expect(claimed.statusCode).toBe(201);
    const body = JSON.parse(claimed.payload) as { home: { name: string }; membership: { role: string } };
    expect(body.home.name).toBe("Mumbai Villa");
    expect(body.membership.role).toBe("owner");

    // The hub now shows up under the owner's account.
    const list = await registry.inject({ method: "GET", url: "/v1/hubs", headers: { "x-account-id": "acct-owner" } });
    const hubs = (JSON.parse(list.payload) as { hubs: { hubUuid: string; status: string }[] }).hubs;
    expect(hubs.find((h) => h.hubUuid === agent.hubUuid)?.status).toBe("claimed");
  });

  it("stays local-first: enrollment failure does not throw (cloud unreachable)", async () => {
    const store = createSecretStore(undefined);
    const downFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const agent = new HubAgent({ store, registryUrl: "https://reg.test", model: "Hub Pro", fwVersion: "0.4.0", fetchImpl: downFetch });
    const state = await agent.ensureEnrolled();
    expect(state.enrolled).toBe(false); // not enrolled, but no throw — the hub keeps running
    expect(state.identity.hubUuid).toBe(agent.hubUuid);
  });
});
