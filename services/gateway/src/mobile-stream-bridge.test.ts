import { issueMobileAuthorizationToken, generateHubIdentity } from "@supreme/hub-identity";
import type { HomeView, ServerFrame } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * §Phase12.6 — proves a paired Mobile can authenticate the REAL `/v1/stream` event channel
 * (the already-existing production Hub Event Bus fan-out, unchanged) with its Mobile-
 * authorization token, receives a real device-state delta over it after a real command, and
 * that authorization is enforced exactly like every other Mobile-bridged route (revoked,
 * wrong-Hub, wrong-project all rejected). Not a fake event bus — the SAME `/v1/stream` the
 * existing session-based `e2e.test.ts` suite already covers.
 */
describe("Mobile-authorization bridge on the real /v1/stream event channel", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let wsBase: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;

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

  it("a valid Mobile token opens the real event stream (no error frame, no close)", async () => {
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(tokenFor("m1"))}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not open in time")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("unexpected-response", () => reject(new Error("unexpected response")));
    });
    ws.close();
  });

  it(
    "a real device command is delivered as a real state delta over the Mobile-authenticated stream",
    async () => {
    const token = tokenFor("m1");
    const home = (await (
      await fetch(`${baseUrl}/v1/home`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as HomeView;
    const living = home.rooms.find((r) => r.name === "Living Room") ?? home.rooms[0]!;
    const devices = (await (
      await fetch(`${baseUrl}/v1/rooms/${living.id}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { devices: { id: string; capabilities: Array<{ kind: string }> }[] };
    const onoffDevice = devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff"));
    expect(onoffDevice).toBeTruthy();
    const deviceId = onoffDevice!.id;

    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(token)}`);
    const stateFrame = new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no state delta received")), 25000);
      // Subscribe to every room ("*") rather than one room id, so this test never depends on
      // `roomId` matching exactly what `/v1/rooms/:id/devices` returned it as.
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] })));
      ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame;
        if (frame.type === "state" && frame.deviceId === deviceId) {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws.on("error", reject);
    });
    await new Promise((r) => ws.once("open", r));
    await new Promise((r) => setTimeout(r, 100)); // let the subscribe frame land before commanding

    const cmdRes = await fetch(`${baseUrl}/v1/devices/${deviceId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: { capability: "onoff", action: "toggle" } }),
    });
    expect(cmdRes.status).toBe(200);

    const frame = await stateFrame;
    expect(frame.type).toBe("state");
    if (frame.type !== "state") throw new Error("unreachable");
    expect(frame.deviceId).toBe(deviceId);
    ws.close();
    },
    30000,
  );

  it("rejects a token signed for a DIFFERENT hub with a close, not a silent open", async () => {
    const otherHub = generateHubIdentity();
    const forged = issueMobileAuthorizationToken(otherHub, {
      mobileId: "m1",
      hubId: otherHub.hubUuid,
      projectId: ctx.homeId,
    });
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(forged)}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });

  it("rejects a token claiming the wrong project id", async () => {
    const wrongProject = tokenFor("m1", ctx.hubIdentity.hubUuid, "some-other-project");
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(wrongProject)}`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(1008);
  });

  it("rejects a revoked Mobile's token even though it is still cryptographically valid",
      async () => {
    ctx.mobileAuthorizations.upsert({
      mobileId: "revoked-mobile",
      publicKeyBase64: "pk",
      hubId: ctx.hubIdentity.hubUuid,
      projectId: ctx.homeId,
      label: "Revoked device",
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    });
    ctx.mobileAuthorizations.revoke("revoked-mobile", new Date().toISOString());

    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(tokenFor("revoked-mobile"))}`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(1008);
  });

  it("rejects a malformed token", async () => {
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=not-a-real-token`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    expect(closeCode).toBe(1008);
  });

  it("a real Supreme user session still opens the stream, unaffected by the Mobile bridge",
      async () => {
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${accessToken}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not open in time")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    ws.close();
  });

  it(
    "disconnecting a Mobile-authenticated socket cleans up its subscriptions (no leaked listener)",
    async () => {
    const token = tokenFor("m1");
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(token)}`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] }));
    await new Promise((r) => setTimeout(r, 50));
    const before = ctx.stateSubscriberCount;
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    // The client's own "close" event fires on ITS side of the socket, which is not guaranteed
    // ordered with the SERVER's close handler (where `unsubState()` actually runs) — poll
    // briefly rather than assuming same-tick ordering across that boundary.
    const deadline = Date.now() + 5000;
    while (ctx.stateSubscriberCount > before - 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ctx.stateSubscriberCount).toBe(before - 1);
    },
    20000,
  );
});
