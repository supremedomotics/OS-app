import type { PushTokenResponse } from "@supreme/contracts";
import type { IPushProvider, PushMessage, PushPlatform, PushToken } from "@supreme/notifications";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

class FakeProvider implements IPushProvider {
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  supports(_platform: PushPlatform) {
    return true;
  }
  async send(token: PushToken, message: PushMessage) {
    this.sent.push({ token: token.token, message });
  }
}

/**
 * Push notifications (§13): a client registers its push token, and a created
 * notification is delivered to it through the configured provider — additive to the
 * existing WSS fan-out (which still works with no provider).
 */
describe("Push notifications", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  const provider = new FakeProvider();

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      pushProviders: [provider],
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("registers a push token and delivers a notification to it", async () => {
    const reg = await fetch(`${baseUrl}/v1/push/tokens`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ platform: "fcm", token: "device-token-123" }),
    });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as PushTokenResponse).pushEnabled).toBe(true);

    // A broadcast notification (e.g. a security alarm) reaches every registered device.
    await ctx.notifications.create({
      homeId: ctx.homeId,
      userId: null,
      level: "critical",
      title: "Front door",
      body: "Motion detected",
    });
    // The notification fan-out is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(provider.sent.map((s) => s.token)).toContain("device-token-123");
    expect(provider.sent.at(-1)?.message.title).toBe("Front door");
  });

  it("unregisters a token so it no longer receives push", async () => {
    await fetch(`${baseUrl}/v1/push/tokens/device-token-123`, { method: "DELETE", headers: auth() });
    const before = provider.sent.length;
    await ctx.notifications.create({
      homeId: ctx.homeId,
      userId: null,
      level: "info",
      title: "After unregister",
      body: "should not push",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.sent.length).toBe(before);
  });
});
