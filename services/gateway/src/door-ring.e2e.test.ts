import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  EntityRegistryMirror,
  MigrationPolicy,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import type { IPushProvider, PushMessage, PushPlatform, PushToken } from "@supreme/notifications";
import type { NotificationList } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/** A door-station-like driver that can fire a `ring` sensor event. */
class FakeDoorDriver implements INativeProtocolDriver {
  readonly protocol = "fake-door";
  private connected = false;
  private readonly listeners = new Set<StateListener>();
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async bind(_b: ProtocolBinding) {}
  manages(_d: DeviceId) {
    return false;
  }
  async command(_d: DeviceId, _c: CapabilityCommand) {}
  getState(_d: DeviceId, _c: CapabilityKind): CapabilityState | null {
    return null;
  }
  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
  onState(l: StateListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  ring(deviceId: DeviceId) {
    for (const l of this.listeners) {
      l({
        deviceId,
        capability: "sensor",
        state: { kind: "sensor", value: 1, unit: "", measure: "ring" },
        ts: new Date().toISOString(),
      });
    }
  }
}

class FakeProvider implements IPushProvider {
  readonly sent: PushMessage[] = [];
  supports(_p: PushPlatform) {
    return true;
  }
  async send(_t: PushToken, message: PushMessage) {
    this.sent.push(message);
  }
}

/**
 * Closes the door-intercom loop (§13): a SIP-style `ring` sensor event flows through
 * the native engine → the gateway raises a notification automatically (no
 * user-authored automation) → it reaches WSS history AND push.
 */
describe("Door ring → notification → push", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;
  let token = "";
  const driver = new FakeDoorDriver();
  const push = new FakeProvider();

  beforeAll(async () => {
    const registry = new EntityRegistryMirror();
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    const sil = new SupremeIntegrationLayer({
      adapter: new RoutingBackendAdapter({
        ha: new MockAdapter(),
        native,
        registry,
        policy: new MigrationPolicy(),
      }),
      registry,
    });
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      sil,
      pushProviders: [push],
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
    await fetch(`${baseUrl}/v1/push/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ platform: "fcm", token: "phone-1" }),
    });
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("a ring raises a notification and pushes it", async () => {
    driver.ring("device-front-door" as DeviceId);
    await new Promise((r) => setTimeout(r, 30));

    // WSS/history side: the notification was recorded.
    const list = (await (
      await fetch(`${baseUrl}/v1/notifications`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as NotificationList;
    expect(list.notifications.some((n) => n.body === "Someone is at the door")).toBe(true);

    // Push side: it reached the registered device.
    expect(push.sent.some((m) => m.body === "Someone is at the door")).toBe(true);
  });

  it("does not re-notify while the ring sensor holds its value (rising edge only)", async () => {
    const before = push.sent.length;
    driver.ring("device-front-door" as DeviceId); // value still 1 → no new edge
    await new Promise((r) => setTimeout(r, 30));
    expect(push.sent.length).toBe(before);
  });
});
