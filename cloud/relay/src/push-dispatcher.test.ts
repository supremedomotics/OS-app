import { describe, expect, it, vi } from "vitest";
import {
  FcmProvider,
  PushDispatcher,
  WebPushProvider,
  type IRelayPushProvider,
  type RelayPushPayload,
} from "./push-dispatcher.js";

const payload = (platform: string, token: string): RelayPushPayload => ({
  platform,
  token,
  message: { title: "Front door", body: "Motion detected", level: "warning", data: { x: "1" } },
});

describe("PushDispatcher", () => {
  it("routes to the provider for the payload's platform", async () => {
    const seen: string[] = [];
    const provider = (platform: string): IRelayPushProvider => ({
      platform,
      deliver: async (p) => void seen.push(`${platform}:${p.token}`),
    });
    const d = new PushDispatcher([provider("fcm"), provider("apns")]);
    expect(await d.dispatch(payload("fcm", "t1"))).toBe(true);
    expect(await d.dispatch(payload("webpush", "t2"))).toBe(false); // no provider
    expect(seen).toEqual(["fcm:t1"]);
  });
});

describe("FcmProvider", () => {
  it("POSTs an HTTP v1 message with the access token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = new FcmProvider({
      projectId: "supreme-proj",
      getAccessToken: async () => "ya29.token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.deliver(payload("fcm", "device-1"));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://fcm.googleapis.com/v1/projects/supreme-proj/messages:send");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.message.token).toBe("device-1");
    expect(body.message.notification.title).toBe("Front door");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer ya29.token" });
  });

  it("throws on a non-2xx response", async () => {
    const provider = new FcmProvider({
      projectId: "p",
      getAccessToken: async () => "t",
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(provider.deliver(payload("fcm", "x"))).rejects.toThrow(/fcm 404/);
  });
});

describe("WebPushProvider", () => {
  it("delegates to the injected web-push send", async () => {
    const send = vi.fn(async () => {});
    await new WebPushProvider({ send }).deliver(payload("webpush", "sub-json"));
    expect(send).toHaveBeenCalledWith("sub-json", expect.stringContaining("Motion detected"));
  });
});
