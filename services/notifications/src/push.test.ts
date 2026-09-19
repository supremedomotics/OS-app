import { newId, type HomeId, type NotificationId, type UserId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryPushTokenStore,
  PushService,
  RelayPushProvider,
  type IPushProvider,
  type PushMessage,
  type PushToken,
} from "./push.js";

const tok = (userId: string, platform: PushToken["platform"], token: string): PushToken => ({
  id: newId("session"),
  userId: userId as UserId,
  platform,
  token,
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
});

const notif = (userId: string | null) => ({
  id: newId("notification") as NotificationId,
  homeId: newId("home") as HomeId,
  userId: userId as UserId | null,
  level: "warning" as const,
  title: "Front door",
  body: "Motion detected",
  context: {},
  createdAt: new Date().toISOString(),
  readAt: null,
});

class FakeProvider implements IPushProvider {
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  constructor(private readonly platform: PushToken["platform"]) {}
  supports(platform: PushToken["platform"]) {
    return platform === this.platform;
  }
  async send(token: PushToken, message: PushMessage) {
    this.sent.push({ token: token.token, message });
  }
}

describe("PushService", () => {
  it("delivers a user notification to that user's tokens via the matching provider", async () => {
    const store = new InMemoryPushTokenStore();
    await store.register(tok("user-a", "fcm", "tok-a1"));
    await store.register(tok("user-a", "apns", "tok-a2"));
    await store.register(tok("user-b", "fcm", "tok-b1"));
    const fcm = new FakeProvider("fcm");
    const apns = new FakeProvider("apns");
    const push = new PushService(store, [fcm, apns]);

    const sent = await push.deliver(notif("user-a"));
    expect(sent).toBe(2);
    expect(fcm.sent.map((s) => s.token)).toEqual(["tok-a1"]);
    expect(apns.sent.map((s) => s.token)).toEqual(["tok-a2"]);
    expect(fcm.sent[0]?.message.title).toBe("Front door");
  });

  it("fans a broadcast (userId=null) notification to all tokens", async () => {
    const store = new InMemoryPushTokenStore();
    await store.register(tok("user-a", "fcm", "a"));
    await store.register(tok("user-b", "fcm", "b"));
    const fcm = new FakeProvider("fcm");
    expect(await new PushService(store, [fcm]).deliver(notif(null))).toBe(2);
  });

  it("§Phase13.2 §7 — stamps the routing envelope (hubId/eventId/ts) into the push data payload when a hubId is configured", async () => {
    const store = new InMemoryPushTokenStore();
    await store.register(tok("user-a", "fcm", "tok-a1"));
    const fcm = new FakeProvider("fcm");
    const push = new PushService(store, [fcm], "hub-abc-123");

    const n = notif("user-a");
    await push.deliver(n);

    const data = fcm.sent[0]!.message.data;
    expect(data.hubId).toBe("hub-abc-123");
    expect(data.eventId).toBe(n.id);
    expect(data.ts).toBe(n.createdAt);
    expect(data.v).toBe("1");
    // Never leaks a credential or authoritative state into the payload.
    expect(Object.keys(data)).not.toContain("token");
    expect(Object.keys(data)).not.toContain("bearerToken");
  });

  it("omits the routing envelope entirely when no hubId is configured (backward compatible)", async () => {
    const store = new InMemoryPushTokenStore();
    await store.register(tok("user-a", "fcm", "tok-a1"));
    const fcm = new FakeProvider("fcm");
    await new PushService(store, [fcm]).deliver(notif("user-a"));

    const data = fcm.sent[0]!.message.data;
    expect(data.hubId).toBeUndefined();
    expect(data.notificationId).toBeTruthy(); // existing fields unchanged
  });

  it("is a no-op (WSS-only degrade) when no provider is configured", async () => {
    const push = new PushService(new InMemoryPushTokenStore(), []);
    expect(push.enabled).toBe(false);
    expect(await push.deliver(notif("user-a"))).toBe(0);
  });

  it("RelayPushProvider forwards to the cloud relay", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const provider = new RelayPushProvider({
      url: "https://cloud.supreme/push",
      authToken: "hub-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.send(tok("user-a", "fcm", "tok-x"), {
      title: "t",
      body: "b",
      level: "info",
      data: {},
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.supreme/push");
    const init = opts as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer hub-key");
    expect(JSON.parse(init.body as string).token).toBe("tok-x");
  });
});
