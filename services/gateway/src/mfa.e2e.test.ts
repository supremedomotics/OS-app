import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpAt } from "@supreme/identity";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * MFA enrollment + verify over the HTTP surface (readiness §1): enroll TOTP, then a
 * subsequent login requires the second factor and completes via /v1/auth/mfa/verify.
 */
describe("Gateway MFA flow", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let url: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  const json = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });
  const creds = { email: "owner@supreme.local", password: "supreme-owner-demo-pass" };

  async function login() {
    return (await (
      await fetch(`${url}/v1/auth/login`, { method: "POST", headers: json(), body: JSON.stringify(creds) })
    ).json()) as { status: string; accessToken?: string; mfaToken?: string };
  }

  it("enrolls TOTP, then requires + accepts it on login", async () => {
    // First login (no MFA yet) → tokens.
    const first = await login();
    expect(first.status).toBe("ok");
    const auth = json({ authorization: `Bearer ${first.accessToken}` });

    // Enroll: get a secret, confirm with a valid code.
    const enroll = (await (await fetch(`${url}/v1/me/mfa/enroll`, { method: "POST", headers: auth })).json()) as {
      secret: string;
      otpauthUrl: string;
    };
    expect(enroll.otpauthUrl).toContain("otpauth://totp/");
    const confirm = await fetch(`${url}/v1/me/mfa/confirm`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: totpAt(enroll.secret) }),
    });
    expect(confirm.status).toBe(204);

    // Now login requires the second factor.
    const second = await login();
    expect(second.status).toBe("mfa_required");
    expect(second.mfaToken).toBeTruthy();

    // A wrong code is rejected; the correct code yields tokens.
    const bad = await fetch(`${url}/v1/auth/mfa/verify`, {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ mfaToken: second.mfaToken, code: "000000" }),
    });
    expect(bad.status).toBe(401);

    const ok = (await (
      await fetch(`${url}/v1/auth/mfa/verify`, {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ mfaToken: second.mfaToken, code: totpAt(enroll.secret) }),
      })
    ).json()) as { status: string; accessToken?: string };
    expect(ok.status).toBe("ok");
    expect(ok.accessToken).toBeTruthy();
  });
});
