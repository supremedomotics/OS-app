import { AppContext, buildServer, loadConfig } from "@supreme/gateway";
import type { FastifyInstance } from "fastify";
import { MemorySampler, Metrics, type LoadSummary } from "./metrics.js";

/**
 * Load / soak / chaos harness (§5, §15). Boots the REAL gateway (mock backend — no
 * hardware needed), drives it with concurrent virtual users, and measures latency,
 * throughput, errors, and memory. Chaos injectors fault the backend; the harness then
 * asserts recovery. Runnable as a CLI (src/run.ts) and as a fast CI gate (loadtest.test).
 */
export interface Hub {
  app: FastifyInstance;
  ctx: AppContext;
  baseUrl: string;
  wsBaseUrl: string;
  stop: () => Promise<void>;
}

/** Boot a gateway with rate limits raised (so the limiter isn't what we're measuring). */
export async function startHub(): Promise<Hub> {
  const ctx = await AppContext.create(
    loadConfig({
      SUPREME_LOG_LEVEL: "silent",
      SUPREME_RATE_MAX: "100000000",
      SUPREME_AUTH_RATE_MAX: "100000",
    }),
  );
  const app = await buildServer(ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    app,
    ctx,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    stop: async () => {
      await app.close();
      await ctx.shutdown();
    },
  };
}

export interface Session {
  token: string;
  roomId: string;
  deviceId: string;
}

/** Log in once and resolve a room + a controllable device to exercise. */
export async function seedSession(baseUrl: string): Promise<Session> {
  const login = await (
    await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    })
  ).json();
  const token = (login as { accessToken: string }).accessToken;
  const auth = { authorization: `Bearer ${token}` };
  const home = (await (await fetch(`${baseUrl}/v1/home`, { headers: auth })).json()) as {
    rooms: { id: string }[];
  };
  const roomId = home.rooms[0]!.id;
  const devices = (await (
    await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth })
  ).json()) as { devices: { id: string; capabilities: { kind: string }[] }[] };
  const controllable =
    devices.devices.find((d) => d.capabilities.some((c) => c.kind === "onoff" || c.kind === "brightness")) ??
    devices.devices[0]!;
  return { token, roomId, deviceId: controllable.id };
}

export interface LoadOptions {
  baseUrl: string;
  session: Session;
  vus: number;
  durationMs: number;
}

export interface LoadResult extends LoadSummary {
  rssStartMb: number;
  rssEndMb: number;
  rssGrowthMb: number;
}

/**
 * Run the homeowner scenario under `vus` concurrent users for `durationMs`. Each
 * iteration reads the home then issues a device command — the hot path of real use.
 */
export async function runLoad(opts: LoadOptions): Promise<LoadResult> {
  const metrics = new Metrics();
  const mem = new MemorySampler();
  const auth = { authorization: `Bearer ${opts.session.token}`, "content-type": "application/json" };
  const deadline = performance.now() + opts.durationMs;

  const timed = async (fn: () => Promise<Response>): Promise<void> => {
    const t0 = performance.now();
    let ok = false;
    try {
      const res = await fn();
      ok = res.ok;
      await res.arrayBuffer(); // drain the body so sockets are reused
    } catch {
      ok = false;
    }
    metrics.record(performance.now() - t0, ok);
  };

  const iteration = async (): Promise<void> => {
    await timed(() => fetch(`${opts.baseUrl}/v1/home`, { headers: auth }));
    await timed(() =>
      fetch(`${opts.baseUrl}/v1/devices/${opts.session.deviceId}/command`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ command: { capability: "onoff", action: "toggle" } }),
      }),
    );
  };

  const vu = async (): Promise<void> => {
    while (performance.now() < deadline) await iteration();
  };

  mem.sample();
  const sampler = setInterval(() => mem.sample(), 250);
  metrics.start();
  await Promise.all(Array.from({ length: opts.vus }, () => vu()));
  metrics.stop();
  clearInterval(sampler);
  mem.sample();

  return { ...metrics.summary(), rssStartMb: mem.start, rssEndMb: mem.end, rssGrowthMb: mem.growthMb() };
}

/** Connection storm: open `count` WSS, subscribe, confirm each opens. Returns successes. */
export async function connectionStorm(opts: {
  wsBaseUrl: string;
  session: Session;
  count: number;
}): Promise<number> {
  const WS = globalThis.WebSocket as unknown as new (url: string) => {
    addEventListener(t: "open" | "error" | "close", cb: () => void): void;
    send(d: string): void;
    close(): void;
  };
  const url = `${opts.wsBaseUrl}/v1/stream?access_token=${opts.session.token}`;
  const results = await Promise.all(
    Array.from({ length: opts.count }, () =>
      new Promise<boolean>((resolve) => {
        const ws = new WS(url);
        const done = (ok: boolean) => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(ok);
        };
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "subscribe", rooms: [opts.session.roomId] }));
          done(true);
        });
        ws.addEventListener("error", () => done(false));
        setTimeout(() => done(false), 5000);
      }),
    ),
  );
  return results.filter(Boolean).length;
}

/**
 * Chaos: fault the backend (the SIL drops its connection). Returns a `restore()` that
 * brings it back. While faulted, commands surface a clean error (503), not a crash;
 * after restore, control resumes — the recovery the harness asserts.
 */
export async function faultBackend(ctx: AppContext): Promise<() => Promise<void>> {
  await ctx.sil.stop();
  return async () => {
    await ctx.sil.start();
  };
}
