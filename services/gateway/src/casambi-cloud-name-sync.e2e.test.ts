import type { License } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * § Casambi Local Gateway — one-time Cloud name sync, gateway route (`POST /v1/drivers/:id/
 * casambi/sync-names`) coverage. The feature's real logic — matching by unit id, REST-only (no
 * WebSocket), never overwriting a name with an empty one, throwing in Cloud mode — is already
 * fully exercised in `services/protocols/src/casambi/casambi-driver.test.ts` against the real
 * driver. This file proves the route wiring itself: it finds the right driver, and it validates
 * before ever reaching the driver.
 *
 * What this file does NOT (and, in this codebase's own established test infrastructure, cannot)
 * cover: the success path against a genuinely LIVE, connected `CasambiProtocolDriver` reached
 * through `ctx.sil.getNativeDriver("casambi")`. `AppContext.create()`'s default test/dev wiring
 * (`context.ts`) constructs the SIL with a bare `MockAdapter`, not the `ProviderRouter` real boot
 * (`bootstrap.ts`'s `createHubContext`) uses — so `getNativeDriver()` always returns `null` here,
 * exactly as it would on a real dev deployment with no router configured. No existing test in
 * this codebase (including the pre-existing `/casambi/diagnostics` and `/casambi/transport-
 * monitor` routes, which read a live driver the identical way) stands up a router-backed SIL to
 * test this path either — building that harness from scratch is out of scope for this feature and
 * would duplicate `createHubContext`'s own wiring by hand. Documented here rather than silently
 * skipped or faked.
 */
describe("Casambi Cloud name sync route (§ Local Gateway one-time name sync)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    const ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;

    const issued = (await (
      await fetch(`${baseUrl}/v1/license/dev-issue`, { method: "POST", headers: auth(), body: JSON.stringify({ sku: "pro", seats: 10 }) })
    ).json()) as { token: License };
    await fetch(`${baseUrl}/v1/license/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ token: issued.token }) });
  });
  afterAll(async () => {
    await app.close();
  });

  function auth() {
    return { "content-type": "application/json", authorization: `Bearer ${token}` };
  }

  it("404s for a driver id that isn't the Casambi driver", async () => {
    const resp = await fetch(`${baseUrl}/v1/drivers/not-a-real-id/casambi/sync-names`, { method: "POST", headers: auth() });
    expect(resp.status).toBe(404);
  });

  it("404s with a clear message when Casambi is installed but has no live native-driver instance registered", async () => {
    const install = (await (
      await fetch(`${baseUrl}/v1/drivers/install`, { method: "POST", headers: auth(), body: JSON.stringify({ key: "supreme-casambi" }) })
    ).json()) as { driver: { id: string } };
    const resp = await fetch(`${baseUrl}/v1/drivers/${install.driver.id}/casambi/sync-names`, { method: "POST", headers: auth() });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { code: string; message: string };
    expect(body.code).toBe("not_found");
    expect(body.message).toMatch(/not currently running/);
  });
});
