import type { CharacteristicWrite, HapAccessory, HapTransport } from "@supreme/homekit";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * HomeKit bridge end-to-end through the gateway: with a (faked) HAP transport, the demo home is
 * published as accessories, and a HomeKit characteristic write routes back through the SIL to change
 * the device — exactly as Apple Home would drive it. Only the HAP server/pairing is faked.
 */
class FakeTransport implements HapTransport {
  published: HapAccessory[] = [];
  updates: { accessoryId: string; characteristic: string; value: number | boolean }[] = [];
  started = false;
  private handler?: (w: CharacteristicWrite) => void;
  publishAccessory(a: HapAccessory) {
    this.published.push(a);
  }
  updateCharacteristic(accessoryId: string, characteristic: string, value: number | boolean) {
    this.updates.push({ accessoryId, characteristic, value });
  }
  onWrite(handler: (w: CharacteristicWrite) => void) {
    this.handler = handler;
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  emitWrite(w: CharacteristicWrite) {
    this.handler?.(w);
  }
}

describe("HomeKit bridge (gateway e2e)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  const transport = new FakeTransport();

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }), { homekitTransport: transport });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });
  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("publishes the demo home as HomeKit accessories", () => {
    expect(transport.started).toBe(true);
    expect(transport.published.length).toBeGreaterThan(0);
  });

  it("reports HomeKit status as enabled with accessories", async () => {
    const res = await fetch(`${baseUrl}/v1/homekit/status`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; accessoryCount: number };
    expect(body.enabled).toBe(true);
    expect(body.accessoryCount).toBe(transport.published.length);
  });

  it("routes a HomeKit On write through the SIL to change the device", async () => {
    // Find a published accessory exposing the On characteristic (an onoff/brightness device).
    const acc = transport.published.find((a) => a.services.some((s) => s.characteristics.includes("On")))!;
    expect(acc).toBeTruthy();

    transport.emitWrite({ accessoryId: acc.id, characteristic: "On", value: true });
    await new Promise((r) => setTimeout(r, 50)); // let the command flow through the SIL

    const device = await ctx.home.getDevice(acc.id as never);
    const onoff = device?.state?.onoff as { on?: boolean } | undefined;
    expect(onoff?.on).toBe(true);
  });
});
