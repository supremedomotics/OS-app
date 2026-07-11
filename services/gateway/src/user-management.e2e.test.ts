import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * User management (§8): the admin creates Supreme-only users across the 7 roles, and any
 * user can reset their Supreme password — neither path ever touches Home Assistant.
 */
describe("User management + password reset", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let ownerToken = "";

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    ownerToken = ((await res.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("exposes the assignable roles for the create-user form", async () => {
    const res = await fetch(`${baseUrl}/v1/roles`, { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(200);
    const keys = ((await res.json()) as { roles: { key: string; label: string }[] }).roles.map((r) => r.key);
    expect(keys).toEqual([
      "master",
      "admin",
      "homeowner",
      "family",
      "guest",
      "installer",
      "developer",
      "service_engineer",
    ]);
  });

  it("creates a Supreme-only user with a new role (homeowner)", async () => {
    const res = await post(
      "/v1/users",
      {
        email: "resident@supreme.local",
        password: "initial-pass-123",
        displayName: "The Resident",
        userType: "homeowner",
      },
      ownerToken,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { user: { userType: string } }).user.userType).toBe("homeowner");
  });

  it("changes a user's role (e.g. to Installer or Developer) via PATCH /v1/users/:id/role", async () => {
    const created = await post(
      "/v1/users",
      { email: "role-target@supreme.local", password: "initial-pass-123", displayName: "Role Target", userType: "homeowner" },
      ownerToken,
    );
    const userId = ((await created.json()) as { user: { id: string } }).user.id;

    const toInstaller = await fetch(`${baseUrl}/v1/users/${userId}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ userType: "installer" }),
    });
    expect(toInstaller.status).toBe(200);
    expect(((await toInstaller.json()) as { user: { userType: string } }).user.userType).toBe("installer");

    const toDeveloper = await fetch(`${baseUrl}/v1/users/${userId}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ userType: "developer" }),
    });
    expect(toDeveloper.status).toBe(200);
    expect(((await toDeveloper.json()) as { user: { userType: string } }).user.userType).toBe("developer");

    // Promotion to master is rejected by the request schema itself.
    const toMaster = await fetch(`${baseUrl}/v1/users/${userId}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ userType: "master" }),
    });
    expect(toMaster.status).toBe(422);
  });

  it("resets only the Supreme password via forgot → reset", async () => {
    // 1. Request a reset (local hub returns the token in non-production).
    const forgot = await post("/v1/auth/forgot-password", { email: "resident@supreme.local" });
    expect(forgot.status).toBe(200);
    const { resetToken } = (await forgot.json()) as { resetToken?: string };
    expect(resetToken).toBeTruthy();

    // 2. Complete the reset with a new password.
    const reset = await post("/v1/auth/reset-password", { token: resetToken, newPassword: "brand-new-pass-456" });
    expect(reset.status).toBe(204);

    // 3. New password works; old one no longer does.
    const ok = await post("/v1/auth/login", { email: "resident@supreme.local", password: "brand-new-pass-456" });
    expect(ok.status).toBe(200);
    const old = await post("/v1/auth/login", { email: "resident@supreme.local", password: "initial-pass-123" });
    expect(old.status).toBeGreaterThanOrEqual(400);
  });

  it("does not leak whether an email exists (anti-enumeration)", async () => {
    const res = await post("/v1/auth/forgot-password", { email: "nobody@supreme.local" });
    expect(res.status).toBe(200);
    expect((await res.json()).resetToken).toBeUndefined();
  });

  it("rejects a bad reset token", async () => {
    const res = await post("/v1/auth/reset-password", { token: "not-a-real-token", newPassword: "whatever-123" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
