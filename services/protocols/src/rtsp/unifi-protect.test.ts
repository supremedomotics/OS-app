import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listUnifiCameras,
  getUnifiStreamUrls,
  commissionUnifiCameras,
  parseUnifiCameras,
  parseUnifiStreams,
  pickMainAndSub,
  realUnifiHttp,
  UnifiProtectError,
  type UnifiHttp,
  type UnifiCommissionDeps,
} from "./unifi-protect.js";
import { validateConsoleHost } from "./rtsp-url-safety.js";

const KEY = "SECRET-API-KEY-123";
const TOKEN_HIGH = "rtsps://192.168.0.1:7441/tokHIGH?enableSrtp";
const TOKEN_LOW = "rtsps://192.168.0.1:7441/tokLOW?enableSrtp";
const ok = (json: unknown) => ({ status: 200, body: JSON.stringify(json) });

describe("validateConsoleHost", () => {
  it("accepts private IPs in several forms and rejects public hosts / bad schemes", async () => {
    expect((await validateConsoleHost("192.168.0.1")).resolvedAddress).toBe("192.168.0.1");
    const withPort = await validateConsoleHost("https://10.0.0.2:8443/whatever");
    expect(withPort.ok && withPort.port === 8443).toBe(true);
    expect((await validateConsoleHost("8.8.8.8")).ok).toBe(false);
    expect((await validateConsoleHost("http://192.168.0.1")).ok).toBe(false);
    expect((await validateConsoleHost("")).ok).toBe(false);
    expect((await validateConsoleHost("file:///etc/passwd")).ok).toBe(false);
  });
});

describe("parseUnifiCameras", () => {
  it("keeps only id/name/model/state, tolerates missing fields and junk entries", () => {
    const out = parseUnifiCameras([
      { id: "abc123", name: "Front", marketName: "G4 Pro", state: "CONNECTED", mac: "AA", extra: { a: 1 } },
      { id: "def456" },
      { name: "no id" },
      null,
      "x",
      { id: "abc123", name: "dup" },
      { id: "bad id/../" },
    ]);
    expect(out).toEqual([
      { id: "abc123", name: "Front", model: "G4 Pro", state: "CONNECTED" },
      { id: "def456", name: "UniFi camera", model: null, state: null },
    ]);
  });
  it("rejects a non-list answer", () => {
    expect(() => parseUnifiCameras({ nope: true })).toThrow(UnifiProtectError);
  });
});

describe("listUnifiCameras", () => {
  it("sends the key only as a header to the resolved private address, and returns no key", async () => {
    const http = vi.fn<UnifiHttp>(async () => ok([{ id: "c1", name: "Cam" }]));
    const cams = await listUnifiCameras({ host: "192.168.0.1", apiKey: KEY, http });
    expect(http.mock.calls[0]![0]).toMatchObject({ address: "192.168.0.1", port: 443, method: "GET", path: "/proxy/protect/integration/v1/cameras", apiKey: KEY });
    expect(JSON.stringify(cams)).not.toContain(KEY);
  });
  it("maps failures to plain English without leaking the key", async () => {
    const cases: [UnifiHttp, RegExp, string][] = [
      [async () => ({ status: 401, body: "" }), /API key/, "auth"],
      [async () => ({ status: 404, body: "" }), /Integration API/, "not-supported"],
      [async () => ({ status: 500, body: "" }), /HTTP 500/, "unexpected"],
      [async () => ({ status: 200, body: "{not json" }), /couldn't read/, "unexpected"],
      [async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }, /Couldn't reach/, "unreachable"],
    ];
    for (const [http, re, kind] of cases) {
      const err = await listUnifiCameras({ host: "192.168.0.1", apiKey: KEY, http }).catch((e) => e);
      expect(err).toBeInstanceOf(UnifiProtectError);
      expect(err.message).toMatch(re);
      expect(err.kind).toBe(kind);
      expect(JSON.stringify([err.message, err.diagnostics])).not.toContain(KEY);
    }
  });
  it("rejects a public console host before any request is made", async () => {
    const http = vi.fn<UnifiHttp>();
    await expect(listUnifiCameras({ host: "8.8.8.8", apiKey: KEY, http })).rejects.toThrow(/local-network/);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("stream URLs", () => {
  it("parses per-quality URLs and ignores non-rtsp values", () => {
    expect(parseUnifiStreams({ high: TOKEN_HIGH, medium: null, low: "http://x", package: "rtsps://p" })).toEqual({ high: TOKEN_HIGH });
    expect(parseUnifiStreams(null)).toEqual({});
  });
  it("main is highest quality, sub the next lower", () => {
    expect(pickMainAndSub({ high: "a", low: "c" })).toEqual({ main: "a", sub: "c" });
    expect(pickMainAndSub({ medium: "m" })).toEqual({ main: "m", sub: null });
  });
  it("uses an existing stream (GET) and does not POST (POST can rotate the token)", async () => {
    const http = vi.fn<UnifiHttp>(async () => ok({ high: TOKEN_HIGH, low: TOKEN_LOW }));
    const target = { address: "192.168.0.1", port: 443 };
    const urls = await getUnifiStreamUrls({ target, apiKey: KEY, cameraId: "c1", http });
    expect(urls.high).toBe(TOKEN_HIGH);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("creates streams (POST) when none are enabled", async () => {
    const http = vi.fn<UnifiHttp>(async (r) => (r.method === "GET" ? ok({ high: null }) : ok({ high: TOKEN_HIGH })));
    const urls = await getUnifiStreamUrls({ target: { address: "192.168.0.1", port: 443 }, apiKey: KEY, cameraId: "c1", http });
    expect(urls.high).toBe(TOKEN_HIGH);
    expect(http.mock.calls[1]![0]).toMatchObject({ method: "POST", body: JSON.stringify({ qualities: ["high", "medium", "low"] }) });
  });
  it("rejects a camera id that could alter the request path", async () => {
    await expect(getUnifiStreamUrls({ target: { address: "192.168.0.1", port: 443 }, apiKey: KEY, cameraId: "../x", http: vi.fn() })).rejects.toThrow();
  });
});

describe("commissionUnifiCameras", () => {
  function setup(over: Partial<UnifiCommissionDeps> = {}) {
    const registered: { unifiCameraId: string; mainUrl: string; subUrl: string | null }[] = [];
    const existing = new Map<string, string>();
    const http: UnifiHttp = async (r) => {
      if (r.path.includes("/cameras/bad/")) return { status: 404, body: "" };
      return ok({ high: TOKEN_HIGH, low: TOKEN_LOW });
    };
    const deps: UnifiCommissionDeps = {
      http,
      validateStream: async () => ({ ok: true, checklist: [], reason: null, diagnostics: [], codec: "H264" }),
      findExisting: async (id) => (existing.has(id) ? { deviceId: existing.get(id)! } : null),
      register: async (i) => {
        registered.push(i);
        existing.set(i.unifiCameraId, `dev-${i.unifiCameraId}`);
        return { deviceId: `dev-${i.unifiCameraId}` };
      },
      ...over,
    };
    return { deps, registered };
  }

  it("registers main+sub, one failure does not block the others, and re-commissioning is idempotent", async () => {
    const { deps, registered } = setup();
    const cams = [{ id: "c1", name: "A" }, { id: "bad", name: "B" }, { id: "c3", name: "C" }];
    const first = await commissionUnifiCameras({ host: "192.168.0.1", apiKey: KEY, cameras: cams, deps });
    expect(first.map((r) => r.status)).toEqual(["added", "failed", "added"]);
    expect(registered).toHaveLength(2);
    expect(registered[0]).toMatchObject({ mainUrl: TOKEN_HIGH, subUrl: TOKEN_LOW });
    const second = await commissionUnifiCameras({ host: "192.168.0.1", apiKey: KEY, cameras: cams, deps });
    expect(second.map((r) => r.status)).toEqual(["already-added", "failed", "already-added"]);
    expect(registered).toHaveLength(2); // no duplicates
  });

  it("never puts the API key or the stream token into results/diagnostics/errors", async () => {
    const { deps } = setup({ validateStream: async () => ({ ok: false, checklist: [], reason: "No video.", diagnostics: ["DESCRIBE 404"], codec: null }) });
    const res = await commissionUnifiCameras({ host: "192.168.0.1", apiKey: KEY, cameras: [{ id: "c1", name: "A" }, { id: "bad", name: "B" }], deps });
    const dump = JSON.stringify(res);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("tokHIGH");
    expect(res[0]!.status).toBe("failed");
  });

  it("does not persist the API key: register receives only camera facts", async () => {
    const { deps, registered } = setup();
    await commissionUnifiCameras({ host: "192.168.0.1", apiKey: KEY, cameras: [{ id: "c1", name: "A" }], deps });
    expect(JSON.stringify(registered)).not.toContain(KEY);
  });

  it("refuses a stream URL that points at a public host", async () => {
    const { deps, registered } = setup({ http: async () => ok({ high: "rtsps://8.8.8.8:7441/t" }) });
    const [r] = await commissionUnifiCameras({ host: "192.168.0.1", apiKey: KEY, cameras: [{ id: "c1", name: "A" }], deps });
    expect(r!.status).toBe("failed");
    expect(registered).toHaveLength(0);
  });

  it("rejects a public console host outright", async () => {
    const { deps } = setup();
    await expect(commissionUnifiCameras({ host: "1.1.1.1", apiKey: KEY, cameras: [{ id: "c1", name: "A" }], deps })).rejects.toThrow(/local-network/);
  });
});

describe("realUnifiHttp scoped TLS", () => {
  let dir: string;
  let server: https.Server;
  let port = 0;
  const seenKeys: (string | string[] | undefined)[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "unifi-fixture-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=console"]);
    server = https.createServer({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
      seenKeys.push(req.headers["x-api-key"]);
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/big" ? "x".repeat(5000) : JSON.stringify([{ id: "c1", name: "Cam" }]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("talks to a self-signed console without changing any process-wide TLS setting", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const res = await realUnifiHttp({ address: "127.0.0.1", port, method: "GET", path: "/proxy/protect/integration/v1/cameras", apiKey: KEY, timeoutMs: 3000, maxBytes: 100000 });
    expect(res.status).toBe(200);
    expect(seenKeys.at(-1)).toBe(KEY);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
    expect((https.globalAgent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).not.toBe(false);
    // A default (global-agent) request to the same self-signed server must still be REJECTED.
    await expect(
      new Promise((resolve, reject) => {
        https.get({ host: "127.0.0.1", port, path: "/" }, resolve).on("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("bounds the response size", async () => {
    await expect(realUnifiHttp({ address: "127.0.0.1", port, method: "GET", path: "/big", apiKey: KEY, timeoutMs: 3000, maxBytes: 100 })).rejects.toThrow();
  });
});
