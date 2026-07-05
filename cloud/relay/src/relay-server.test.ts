import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PushDispatcher, type IRelayPushProvider } from "./push-dispatcher.js";
import { buildRelayServer } from "./relay-server.js";

const TOKEN = "hub-secret";

describe("Relay server", () => {
  let app: FastifyInstance;
  let base: string;
  let wsBase: string;
  const sent: string[] = [];

  beforeAll(async () => {
    const fakeProvider: IRelayPushProvider = {
      platform: "fcm",
      deliver: async (p) => void sent.push(p.token),
    };
    app = buildRelayServer({ hubAuthToken: TOKEN, dispatcher: new PushDispatcher([fakeProvider]), logLevel: "silent" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it("rejects unauthenticated push and accepts authenticated push", async () => {
    const body = JSON.stringify({ platform: "fcm", token: "tok-1", message: { title: "t", body: "b", level: "info" } });
    const bad = await fetch(`${base}/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${base}/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body,
    });
    expect(ok.status).toBe(202);
    expect(sent).toContain("tok-1");
  });

  it("returns 503 when the home's hub is offline", async () => {
    const res = await fetch(`${base}/v1/relay/home-x/v1/home`);
    expect(res.status).toBe(503);
  });

  it("forwards an off-LAN request over a connected hub tunnel and returns the hub's response", async () => {
    // A hub dials out and acts as a tiny gateway: echoes the request path back.
    const hub = new WebSocket(`${wsBase}/v1/tunnel?home=home-1&token=${TOKEN}`);
    await new Promise<void>((resolve) => hub.on("open", () => resolve()));
    hub.on("message", (raw) => {
      const req = JSON.parse(raw.toString()) as { t: string; id: string; path: string; method: string };
      if (req.t !== "req") return;
      hub.send(
        JSON.stringify({
          t: "res",
          id: req.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, sawPath: req.path, method: req.method }),
        }),
      );
    });
    // Give the relay a moment to register the socket.
    await vi.waitFor(() => expect(undefined).toBe(undefined));
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${base}/v1/relay/home-1/v1/rooms/abc/devices`, {
      headers: { authorization: "Bearer client-jwt" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; sawPath: string; method: string };
    expect(json.ok).toBe(true);
    expect(json.sawPath).toBe("/v1/rooms/abc/devices");
    expect(json.method).toBe("GET");

    hub.close();
  });
});
