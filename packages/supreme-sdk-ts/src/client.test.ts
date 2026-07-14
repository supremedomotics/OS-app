import type { DeviceId } from "@supreme/domain-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTokenStore, SupremeClient } from "./client.js";

/** Builds an unsigned-but-shaped JWT carrying only the `exp` claim the SDK actually reads. */
function fakeJwt(expSeconds: number): string {
  const b64 = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
}

/**
 * The access token is short-lived (15 min) by design; every homeowner command must survive it
 * expiring mid-session by silently refreshing and retrying — never surfacing a stale-session error
 * for something that's just a routine token rotation. This is the fix for a bug where the SDK never
 * refreshed at all, so every request started failing 401 (silently, since call sites `void` the
 * promise) once 15 minutes had passed since login — indistinguishable from "the app stopped working".
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SupremeClient — automatic refresh-and-retry on 401", () => {
  it("refreshes once and retries a command that 401s on an expired access token", async () => {
    const calls: { path: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const auth = (init?.headers as Record<string, string>)?.authorization ?? null;
      calls.push({ path, auth });
      if (path === "/v1/devices/dev1/command" && auth === "Bearer stale") {
        return jsonResponse(401, { code: "unauthorized", message: "token expired" });
      }
      if (path === "/v1/auth/refresh") {
        return jsonResponse(200, { accessToken: "fresh", refreshToken: "refresh2", expiresIn: 900, tokenType: "Bearer" });
      }
      if (path === "/v1/devices/dev1/command" && auth === "Bearer fresh") {
        return jsonResponse(200, { accepted: true });
      }
      throw new Error(`unexpected request: ${path}`);
    }) as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    tokenStore.set({ accessToken: "stale", refreshToken: "refresh1" });
    const client = new SupremeClient({ baseUrl: "http://hub.local", tokenStore, fetchImpl });

    const result = await client.command("dev1" as DeviceId, { capability: "onoff", action: "on" });

    expect(result).toEqual({ accepted: true });
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/devices/dev1/command", // first attempt, 401s
      "/v1/auth/refresh", // silent refresh
      "/v1/devices/dev1/command", // retried with the fresh token
    ]);
    expect(client.accessToken).toBe("fresh");
  });

  it("shares one refresh across concurrent 401s instead of racing the refresh endpoint", async () => {
    let refreshCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const auth = (init?.headers as Record<string, string>)?.authorization ?? null;
      if (path === "/v1/auth/refresh") {
        refreshCalls += 1;
        return jsonResponse(200, { accessToken: "fresh", refreshToken: "refresh2", expiresIn: 900, tokenType: "Bearer" });
      }
      if (auth === "Bearer stale") return jsonResponse(401, { code: "unauthorized", message: "expired" });
      return jsonResponse(200, { accepted: true });
    }) as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    tokenStore.set({ accessToken: "stale", refreshToken: "refresh1" });
    const client = new SupremeClient({ baseUrl: "http://hub.local", tokenStore, fetchImpl });

    await Promise.all([
      client.command("dev1" as DeviceId, { capability: "onoff", action: "on" }),
      client.command("dev2" as DeviceId, { capability: "onoff", action: "off" }),
      client.command("dev3" as DeviceId, { capability: "onoff", action: "toggle" }),
    ]);

    expect(refreshCalls).toBe(1);
  });

  it("clears the session and reports it as expired when the refresh token is also dead", async () => {
    let expired = false;
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/auth/refresh") return jsonResponse(401, { code: "unauthorized", message: "refresh token revoked" });
      return jsonResponse(401, { code: "unauthorized", message: "token expired" });
    }) as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    tokenStore.set({ accessToken: "stale", refreshToken: "dead" });
    const client = new SupremeClient({
      baseUrl: "http://hub.local",
      tokenStore,
      fetchImpl,
      onSessionExpired: () => { expired = true; },
    });

    await expect(client.command("dev1" as DeviceId, { capability: "onoff", action: "on" })).rejects.toThrow();
    expect(expired).toBe(true);
    expect(client.accessToken).toBeNull();
  });
});

/**
 * BUG-003: reactive (on-401) refresh alone means every request in flight the instant the access
 * token expires 401s together — a dashboard mount fires a dozen-plus GETs, so that was the "15-18
 * failed requests before the session recovers" symptom. The SDK now also refreshes proactively,
 * ~60s ahead of the token's own `exp` claim, so a session that's actively in use never reaches
 * that burst in the first place.
 */
describe("SupremeClient — proactive refresh ahead of token expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes on its own, before any request ever sees a 401", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let refreshCalls = 0;
    let sawAny401 = false;
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/auth/refresh") {
        refreshCalls += 1;
        return jsonResponse(200, {
          accessToken: fakeJwt(nowSec + 900),
          refreshToken: "refresh2",
          expiresIn: 900,
          tokenType: "Bearer",
        });
      }
      sawAny401 = true; // any other call in this test is unexpected
      return jsonResponse(401, { code: "unauthorized", message: "unexpected call" });
    }) as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    tokenStore.set({ accessToken: fakeJwt(nowSec + 90), refreshToken: "refresh1" });
    new SupremeClient({ baseUrl: "http://hub.local", tokenStore, fetchImpl });

    // Token expires in 90s and the buffer is 60s, so the proactive timer should fire at ~30s.
    await vi.advanceTimersByTimeAsync(31_000);

    expect(refreshCalls).toBe(1);
    expect(sawAny401).toBe(false);
  });

  it("refreshes immediately on construction when a restored session's token is already past the buffer", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let refreshCalls = 0;
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/auth/refresh") {
        refreshCalls += 1;
        return jsonResponse(200, {
          accessToken: fakeJwt(nowSec + 900),
          refreshToken: "refresh2",
          expiresIn: 900,
          tokenType: "Bearer",
        });
      }
      return jsonResponse(401, { code: "unauthorized", message: "unexpected call" });
    }) as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    tokenStore.set({ accessToken: fakeJwt(nowSec + 10), refreshToken: "refresh1" }); // inside the 60s buffer already
    new SupremeClient({ baseUrl: "http://hub.local", tokenStore, fetchImpl });

    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls).toBe(1);
  });
});
