import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptivePoller, HttpPollClient } from "./http-poll-client.js";

/** A tiny in-process HTTP server: counts requests per path, answers with a fixed or
 * per-request-configurable body, and can simulate a slow/failing endpoint. Real `http`
 * throughout (matches `yamaha-driver.test.ts`'s `startFakeYamaha()`), not a fetch mock. */
function startFakeServer(): Promise<{ server: Server; base: string; calls: string[]; methods: string[]; bodies: string[]; delayMs: number; failing: boolean }> {
  const calls: string[] = [];
  const methods: string[] = [];
  const bodies: string[] = [];
  const state = { delayMs: 0, failing: false };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      calls.push(req.url ?? "/");
      methods.push(req.method ?? "GET");
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        bodies.push(raw);
        const respond = () => {
          if (state.failing) {
            res.statusCode = 500;
            res.end("error");
            return;
          }
          res.setHeader("content-type", "text/plain");
          res.end(`ok:${req.url}`);
        };
        if (state.delayMs > 0) setTimeout(respond, state.delayMs);
        else respond();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, calls, methods, bodies, get delayMs() { return state.delayMs; }, set delayMs(v) { state.delayMs = v; }, get failing() { return state.failing; }, set failing(v) { state.failing = v; } });
    });
  });
}

describe("HttpPollClient (§ Universal AVR SDK) — in-process HTTP", () => {
  it("fetches and returns raw response text", async () => {
    const fake = await startFakeServer();
    const client = new HttpPollClient();
    const text = await client.get("host1", `${fake.base}/GetRenameSource.xml`);
    expect(text).toBe("ok:/GetRenameSource.xml");
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("coalesces concurrent requests for the SAME key into ONE real HTTP request", async () => {
    const fake = await startFakeServer();
    fake.delayMs = 30;
    const client = new HttpPollClient();
    const [a, b, c] = await Promise.all([
      client.get("host1", `${fake.base}/status`),
      client.get("host1", `${fake.base}/status`),
      client.get("host1", `${fake.base}/status`),
    ]);
    expect(fake.calls.length).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("does NOT coalesce requests for DIFFERENT keys, even to the same host", async () => {
    const fake = await startFakeServer();
    await Promise.all([
      client_get("host1", fake.base),
      client_get("host2", fake.base),
    ]);
    expect(fake.calls.length).toBe(2);
    await new Promise<void>((r) => fake.server.close(() => r()));

    function client_get(key: string, base: string) {
      return new HttpPollClient().get(key, `${base}/status`);
    }
  });

  it("records real per-key diagnostics counters — packetsSent/Received, lastCommand, and the automatic latency/trace capture", async () => {
    const fake = await startFakeServer();
    const client = new HttpPollClient();
    await client.get("host1", `${fake.base}/GetSoundModeList.xml`);
    const diag = client.diagnosticsFor("host1").snapshot("connected", { protocol: "avr-http", driverVersion: "1.0.0" });
    expect(diag.packetsSent).toBe(1);
    expect(diag.packetsReceived).toBe(1);
    expect(diag.lastCommand).toContain("GetSoundModeList.xml");
    expect(diag.averageLatencyMs).toBeGreaterThanOrEqual(0);
    const trace = client.diagnosticsFor("host1").recentTrace();
    expect(trace.some((t) => t.line.includes("-> GET") && t.line.includes("GetSoundModeList.xml"))).toBe(true);
    expect(trace.some((t) => t.line.startsWith("<- 200"))).toBe(true);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("request() supports POST with a body — Denon's AppCommand.xml is invoked via POST, not GET", async () => {
    const fake = await startFakeServer();
    const client = new HttpPollClient();
    const text = await client.request("host1", `${fake.base}/goform/AppCommand.xml`, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: "<tx><cmd id=\"1\">GetRenameSource</cmd></tx>",
    });
    expect(text).toBe("ok:/goform/AppCommand.xml");
    expect(fake.methods).toEqual(["POST"]);
    expect(fake.bodies[0]).toContain("GetRenameSource");
    const trace = client.diagnosticsFor("host1").recentTrace();
    expect(trace.some((t) => t.line.startsWith("-> POST"))).toBe(true);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("a failed request is recorded as a real error and rejects, never silently swallowed", async () => {
    const fake = await startFakeServer();
    fake.failing = true;
    const client = new HttpPollClient();
    await expect(client.get("host1", `${fake.base}/status`)).rejects.toThrow(/500/);
    const diag = client.diagnosticsFor("host1").snapshot("connected", { protocol: "avr-http", driverVersion: "1.0.0" });
    expect(diag.lastError).toContain("500");
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("a NEW request for the same key after the in-flight one resolves fires a real second request (no permanent caching)", async () => {
    const fake = await startFakeServer();
    const client = new HttpPollClient();
    await client.get("host1", `${fake.base}/status`);
    await client.get("host1", `${fake.base}/status`);
    expect(fake.calls.length).toBe(2);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("releaseKey() drops that key's diagnostics tracker — a fresh read after release starts from real zero counters again", async () => {
    const fake = await startFakeServer();
    const client = new HttpPollClient();
    await client.get("host1", `${fake.base}/status`);
    expect(client.diagnosticsFor("host1").snapshot("connected", { protocol: "avr-http", driverVersion: "1.0.0" }).packetsSent).toBe(1);
    client.releaseKey("host1");
    expect(client.diagnosticsFor("host1").snapshot("connected", { protocol: "avr-http", driverVersion: "1.0.0" }).packetsSent).toBe(0);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("injectable fetchImpl is used instead of the real global fetch, and the ProtocolTracer receives every send/receive", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("fake-body", { status: 200 });
    }) as unknown as typeof fetch;
    const traced: string[] = [];
    const client = new HttpPollClient({
      fetchImpl: fakeFetch,
      tracer: { send: (l) => traced.push(`>${l}`), receive: (l) => traced.push(`<${l}`), event: (l) => traced.push(`!${l}`) },
    });
    const text = await client.get("host1", "http://example.invalid/status");
    expect(text).toBe("fake-body");
    expect(calls).toEqual(["http://example.invalid/status"]);
    expect(traced.some((t) => t.startsWith(">GET"))).toBe(true);
    expect(traced.some((t) => t.startsWith("<200"))).toBe(true);
  });
});

describe("AdaptivePoller (§ Universal AVR SDK) — back off when idle, never poll faster than instructed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks repeatedly at the interval the caller's function currently returns", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = new AdaptivePoller({ intervalMs: () => 1000, tick: () => { ticks += 1; } });
    poller.start();
    expect(ticks).toBe(0); // never ticks synchronously on start()
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(2);
    poller.stop();
  });

  it("adapts its interval per-tick — a caller reporting a longer interval genuinely slows the NEXT scheduling decision", async () => {
    vi.useFakeTimers();
    let playing = true;
    let ticks = 0;
    const poller = new AdaptivePoller({
      intervalMs: () => (playing ? 100 : 10_000),
      // Flip to "slow" the moment the first tick fires — takes effect on the
      // reschedule that happens right after this tick, not retroactively.
      tick: () => { ticks += 1; if (ticks === 1) playing = false; },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(ticks).toBe(1); // fired at the fast interval, as scheduled before playing flipped
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ticks).toBe(1); // the SLOW interval is now in effect — not due yet
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(2); // fires right at the slow interval's boundary
    poller.stop();
  });

  it("a null interval pauses ticking without needing stop()/start() — resumes on its own once the function stops returning null", async () => {
    vi.useFakeTimers();
    let paused = true;
    let ticks = 0;
    const poller = new AdaptivePoller({ intervalMs: () => (paused ? null : 200), tick: () => { ticks += 1; } });
    poller.start();
    await vi.advanceTimersByTimeAsync(5_000); // paused re-check cadence, no real tick fires
    expect(ticks).toBe(0);
    paused = false;
    await vi.advanceTimersByTimeAsync(5_000); // next 5s re-check sees paused=false and resumes
    expect(ticks).toBeGreaterThan(0);
    poller.stop();
  });

  it("stop() prevents any further ticks, including one already scheduled", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = new AdaptivePoller({ intervalMs: () => 100, tick: () => { ticks += 1; } });
    poller.start();
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toBe(0);
  });

  it("start() is idempotent — calling it twice never double-schedules", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const poller = new AdaptivePoller({ intervalMs: () => 100, tick: () => { ticks += 1; } });
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(ticks).toBe(1);
    poller.stop();
  });

  it("an async tick that outlasts the interval never overlaps itself — the next tick waits for the current one to finish", async () => {
    vi.useFakeTimers();
    let concurrent = 0;
    let maxConcurrent = 0;
    let completions = 0;
    const poller = new AdaptivePoller({
      intervalMs: () => 10,
      tick: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent -= 1;
        completions += 1;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(maxConcurrent).toBe(1);
    expect(completions).toBeGreaterThan(0);
    poller.stop();
  });
});
