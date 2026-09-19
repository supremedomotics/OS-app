import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevialetCiSettingsClient,
  DevialetCiSettingsError,
  classifyOpcode,
  type DevialetCiSettingsEndpoint,
} from "./devialet-cisettings-client.js";

/**
 * § D4 — Devialet CISettings client tests. Real in-process HTTP server, injected
 * fetch, no mocking framework. Response fixtures follow the doc's own worked
 * examples (`{"data":{"serialnumber":"K24A00025ZE1V"}}`, POST `{"volume":27}`)
 * exactly, extended consistently for opcodes the doc names but doesn't show a full
 * worked example for (flagged inline where that's the case).
 */

function startHttp(handler: (url: string, method: string, body: string) => { status?: number; body?: string }): Promise<{ server: Server; base: string; hits: { url: string; method: string; body: string }[] }> {
  const hits: { url: string; method: string; body: string }[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        hits.push({ url: req.url ?? "", method: req.method ?? "GET", body });
        const out = handler(req.url ?? "", req.method ?? "GET", body);
        res.statusCode = out.status ?? 200;
        res.setHeader("content-type", "application/json");
        res.end(out.body ?? "");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

describe("DevialetCiSettingsClient", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function withServer(handler: Parameters<typeof startHttp>[0]) {
    const srv = await startHttp(handler);
    servers.push(srv.server);
    const endpoint: DevialetCiSettingsEndpoint = { host: srv.base };
    return { srv, endpoint };
  }

  it("A — GET /cisettings/serialnumber matches the doc's own worked example verbatim", async () => {
    const { srv, endpoint } = await withServer((url) => {
      if (url === "/cisettings/serialnumber") return { body: JSON.stringify({ data: { serialnumber: "K24A00025ZE1V" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const serial = await client.getSerialNumber(endpoint);
    expect(serial).toBe("K24A00025ZE1V");
    expect(srv.hits[0]).toMatchObject({ method: "GET", url: "/cisettings/serialnumber" });
  });

  it("B — GET /cisettings/volume returns the current numeric volume", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/volume") return { body: JSON.stringify({ data: { volume: 27 } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    expect(await client.getVolume(endpoint)).toBe(27);
  });

  it("C — POST /cisettings/volume matches the doc's own worked example verbatim, with Content-Type application/json", async () => {
    const { srv, endpoint } = await withServer(() => ({ body: "{}" }));
    const client = new DevialetCiSettingsClient();
    await client.setVolume(endpoint, 27);
    expect(srv.hits[0]!.method).toBe("POST");
    expect(srv.hits[0]!.url).toBe("/cisettings/volume");
    expect(JSON.parse(srv.hits[0]!.body)).toEqual({ volume: 27 });
  });

  it("N — every POST carries Content-Type: application/json", async () => {
    let contentType: string | undefined;
    const srv = await startHttp((_url, _method) => ({ body: "{}" }));
    servers.push(srv.server);
    srv.server.on("request", (req) => {
      contentType = req.headers["content-type"];
    });
    const client = new DevialetCiSettingsClient();
    await client.setPower({ host: srv.base }, true);
    expect(contentType).toBe("application/json");
  });

  it("D — getAll() returns the raw, dynamic status object (protocol boundary only, not normalized)", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/getall") return { body: JSON.stringify({ data: { volume: 10, mutemode: "OFF", friendlyname: "Reactor Room 17" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const all = await client.getAll(endpoint);
    expect(all).toEqual({ volume: 10, mutemode: "OFF", friendlyname: "Reactor Room 17" });
  });

  it("E — getLean() returns the documented {powerstate, mutemode, volume, source} shape", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/getlean") return { body: JSON.stringify({ data: { powerstate: "running", mutemode: "OFF", volume: 42, source: "Analog" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const lean = await client.getLean(endpoint);
    expect(lean).toEqual({ powerstate: "running", mutemode: "OFF", volume: 42, source: "Analog" });
  });

  it("E — getLean() rejects a response that doesn't match the documented 4-field shape", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/getlean") return { body: JSON.stringify({ data: { powerstate: "running" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const err = await client.getLean(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("malformed");
  });

  it("F — documented parameter parsing: powerstate/currentsourcestate/currentstreamtype/ledmode", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/powerstate") return { body: JSON.stringify({ data: { powerstate: "running" } }) };
      if (url === "/cisettings/currentsourcestate") return { body: JSON.stringify({ data: { currentsourcestate: "Locked" } }) };
      if (url === "/cisettings/currentstreamtype") return { body: JSON.stringify({ data: { currentstreamtype: "NOTPCM" } }) };
      if (url === "/cisettings/ledmode") return { body: JSON.stringify({ data: { ledmode: 2 } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    expect(await client.getPowerState(endpoint)).toBe("running");
    expect(await client.getCurrentSourceState(endpoint)).toBe("Locked");
    expect(await client.getCurrentStreamType(endpoint)).toBe("NOTPCM");
    expect(await client.getLedMode(endpoint)).toBe(2);
  });

  it("F — rejects an undocumented enum value rather than passing it through silently", async () => {
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/powerstate") return { body: JSON.stringify({ data: { powerstate: "rebooting-into-dfu-mode" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const err = await client.getPowerState(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("malformed");
  });

  it("G — an unavailable opcode (e.g. nightmode) is structurally refused — no request is ever sent", async () => {
    const srv = await startHttp(() => ({ body: JSON.stringify({ data: { nightmode: "ON" } }) }));
    servers.push(srv.server);
    const client = new DevialetCiSettingsClient();
    const err = await client.getRaw({ host: srv.base }, "nightmode").catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("unavailable");
    expect(srv.hits).toEqual([]);
  });

  it("G — every documented-unavailable opcode classifies as unavailable", () => {
    for (const opcode of ["basslevel", "treblelevel", "tonecontrolmode", "balancelevel", "icmode", "subsonicmode", "nightmode", "nightlevel", "delay", "eqmode", "eq"]) {
      expect(classifyOpcode(opcode)).toBe("unavailable");
    }
  });

  it("H — an opcode absent from the documentation entirely classifies as unknown, and a GET for it is still attempted", async () => {
    expect(classifyOpcode("someFutureOpcodeNotInThisDoc")).toBe("unknown");
    const { endpoint } = await withServer((url) => {
      if (url === "/cisettings/somefutureopcodenotinthisdoc") return { body: JSON.stringify({ data: { somefutureopcodenotinthisdoc: "x" } }) };
      return { status: 404 };
    });
    const client = new DevialetCiSettingsClient();
    const value = await client.getRaw(endpoint, "somefutureopcodenotinthisdoc");
    expect(value).toBe("x");
  });

  it("I — capability classification distinguishes documented from unavailable from unknown", () => {
    expect(classifyOpcode("serialnumber")).toBe("documented");
    expect(classifyOpcode("volume")).toBe("documented");
    expect(classifyOpcode("nightmode")).toBe("unavailable");
    expect(classifyOpcode("totally-made-up")).toBe("unknown");
  });

  it("J — HTTP failure (e.g. 500) surfaces as a typed http error", async () => {
    const { endpoint } = await withServer(() => ({ status: 500, body: "" }));
    const client = new DevialetCiSettingsClient();
    const err = await client.getSerialNumber(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("http");
    expect((err as DevialetCiSettingsError).httpStatus).toBe(500);
  });

  it("K — malformed JSON surfaces as a typed malformed error", async () => {
    const { endpoint } = await withServer(() => ({ status: 200, body: "{not json" }));
    const client = new DevialetCiSettingsClient();
    const err = await client.getSerialNumber(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("malformed");
  });

  it("K — a 200 response missing the documented {data:{...}} envelope surfaces as malformed", async () => {
    const { endpoint } = await withServer(() => ({ status: 200, body: JSON.stringify({ serialnumber: "no-envelope" }) }));
    const client = new DevialetCiSettingsClient();
    const err = await client.getSerialNumber(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("malformed");
  });

  it("L — network failure (connection refused) surfaces as a typed transport error", async () => {
    const client = new DevialetCiSettingsClient();
    const err = await client.getSerialNumber({ host: "http://127.0.0.1:1" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("transport");
  });

  it("M — a request exceeding timeoutMs fails deterministically (kind: transport, timedOut: true)", async () => {
    const hangingServer = createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    servers.push(hangingServer);
    const addr = hangingServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new DevialetCiSettingsClient({ timeoutMs: 50 });
    const err = await client.getSerialNumber({ host: `http://127.0.0.1:${port}` }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("transport");
    expect((err as DevialetCiSettingsError).timedOut).toBe(true);
  });

  it("O — the CISettings doc defines no logical-error envelope; an unexpected shape is treated as malformed, never fabricated as success", async () => {
    // Unlike R1's {error:{code,...}}, nothing in the CISettings doc describes an
    // in-band error object — a response that isn't the documented {data:{...}} shape
    // is therefore just malformed, not a distinct "logical error" kind.
    const { endpoint } = await withServer(() => ({ status: 200, body: JSON.stringify({ data: null }) }));
    const client = new DevialetCiSettingsClient();
    const err = await client.getSerialNumber(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCiSettingsError);
    expect((err as DevialetCiSettingsError).kind).toBe("malformed");
  });

  it("P — diagnostics counting is the caller's responsibility (protocol-only client) — proven by exactly one real HTTP request per call", async () => {
    const { srv, endpoint } = await withServer(() => ({ body: JSON.stringify({ data: { serialnumber: "S1" } }) }));
    const client = new DevialetCiSettingsClient();
    await client.getSerialNumber(endpoint);
    await client.getSerialNumber(endpoint);
    expect(srv.hits.length).toBe(2);
  });

  it("Q — this client makes no tracing/diagnostics calls of its own (verified by absence — see devialet-driver.test.ts for the driver-level integration)", () => {
    const client = new DevialetCiSettingsClient();
    expect(typeof (client as unknown as { tracer?: unknown }).tracer).toBe("undefined");
  });

  it("R — two different Devialet hosts never cross-contaminate a single client instance's calls", async () => {
    const srvA = await withServer(() => ({ body: JSON.stringify({ data: { serialnumber: "SERIAL-A" } }) }));
    const srvB = await withServer(() => ({ body: JSON.stringify({ data: { serialnumber: "SERIAL-B" } }) }));
    const client = new DevialetCiSettingsClient();
    expect(await client.getSerialNumber(srvA.endpoint)).toBe("SERIAL-A");
    expect(await client.getSerialNumber(srvB.endpoint)).toBe("SERIAL-B");
  });

  it("S — two separate client instances are fully isolated (no shared state)", async () => {
    const { endpoint } = await withServer(() => ({ body: JSON.stringify({ data: { serialnumber: "ISOLATED" } }) }));
    const client1 = new DevialetCiSettingsClient();
    const client2 = new DevialetCiSettingsClient();
    expect(await client1.getSerialNumber(endpoint)).toBe("ISOLATED");
    expect(await client2.getSerialNumber(endpoint)).toBe("ISOLATED");
  });

  it("power is write-only per the doc — setPower() sends ON/OFF, and there is no getPower() method", async () => {
    const { srv, endpoint } = await withServer(() => ({ body: "{}" }));
    const client = new DevialetCiSettingsClient();
    await client.setPower(endpoint, true);
    await client.setPower(endpoint, false);
    expect(JSON.parse(srv.hits[0]!.body)).toEqual({ power: "ON" });
    expect(JSON.parse(srv.hits[1]!.body)).toEqual({ power: "OFF" });
    expect((client as unknown as { getPower?: unknown }).getPower).toBeUndefined();
  });

  it("mutemode GET is parsed leniently across the documented ON/OFF/1/0 write-side grammar", async () => {
    const cases: [unknown, boolean][] = [
      ["ON", true],
      ["OFF", false],
      [1, true],
      [0, false],
      [true, true],
      [false, false],
    ];
    for (const [raw, expected] of cases) {
      const { endpoint } = await withServer((url) => {
        if (url === "/cisettings/mutemode") return { body: JSON.stringify({ data: { mutemode: raw } }) };
        return { status: 404 };
      });
      const client = new DevialetCiSettingsClient();
      expect(await client.getMuteMode(endpoint)).toBe(expected);
    }
  });
});
