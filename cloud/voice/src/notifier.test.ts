import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpAssistantNotifier } from "./notifier.js";
import type { LinkRecord } from "./oauth.js";
import type { AssistantReport } from "./reporting.js";

const link = (assistant: "alexa" | "google", grant?: { code: string; granteeToken: string }): LinkRecord => ({
  linkId: `lnk-${assistant}`,
  assistant,
  clientId: "c",
  refreshGen: 0,
  accountId: "acct-1",
  homeId: "home-1",
  hubToken: "ht",
  scopes: ["control"],
  linkedAt: 0,
  ...(grant ? { acceptGrant: grant } : {}),
});

/** A fetch stub that records calls and returns scripted responses by URL substring. */
function stubFetch(routes: { match: string; json?: unknown; ok?: boolean; status?: number }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    return { ok: route?.ok ?? true, status: route?.status ?? 200, json: async () => route?.json ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("HttpAssistantNotifier — Alexa event gateway", () => {
  it("exchanges the AcceptGrant code for an event token and POSTs the ChangeReport with it", async () => {
    const { f, calls } = stubFetch([
      { match: "o2/token", json: { access_token: "evt-token", expires_in: 3600 } },
      { match: "v3/events", json: {} },
    ]);
    const notifier = new HttpAssistantNotifier({ alexa: { clientId: "cid", clientSecret: "sec" }, fetchImpl: f, now: () => 1000 });
    const report: AssistantReport = { assistant: "alexa", payload: { event: { header: { name: "ChangeReport" }, endpoint: { endpointId: "d1" } } } };

    await notifier.notify(report, link("alexa", { code: "grant-code", granteeToken: "gt" }));

    const tokenCall = calls.find((c) => c.url.includes("o2/token"))!;
    expect((tokenCall.init.body as string)).toContain("code=grant-code");
    const eventCall = calls.find((c) => c.url.includes("v3/events"))!;
    expect((eventCall.init.headers as Record<string, string>).authorization).toBe("Bearer evt-token");
    // The event-gateway token is injected into the endpoint scope the builder left empty.
    expect((report.payload as any).event.endpoint.scope).toEqual({ type: "BearerToken", token: "evt-token" });
  });

  it("caches the Alexa token across reports (one exchange, two events)", async () => {
    const { f, calls } = stubFetch([
      { match: "o2/token", json: { access_token: "evt-token", expires_in: 3600 } },
      { match: "v3/events", json: {} },
    ]);
    const notifier = new HttpAssistantNotifier({ alexa: { clientId: "cid", clientSecret: "sec" }, fetchImpl: f, now: () => 1000 });
    const l = link("alexa", { code: "g", granteeToken: "gt" });
    const mk = (): AssistantReport => ({ assistant: "alexa", payload: { event: { endpoint: { endpointId: "d1" } } } });
    await notifier.notify(mk(), l);
    await notifier.notify(mk(), l);
    expect(calls.filter((c) => c.url.includes("o2/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("v3/events"))).toHaveLength(2);
  });

  it("skips an Alexa link that never enrolled (no AcceptGrant)", async () => {
    const { f, calls } = stubFetch([]);
    const notifier = new HttpAssistantNotifier({ alexa: { clientId: "c", clientSecret: "s" }, fetchImpl: f });
    await notifier.notify({ assistant: "alexa", payload: { event: { endpoint: {} } } }, link("alexa"));
    expect(calls).toHaveLength(0);
  });
});

describe("HttpAssistantNotifier — Google HomeGraph", () => {
  it("mints a valid RS256 service-account JWT, exchanges it, and POSTs ReportState", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const { f, calls } = stubFetch([
      { match: "oauth2.googleapis.com/token", json: { access_token: "hg-token", expires_in: 3600 } },
      { match: "reportStateAndNotification", json: {} },
    ]);
    const notifier = new HttpAssistantNotifier({ google: { serviceAccountEmail: "sa@p.iam", privateKey: pem }, fetchImpl: f, now: () => 1_000_000 });

    await notifier.notify({ assistant: "google", payload: { requestId: "r", agentUserId: "acct-1", payload: {} } }, link("google"));

    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    const body = tokenCall.init.body as string;
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    // The assertion is a well-formed three-part JWT with an RS256 header.
    const assertion = new URLSearchParams(body).get("assertion")!;
    const [h, , s] = assertion.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(s!.length).toBeGreaterThan(0);
    const reportCall = calls.find((c) => c.url.includes("reportStateAndNotification"))!;
    expect((reportCall.init.headers as Record<string, string>).authorization).toBe("Bearer hg-token");
  });

  it("throws when HomeGraph rejects (so dispatchStateDelta isolates it)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const { f } = stubFetch([
      { match: "oauth2.googleapis.com/token", json: { access_token: "hg" } },
      { match: "reportStateAndNotification", ok: false, status: 403 },
    ]);
    const notifier = new HttpAssistantNotifier({ google: { serviceAccountEmail: "sa@p", privateKey: pem }, fetchImpl: f, now: () => 1 });
    await expect(notifier.notify({ assistant: "google", payload: {} }, link("google"))).rejects.toThrow(/403/);
  });
});
