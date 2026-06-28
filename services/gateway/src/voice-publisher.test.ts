import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceStatePublisher } from "./voice-publisher.js";

/**
 * The hub-side debounced publisher that feeds the cloud Voice service's /v1/state ingest. Proves it
 * POSTs the delta with the hub key, coalesces a flurry to the latest value, and never throws when
 * the cloud is unreachable (local control must be unaffected).
 */
describe("VoiceStatePublisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const onoff = (on: boolean) => ({ deviceId: "d1", capability: "onoff", state: { kind: "onoff", on } as const });

  it("POSTs the delta to /v1/state with the hub key after the debounce window", async () => {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const pub = new VoiceStatePublisher({ baseUrl: "https://voice.supremedomotics.in", hubKey: "hub-key-1", debounceMs: 100, fetchImpl });

    pub.publish(onoff(true));
    expect(calls).toHaveLength(0); // debounced, not yet sent
    await vi.advanceTimersByTimeAsync(120);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://voice.supremedomotics.in/v1/state");
    expect(calls[0]!.auth).toBe("Bearer hub-key-1");
    expect(calls[0]!.body).toEqual({ deviceId: "d1", capability: "onoff", state: { kind: "onoff", on: true } });
  });

  it("coalesces a flurry of changes to the latest value", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const pub = new VoiceStatePublisher({ baseUrl: "https://v", hubKey: "k", debounceMs: 100, fetchImpl });

    pub.publish(onoff(true));
    pub.publish(onoff(false));
    pub.publish(onoff(true));
    await vi.advanceTimersByTimeAsync(120);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].state.on).toBe(true);
  });

  it("does not throw when the cloud is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const pub = new VoiceStatePublisher({ baseUrl: "https://v", hubKey: "k", debounceMs: 50, fetchImpl });
    pub.publish(onoff(true));
    await expect(vi.advanceTimersByTimeAsync(80)).resolves.not.toThrow();
  });

  it("stop() cancels pending deliveries", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const pub = new VoiceStatePublisher({ baseUrl: "https://v", hubKey: "k", debounceMs: 100, fetchImpl });
    pub.publish(onoff(true));
    pub.stop();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(0);
  });
});
