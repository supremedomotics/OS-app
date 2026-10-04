import { issueMobileAuthorizationToken, generateHubIdentity } from "@supreme/hub-identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";
import type { FastifyInstance } from "fastify";

/**
 * §Phase12.4 — proves the real bridge between a paired Mobile's authorization token and the
 * EXISTING homeowner REST surface, against a real running gateway (not a mocked repository
 * method) — the exact thing Phase 12.3 flagged as BACKEND CONTRACT MISSING.
 */
describe("Mobile-authorization bridge on the real homeowner API", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let base: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    // A real pairing must have happened first — a cryptographically valid token for a Mobile
    // the Hub never actually paired (never upserted into `mobileAuthorizations`) is correctly
    // rejected, same as a revoked one. This mirrors what `/v1/pairing/verify` does for real.
    ctx.mobileAuthorizations.upsert({
      mobileId: "m1",
      publicKeyBase64: "pk-m1",
      hubId: ctx.hubIdentity.hubUuid,
      projectId: ctx.homeId,
      label: "Test Mobile",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });
  });

  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  function tokenFor(mobileId: string, hubId = ctx.hubIdentity.hubUuid, projectId = ctx.homeId) {
    return issueMobileAuthorizationToken(ctx.hubIdentity, { mobileId, hubId, projectId });
  }

  it("a valid Mobile token reads the real /v1/home the same shape a session would", async () => {
    const res = await fetch(`${base}/v1/home`, { headers: { authorization: `Bearer ${tokenFor("m1")}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { home: unknown; rooms: unknown[] };
    expect(body.home).toBeTruthy();
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  it("a paired Mobile sets the residence's location, and /v1/home reports it back", async () => {
    const auth = { authorization: `Bearer ${tokenFor("m1")}`, "content-type": "application/json" };
    const put = await fetch(`${base}/v1/home/location`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ lat: 39.6953, lon: 3.0176, timeZone: "Europe/Madrid", label: "Palma, Spain" }),
    });
    expect(put.status).toBe(200);
    const home = (await (await fetch(`${base}/v1/home`, { headers: auth })).json()) as {
      home: { location: { lat: number; lon: number; timeZone: string | null; label: string | null; utcOffsetMinutes: number | null } | null };
    };
    expect(home.home.location).toMatchObject({ lat: 39.6953, lon: 3.0176, timeZone: "Europe/Madrid", label: "Palma, Spain" });
    // Madrid is UTC+1 or +2 depending on the season; either way a whole number of minutes.
    expect([60, 120]).toContain((home.home.location as { utcOffsetMinutes: number | null }).utcOffsetMinutes);
  });

  it("a paired Mobile can also POST the location (its transport only POSTs)", async () => {
    const res = await fetch(`${base}/v1/home/location`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("m1")}`, "content-type": "application/json" },
      body: JSON.stringify({ lat: 28.6139, lon: 77.209, timeZone: "Asia/Kolkata", label: "New Delhi, India" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { location: { label: string } }).location.label).toBe("New Delhi, India");
  });

  it("refuses an impossible place or time zone, and an unpaired caller", async () => {
    const auth = { authorization: `Bearer ${tokenFor("m1")}`, "content-type": "application/json" };
    const put = (body: unknown, headers: Record<string, string> = auth) =>
      fetch(`${base}/v1/home/location`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect((await put({ lat: 91, lon: 0 })).status).toBe(422);
    expect((await put({ lat: 10, lon: 200 })).status).toBe(422);
    expect((await put({ lat: 10, lon: 10, timeZone: "Not/AZone" })).status).toBe(422);
    expect((await put({ lat: 10, lon: 10 }, { "content-type": "application/json" })).status).toBe(401);
  });

  it("a valid Mobile token can list real devices via /v1/devices", async () => {
    const res = await fetch(`${base}/v1/devices`, { headers: { authorization: `Bearer ${tokenFor("m1")}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a token signed for a DIFFERENT hub", async () => {
    const otherHub = generateHubIdentity();
    const forged = issueMobileAuthorizationToken(otherHub, { mobileId: "m1", hubId: otherHub.hubUuid, projectId: ctx.homeId });
    const res = await fetch(`${base}/v1/home`, { headers: { authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a token claiming the wrong project id", async () => {
    const wrongProject = tokenFor("m1", ctx.hubIdentity.hubUuid, "some-other-project");
    const res = await fetch(`${base}/v1/home`, { headers: { authorization: `Bearer ${wrongProject}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked Mobile's token even though it is still cryptographically valid", async () => {
    ctx.mobileAuthorizations.upsert({
      mobileId: "revoked-mobile",
      publicKeyBase64: "pk",
      hubId: ctx.hubIdentity.hubUuid,
      projectId: ctx.homeId,
      label: "Test device",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });
    ctx.mobileAuthorizations.revoke("revoked-mobile", new Date().toISOString());

    const res = await fetch(`${base}/v1/home`, { headers: { authorization: `Bearer ${tokenFor("revoked-mobile")}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed bearer token", async () => {
    const res = await fetch(`${base}/v1/home`, { headers: { authorization: "Bearer not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  it("rejects with no authorization header at all, same as before this bridge existed", async () => {
    const res = await fetch(`${base}/v1/home`);
    expect(res.status).toBe(401);
  });

  it("still accepts a real Supreme user session, unaffected by the Mobile bridge", async () => {
    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const res = await fetch(`${base}/v1/home`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.status).toBe(200);
  });

  it("§Phase12.5 — a paired Mobile can register and remove its own push token via the real bridge", async () => {
    const registerRes = await fetch(`${base}/v1/push/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("m1")}` },
      body: JSON.stringify({ platform: "fcm", token: "fake-fcm-token-abc" }),
    });
    expect(registerRes.status).toBe(201);

    const removeRes = await fetch(`${base}/v1/push/tokens/${encodeURIComponent("fake-fcm-token-abc")}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenFor("m1")}` },
    });
    expect(removeRes.status).toBe(204);
  });

  it("a real semantic command through a Mobile token actually changes device state (read-after-command)", async () => {
    const devicesRes = await fetch(`${base}/v1/devices`, { headers: { authorization: `Bearer ${tokenFor("m1")}` } });
    const { devices } = (await devicesRes.json()) as { devices: Array<{ id: string; capabilities: Array<{ kind: string }> }> };
    const onoffDevice = devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"));
    expect(onoffDevice).toBeTruthy();

    const res = await fetch(`${base}/v1/devices/${onoffDevice!.id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("m1")}` },
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; device?: { state: Record<string, { on?: boolean }> } };
    expect(body.accepted).toBe(true);
    expect(body.device?.state.onoff?.on).toBe(true);
  });
});
