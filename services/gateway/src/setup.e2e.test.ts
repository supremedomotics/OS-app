import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * The first-run Setup Wizard (§ provisioning). With SUPREME_SETUP_WIZARD=1 and no
 * existing admin, the hub does NOT seed a demo owner: it waits for POST /v1/setup to
 * create the Supreme OS administrator, then everything comes online and the wizard is
 * logged in. Home Assistant is never given a user.
 */
describe("Setup Wizard (first-run admin creation)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent", SUPREME_SETUP_WIZARD: "1" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const json = (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("reports setup required before any admin exists", async () => {
    const res = await json("/v1/setup/status");
    expect(res.status).toBe(200);
    expect((await res.json()).setupRequired).toBe(true);
  });

  it("rejects logins until the admin is created", async () => {
    const res = await json("/v1/auth/login", { email: "anyone@supreme.local", password: "whatever123" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("validates the wizard input", async () => {
    const short = await json("/v1/setup", { username: "ab", email: "a@b.com", password: "longenough1", systemName: "Home" });
    expect(short.status).toBe(422); // validation_failed
    const mismatch = await json("/v1/setup", {
      username: "installer",
      email: "installer@example.com",
      password: "longenough1",
      confirmPassword: "different1",
      systemName: "Home",
    });
    expect(mismatch.status).toBe(422);
  });

  // § live-confirmed fix — a synthesized "@supreme.local" fallback for a missing email
  // used to silently lock the very first account out of its own password-recovery flow
  // forever (forgot-password needs a real address to send a reset to). Email is now a
  // mandatory, validated field, never fabricated.
  it("rejects setup with no email, and with a malformed one", async () => {
    const missing = await json("/v1/setup", { username: "installer", password: "longenough1", confirmPassword: "longenough1", systemName: "Home" });
    expect(missing.status).toBe(422);
    const malformed = await json("/v1/setup", { username: "installer", email: "not-an-email", password: "longenough1", confirmPassword: "longenough1", systemName: "Home" });
    expect(malformed.status).toBe(422);
  });

  it("creates the administrator, comes online, and lands logged in", async () => {
    const res = await json("/v1/setup", {
      username: "installer",
      email: "installer@example.com",
      password: "supreme-admin-pass",
      confirmPassword: "supreme-admin-pass",
      systemName: "The Penthouse",
      location: "London",
      timeZone: "Europe/London",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.loginEmail).toBe("installer@example.com");

    // Setup is no longer required, and replaying it is refused.
    expect((await (await json("/v1/setup/status")).json()).setupRequired).toBe(false);
    expect((await json("/v1/setup", { username: "x2", email: "x2@example.com", password: "yyyyyyyy", systemName: "Y" })).status).toBe(409);

    // The new admin can authenticate normally.
    const login = await json("/v1/auth/login", { email: "installer@example.com", password: "supreme-admin-pass" });
    expect(login.status).toBe(200);
    const { accessToken } = await login.json();
    expect(accessToken).toBeTruthy();

    // The home the wizard just commissioned must actually be visible through HomeService —
    // identity.commission() and HomeService keep separate stores, so a missing wire-up here
    // makes every home-scoped route (/v1/home, /v1/rooms, /v1/devices, …) 404 forever for any
    // installation that went through the real wizard, even though login succeeds.
    const home = await fetch(`${baseUrl}/v1/home`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(home.status).toBe(200);
    const homeBody = await home.json();
    expect(homeBody.home.name).toBe("The Penthouse");
  });
});
