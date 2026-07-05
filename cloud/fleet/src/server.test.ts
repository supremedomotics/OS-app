import { afterEach, describe, expect, it } from "vitest";
import { buildFleetServer } from "./server.js";

const KEY = "test-key";
const ORG = "org_acme";

function server() {
  return buildFleetServer({ apiKeys: new Map([[KEY, ORG]]), logLevel: "silent" });
}

const auth = { authorization: `Bearer ${KEY}` };

describe("Fleet HTTP API", () => {
  let app: ReturnType<typeof server> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("rejects requests without a valid org API key", async () => {
    app = server();
    const res = await app.inject({ method: "GET", url: "/v1/fleet/hubs" });
    expect(res.statusCode).toBe(401);
  });

  it("registers a hub, heartbeats it, and lists it for the org", async () => {
    app = server();
    const reg = await app.inject({
      method: "POST",
      url: "/v1/fleet/hubs",
      headers: auth,
      payload: { homeId: "home_01", name: "Penthouse", version: "0.3.0" },
    });
    expect(reg.statusCode).toBe(201);
    const hubId = reg.json().hub.id as string;

    const hb = await app.inject({
      method: "POST",
      url: `/v1/fleet/hubs/${hubId}/heartbeat`,
      headers: auth,
      payload: { version: "0.3.1" },
    });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().hub.version).toBe("0.3.1");

    const list = await app.inject({ method: "GET", url: "/v1/fleet/hubs", headers: auth });
    expect(list.statusCode).toBe(200);
    const hubs = list.json().hubs as { id: string; status: string }[];
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.status).toBe("online");
  });

  it("isolates orgs (a different key sees nothing)", async () => {
    app = buildFleetServer({
      apiKeys: new Map([[KEY, ORG], ["other", "org_other"]]),
      logLevel: "silent",
    });
    await app.inject({
      method: "POST",
      url: "/v1/fleet/hubs",
      headers: auth,
      payload: { homeId: "home_01", name: "H", version: "0.3.0" },
    });
    const list = await app.inject({ method: "GET", url: "/v1/fleet/hubs", headers: { authorization: "Bearer other" } });
    expect(list.json().hubs).toHaveLength(0);
  });
});
