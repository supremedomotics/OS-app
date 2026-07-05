import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HubCommand, HubDevice, HubRouter } from "./hub-router.js";
import { OAuthProvider, type LinkRecord } from "./oauth.js";
import { buildVoiceServer } from "./server.js";
import type { AssistantNotifier, AssistantReport } from "./reporting.js";

/**
 * End-to-end certification surface: link an account over OAuth2, then drive Alexa Smart Home and
 * Google fulfillment through the webhooks, asserting each forwards the correct Supreme command to a
 * (fake) hub. This is the contract Amazon/Google certify against.
 */

const DEVICES: HubDevice[] = [
  { id: "dev-light", name: "Living Room Lamp", roomId: "lr", supremeType: "light", status: "online", capabilities: [{ kind: "onoff" }, { kind: "brightness" }, { kind: "color" }], state: { onoff: { kind: "onoff", on: false }, brightness: { kind: "brightness", level: 40 } } },
  { id: "dev-lock", name: "Front Door", roomId: "hall", supremeType: "lock", status: "online", capabilities: [{ kind: "lock" }], state: { lock: { kind: "lock", locked: true } } },
];

class FakeHub implements HubRouter {
  commands: { deviceId: string; command: HubCommand; hubToken: string }[] = [];
  async listDevices(): Promise<HubDevice[]> {
    return DEVICES;
  }
  async getDevice(_link: LinkRecord, deviceId: string): Promise<HubDevice | undefined> {
    return DEVICES.find((d) => d.id === deviceId);
  }
  async command(link: LinkRecord, deviceId: string, command: HubCommand) {
    this.commands.push({ deviceId, command, hubToken: link.hubToken });
    return { ok: true, status: 200 };
  }
}

describe("Voice cloud HTTP surface", () => {
  let app: FastifyInstance;
  let hub: FakeHub;
  let accessToken: string;
  const redirectUri = "https://layla.amazon.com/cb";
  const reports: AssistantReport[] = [];
  const notifier: AssistantNotifier = { notify: async (r) => void reports.push(r) };

  beforeAll(async () => {
    hub = new FakeHub();
    const oauth = new OAuthProvider({
      signingSecret: "srv-secret",
      clients: [{ clientId: "alexa-client", clientSecret: "alexa-secret", assistant: "alexa", redirectUris: [redirectUri] }],
    });
    app = buildVoiceServer({
      oauth,
      hub,
      hubKeys: new Map([["hub-key-1", "home-1"]]),
      notifier,
      authenticateUser: async ({ email, password }) =>
        email === "owner@supreme.local" && password === "pw" ? { accountId: "acct-1", homeId: "home-1", hubToken: "hub-token-1" } : null,
      logLevel: "silent",
    });
    await app.ready();

    // 1. Consent decision → redirect carrying an auth code (CSRF ticket fetched from /authorize).
    const decision = await decisionPost({ email: "owner@supreme.local", password: "pw", state: "xyz" });
    expect(decision.statusCode).toBe(302);
    const code = new URL(decision.headers.location as string).searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 2. Token exchange.
    const tokenRes = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: "alexa-client", client_secret: "alexa-secret" }).toString(),
    });
    expect(tokenRes.statusCode).toBe(200);
    accessToken = tokenRes.json().access_token;
    expect(accessToken).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Mimic a browser: GET /authorize to obtain the CSRF ticket, then POST the consent decision. */
  async function decisionPost(fields: { email: string; password: string; state?: string; csrf?: string }) {
    const authorize = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=alexa-client&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`,
    });
    const csrf = fields.csrf ?? /name="csrf" value="([^"]*)"/.exec(authorize.body)?.[1] ?? "";
    return app.inject({
      method: "POST",
      url: "/oauth/authorize/decision",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: "alexa-client",
        redirect_uri: redirectUri,
        response_type: "code",
        ...(fields.state ? { state: fields.state } : {}),
        csrf,
        email: fields.email,
        password: fields.password,
      }).toString(),
    });
  }

  it("rejects an unauthenticated consent decision (wrong password)", async () => {
    const res = await decisionPost({ email: "owner@supreme.local", password: "nope" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a consent decision with a missing/forged CSRF ticket", async () => {
    const res = await decisionPost({ email: "owner@supreme.local", password: "pw", csrf: "forged" });
    expect(res.statusCode).toBe(403);
  });

  it("serves Alexa Discovery with projected endpoints", async () => {
    const res = await alexa({ namespace: "Alexa.Discovery", name: "Discover", payloadScope: accessToken });
    const body = res.json();
    const endpoints = body.event.payload.endpoints;
    expect(endpoints).toHaveLength(2);
    const lamp = endpoints.find((e: { endpointId: string }) => e.endpointId === "dev-light");
    const ifaces = lamp.capabilities.map((c: { interface: string }) => c.interface);
    expect(ifaces).toContain("Alexa.PowerController");
    expect(ifaces).toContain("Alexa.BrightnessController");
  });

  it("routes an Alexa TurnOn to a Supreme onoff command on the hub", async () => {
    hub.commands = [];
    const res = await alexa({ namespace: "Alexa.PowerController", name: "TurnOn", endpointId: "dev-light", endpointScope: accessToken });
    const body = res.json();
    expect(body.event.header.namespace).toBe("Alexa");
    expect(body.event.header.name).toBe("Response");
    expect(body.context.properties[0]).toMatchObject({ namespace: "Alexa.PowerController", name: "powerState", value: "ON" });
    expect(hub.commands).toEqual([{ deviceId: "dev-light", command: { capability: "onoff", action: "on" }, hubToken: "hub-token-1" }]);
  });

  it("routes Alexa SetBrightness with the level", async () => {
    hub.commands = [];
    await alexa({ namespace: "Alexa.BrightnessController", name: "SetBrightness", endpointId: "dev-light", endpointScope: accessToken, payload: { brightness: 75 } });
    expect(hub.commands[0]?.command).toEqual({ capability: "brightness", action: "set", level: 75 });
  });

  it("returns an Alexa error when the account is not linked", async () => {
    const res = await alexa({ namespace: "Alexa.PowerController", name: "TurnOn", endpointId: "dev-light", endpointScope: "bogus-token" });
    expect(res.json().event.header.name).toBe("ErrorResponse");
    expect(res.json().event.payload.type).toBe("INVALID_AUTHORIZATION_CREDENTIAL");
  });

  it("reports Alexa device state", async () => {
    const res = await alexa({ namespace: "Alexa", name: "ReportState", endpointId: "dev-lock", endpointScope: accessToken });
    const props = res.json().context.properties;
    expect(props).toContainEqual(expect.objectContaining({ namespace: "Alexa.LockController", name: "lockState", value: "LOCKED" }));
  });

  it("handles Google SYNC with traits + types", async () => {
    const res = await google("action.devices.SYNC", {});
    const payload = res.json().payload;
    expect(payload.agentUserId).toBe("acct-1");
    const lamp = payload.devices.find((d: { id: string }) => d.id === "dev-light");
    expect(lamp.type).toBe("action.devices.types.LIGHT");
    expect(lamp.traits).toContain("action.devices.traits.OnOff");
    expect(lamp.traits).toContain("action.devices.traits.Brightness");
  });

  it("executes a Google OnOff command on the hub", async () => {
    hub.commands = [];
    const res = await google("action.devices.EXECUTE", {
      commands: [{ devices: [{ id: "dev-light" }], execution: [{ command: "action.devices.commands.OnOff", params: { on: true } }] }],
    });
    expect(res.json().payload.commands[0]).toMatchObject({ ids: ["dev-light"], status: "SUCCESS" });
    expect(hub.commands[0]?.command).toEqual({ capability: "onoff", action: "on" });
  });

  it("answers a Google QUERY with device state", async () => {
    const res = await google("action.devices.QUERY", { devices: [{ id: "dev-light" }, { id: "dev-lock" }] });
    const devices = res.json().payload.devices;
    expect(devices["dev-light"]).toMatchObject({ online: true, on: false, brightness: 40 });
    expect(devices["dev-lock"]).toMatchObject({ isLocked: true });
  });

  it("returns 401 to Google when unlinked so it re-links", async () => {
    const res = await app.inject({ method: "POST", url: "/voice/google", headers: { authorization: "Bearer nope" }, payload: { requestId: "r", inputs: [{ intent: "action.devices.SYNC" }] } });
    expect(res.statusCode).toBe(401);
    expect(res.json().payload.errorCode).toBe("authFailure");
  });

  it("accepts an Alexa AcceptGrant (proactive-reporting enrollment)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/voice/alexa",
      payload: {
        directive: {
          header: { namespace: "Alexa.Authorization", name: "AcceptGrant", payloadVersion: "3", messageId: "m" },
          payload: { grant: { type: "OAuth2.AuthorizationCode", code: "grant-code" }, grantee: { type: "BearerToken", token: accessToken } },
        },
      },
    });
    expect(res.json().event.header.name).toBe("AcceptGrant.Response");
  });

  it("ingests a hub state delta and fans a proactive ChangeReport to the linked assistant", async () => {
    reports.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/state",
      headers: { authorization: "Bearer hub-key-1", "content-type": "application/json" },
      payload: { deviceId: "dev-light", capability: "onoff", state: { on: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);
    expect(reports[0]?.assistant).toBe("alexa");
    expect((reports[0]?.payload as any).event.header.name).toBe("ChangeReport");
  });

  it("rejects state ingest without a valid hub key", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/state", headers: { authorization: "Bearer nope" }, payload: { deviceId: "d", capability: "onoff", state: {} } });
    expect(res.statusCode).toBe(401);
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────
  function alexa(o: { namespace: string; name: string; endpointId?: string; endpointScope?: string; payloadScope?: string; payload?: Record<string, unknown> }) {
    const directive: Record<string, unknown> = {
      header: { namespace: o.namespace, name: o.name, payloadVersion: "3", messageId: "m1", correlationToken: "ct" },
      payload: { ...(o.payload ?? {}), ...(o.payloadScope ? { scope: { type: "BearerToken", token: o.payloadScope } } : {}) },
    };
    if (o.endpointId) directive.endpoint = { endpointId: o.endpointId, scope: o.endpointScope ? { type: "BearerToken", token: o.endpointScope } : undefined };
    return app.inject({ method: "POST", url: "/voice/alexa", payload: { directive } });
  }
  function google(intent: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/voice/google", headers: { authorization: `Bearer ${accessToken}` }, payload: { requestId: "req-1", inputs: [{ intent, payload }] } });
  }
});
