import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Password lifecycle over HTTP (§12): change-password (authenticated), and the
 * forgot/reset flow. Supreme-only — never touches Home Assistant.
 */
describe("password change + reset", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const json = { "content-type": "application/json" };
  async function login(email: string, password: string) {
    const res = await fetch(`${baseUrl}/v1/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
    return (await res.json()) as { status: string; accessToken?: string };
  }

  it("changes the password only with the correct current password, then logs in with the new one", async () => {
    const owner = "owner@supreme.local";
    const oldPw = "supreme-owner-demo-pass";
    const token = (await login(owner, oldPw)).accessToken!;
    const authHeaders = { ...json, authorization: `Bearer ${token}` };

    // Wrong current password → rejected.
    const wrong = await fetch(`${baseUrl}/v1/me/password`, { method: "POST", headers: authHeaders, body: JSON.stringify({ currentPassword: "nope", newPassword: "new-strong-password-1" }) });
    expect(wrong.status).toBe(401);

    // Correct current password → 204, and the new password works while the old one doesn't.
    const ok = await fetch(`${baseUrl}/v1/me/password`, { method: "POST", headers: authHeaders, body: JSON.stringify({ currentPassword: oldPw, newPassword: "new-strong-password-1" }) });
    expect(ok.status).toBe(204);
    expect((await login(owner, oldPw)).status).toBeUndefined(); // 401 body has no status
    expect((await login(owner, "new-strong-password-1")).status).toBe("ok");

    // Unauthenticated change is rejected.
    const noAuth = await fetch(`${baseUrl}/v1/me/password`, { method: "POST", headers: json, body: JSON.stringify({ currentPassword: "x", newPassword: "yyyyyyyy" }) });
    expect(noAuth.status).toBe(401);
  });

  it("resets a forgotten password with the one-time token the local hub returns", async () => {
    const owner = "owner@supreme.local";
    const forgot = await fetch(`${baseUrl}/v1/auth/forgot-password`, { method: "POST", headers: json, body: JSON.stringify({ email: owner }) });
    expect(forgot.status).toBe(200);
    const { resetToken } = (await forgot.json()) as { ok: boolean; resetToken?: string };
    expect(resetToken).toBeTruthy(); // non-production hub surfaces it for LAN self-service

    const reset = await fetch(`${baseUrl}/v1/auth/reset-password`, { method: "POST", headers: json, body: JSON.stringify({ token: resetToken, newPassword: "reset-password-9" }) });
    expect(reset.status).toBe(204);
    expect((await login(owner, "reset-password-9")).status).toBe("ok");

    // Unknown email still returns 200 (anti-enumeration) with no token.
    const unknown = await fetch(`${baseUrl}/v1/auth/forgot-password`, { method: "POST", headers: json, body: JSON.stringify({ email: "ghost@nowhere.local" }) });
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { resetToken?: string }).resetToken).toBeUndefined();
  });
});
