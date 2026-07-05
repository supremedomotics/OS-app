import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Expiring (guest/temporary) access end-to-end: create a guest whose window has already closed, run
 * the hub's expiry sweep, and confirm the guest is flipped to `expired` so their token stops working.
 */
describe("Guest access expiry sweep", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }) })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("sweeps a past-expiry guest to 'expired'", async () => {
    const created = await fetch(`${baseUrl}/v1/users`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ email: "weekend-guest@supreme.local", password: "weekend-guest-pass", displayName: "Weekend Guest", userType: "guest", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    expect(created.status).toBe(201);
    const guestId = (await created.json()).user.id as string;

    await ctx.sweepExpiredAccess();

    const users = (await (await fetch(`${baseUrl}/v1/users`, { headers: auth() })).json()) as { users: { id: string; status: string }[] };
    expect(users.users.find((u) => u.id === guestId)?.status).toBe("expired");
  });
});
