import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetApiError, DevialetIpControlClient, type DevialetEndpoint } from "./devialet-ip-control-client.js";

/**
 * § D3 — Devialet IP Control R1 client tests. Real in-process HTTP server, injected
 * fetch, no mocking framework — matches this repository's existing driver-test
 * convention. Every response fixture below is copied verbatim (or trivially adapted)
 * from the R1 doc's own worked examples, not invented.
 */

function startHttp(handler: (url: string, method: string) => { status?: number; body?: string; contentType?: string }): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const out = handler(req.url ?? "", req.method ?? "GET");
      res.statusCode = out.status ?? 200;
      if (out.body !== undefined || out.status === undefined || out.status === 200) {
        res.setHeader("content-type", out.contentType ?? "application/json");
      }
      res.end(out.body ?? "");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

const CUSTOM_PATH = "/custom-devialet-path/v9";

describe("DevialetIpControlClient", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function withServer(handler: Parameters<typeof startHttp>[0]) {
    const srv = await startHttp(handler);
    servers.push(srv.server);
    const endpoint: DevialetEndpoint = { host: srv.base, path: CUSTOM_PATH };
    return { srv, endpoint };
  }

  it("Z — uses the caller-supplied discovered path, never a hardcoded /ipcontrol/v1", async () => {
    const { srv, endpoint } = await withServer((url) => {
      if (url === `${CUSTOM_PATH}/devices/current`) return { body: JSON.stringify({ deviceId: "d1", model: "Phantom I", release: { version: "2.14.2" }, serial: "P35V1", deviceName: "Kitchen" }) };
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const device = await client.getDevice(endpoint);
    expect(device.deviceId).toBe("d1");
    expect(srv.hits).toEqual([`GET ${CUSTOM_PATH}/devices/current`]);
  });

  it("A — GET /devices/current parses the documented speaker fields", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/devices/current")) {
        return {
          body: JSON.stringify({
            deviceId: "5b35aa24-e4c9-4942-a501-7b0cf5c1e892",
            systemId: "44a53d02-c69f-4a01-a0ce-1b6588b1d5b1",
            groupId: "0e985d77-8212-4b48-842b-9e102d52887e",
            model: "Phantom II 98 dB",
            release: { version: "2.14.2" },
            role: "Mono",
            serial: "P35V12345TQ9A",
            deviceName: "Kitchen",
          }),
        };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const device = await client.getDevice(endpoint);
    expect(device).toMatchObject({
      deviceId: "5b35aa24-e4c9-4942-a501-7b0cf5c1e892",
      systemId: "44a53d02-c69f-4a01-a0ce-1b6588b1d5b1",
      groupId: "0e985d77-8212-4b48-842b-9e102d52887e",
      model: "Phantom II 98 dB",
      release: { version: "2.14.2" },
      role: "Mono",
      serial: "P35V12345TQ9A",
      deviceName: "Kitchen",
    });
  });

  it("A — GET /devices/current for an accessory has no systemId/groupId/role", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/devices/current")) {
        return {
          body: JSON.stringify({
            deviceId: "f42cf307-f5bb-4311-a917-1e06d404f595",
            model: "Arch",
            release: { version: "2.14.2" },
            serial: "P35V12345UX02",
            deviceName: "CD Player",
          }),
        };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const device = await client.getDevice(endpoint);
    expect(device.systemId).toBeUndefined();
    expect(device.groupId).toBeUndefined();
    expect(device.role).toBeUndefined();
  });

  it("B — GET /systems/current parses systemName and availableFeatures", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/systems/current")) {
        return {
          body: JSON.stringify({
            systemId: "13531594-b1c1-42c7-8d5a-18fa9e5d7cd4",
            groupId: "0e985d77-8212-4b48-842b-9e102d52887e",
            systemName: "Dining room",
            availableFeatures: ["equalizer", "nightMode"],
          }),
        };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const system = await client.getSystem(endpoint);
    expect(system.systemName).toBe("Dining room");
    expect(system.availableFeatures).toEqual(["equalizer", "nightMode"]);
  });

  it("C/D — GET /groups/current/sources lists sourceId/deviceId/type per source", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/groups/current/sources")) {
        return {
          body: JSON.stringify({
            sources: [
              { sourceId: "s1", deviceId: "dev1", type: "spotifyconnect" },
              { sourceId: "s2", deviceId: "dev2", type: "opticaljack" },
            ],
          }),
        };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const result = await client.getGroupSources(endpoint);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[1]).toEqual({ sourceId: "s2", deviceId: "dev2", type: "opticaljack" });
  });

  it("E/N/O/P — GET /groups/current/sources/current parses source, metadata (incl. coverArtUrl), and availableOperations", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/groups/current/sources/current")) {
        return {
          body: JSON.stringify({
            source: { sourceId: "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e", deviceId: "13531594-b1c1-42c7-8d5a-18fa9e5d7cd4", type: "spotifyconnect" },
            playingState: "playing",
            muteState: "unmuted",
            metadata: { artist: "Michael Jackson", album: "Thriller", title: "Billie Jean", coverArtUrl: "https://cdn.spotify.com/covers/4729028427.png" },
            availableOperations: ["play", "pause", "seek"],
          }),
        };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const current = await client.getCurrentSource(endpoint);
    expect(current.playingState).toBe("playing");
    expect(current.muteState).toBe("unmuted");
    expect(current.metadata).toEqual({ artist: "Michael Jackson", album: "Thriller", title: "Billie Jean", coverArtUrl: "https://cdn.spotify.com/covers/4729028427.png" });
    expect(current.availableOperations).toEqual(["play", "pause", "seek"]);
  });

  it("E — GET /groups/current/sources/current with no current source has an absent source field", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/groups/current/sources/current")) {
        return { body: JSON.stringify({ playingState: "paused", muteState: "unmuted", availableOperations: [] }) };
      }
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const current = await client.getCurrentSource(endpoint);
    expect(current.source).toBeUndefined();
    expect(current.metadata).toBeUndefined();
  });

  it("F — play POSTs to the SPECIFIC sourceId's play endpoint, never 'current'", async () => {
    const { srv, endpoint } = await withServer(() => ({ body: "{}" }));
    const client = new DevialetIpControlClient();
    await client.play(endpoint, "the-source-id");
    expect(srv.hits).toEqual([`POST ${CUSTOM_PATH}/groups/current/sources/the-source-id/playback/play`]);
  });

  it("G/H/I/J/K — pause/mute/unmute/next/previous POST to the current-source playback endpoints", async () => {
    const { srv, endpoint } = await withServer(() => ({ body: "{}" }));
    const client = new DevialetIpControlClient();
    await client.pause(endpoint);
    await client.mute(endpoint);
    await client.unmute(endpoint);
    await client.next(endpoint);
    await client.previous(endpoint);
    expect(srv.hits).toEqual([
      `POST ${CUSTOM_PATH}/groups/current/sources/current/playback/pause`,
      `POST ${CUSTOM_PATH}/groups/current/sources/current/playback/mute`,
      `POST ${CUSTOM_PATH}/groups/current/sources/current/playback/unmute`,
      `POST ${CUSTOM_PATH}/groups/current/sources/current/playback/next`,
      `POST ${CUSTOM_PATH}/groups/current/sources/current/playback/previous`,
    ]);
  });

  it("L — volume is SYSTEM-level: GET/POST /systems/current/sources/current/soundControl/volume", async () => {
    const { srv, endpoint } = await withServer((url) => {
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return { body: JSON.stringify({ volume: 35 }) };
      return { body: "{}" };
    });
    const client = new DevialetIpControlClient();
    const vol = await client.getVolume(endpoint);
    expect(vol.volume).toBe(35);
    await client.setVolume(endpoint, 60);
    expect(srv.hits).toContain(`POST ${CUSTOM_PATH}/systems/current/sources/current/soundControl/volume`);
    await client.volumeUp(endpoint);
    await client.volumeDown(endpoint);
    expect(srv.hits).toContain(`POST ${CUSTOM_PATH}/systems/current/sources/current/soundControl/volumeUp`);
    expect(srv.hits).toContain(`POST ${CUSTOM_PATH}/systems/current/sources/current/soundControl/volumeDown`);
  });

  it("M — playback position has an undocumented shape: raw JSON is returned, not a fabricated typed model", async () => {
    const { endpoint } = await withServer((url) => {
      if (url.endsWith("/playback/position")) return { body: JSON.stringify({ somethingUndocumented: 42 }) };
      return { status: 404 };
    });
    const client = new DevialetIpControlClient();
    const position = await client.getPlaybackPosition(endpoint);
    expect(position).toEqual({ somethingUndocumented: 42 });
  });

  it("Q — HTTP 400 (malformed request) surfaces as a typed http error with an empty body", async () => {
    const { endpoint } = await withServer(() => ({ status: 400, body: "" }));
    const client = new DevialetIpControlClient();
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("http");
    expect((err as DevialetApiError).httpStatus).toBe(400);
  });

  it("R — HTTP 404 (non-existing endpoint) surfaces as a typed http error", async () => {
    const { endpoint } = await withServer(() => ({ status: 404, body: "" }));
    const client = new DevialetIpControlClient();
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("http");
    expect((err as DevialetApiError).httpStatus).toBe(404);
  });

  it("S — HTTP 415 (bad/missing Content-Type on POST) surfaces as a typed http error", async () => {
    const { endpoint } = await withServer(() => ({ status: 415, body: "" }));
    const client = new DevialetIpControlClient();
    const err = await client.pause(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("http");
    expect((err as DevialetApiError).httpStatus).toBe(415);
  });

  it("T — HTTP 500 surfaces as a typed http error and best-effort parses an error body if present", async () => {
    const { endpoint } = await withServer(() => ({ status: 500, body: JSON.stringify({ error: { code: "Error" } }) }));
    const client = new DevialetIpControlClient();
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("http");
    expect((err as DevialetApiError).httpStatus).toBe(500);
    expect((err as DevialetApiError).logical?.code).toBe("Error");
  });

  it("U — malformed JSON on an otherwise-200 response surfaces as a typed transport error", async () => {
    const { endpoint } = await withServer(() => ({ status: 200, body: "{not valid json" }));
    const client = new DevialetIpControlClient();
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("transport");
  });

  it("V — network failure (connection refused) surfaces as a typed transport error", async () => {
    const client = new DevialetIpControlClient();
    const endpoint: DevialetEndpoint = { host: "http://127.0.0.1:1", path: CUSTOM_PATH };
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("transport");
  });

  it("W/core-rule — HTTP 200 + a logical error body does NOT become a successful result", async () => {
    const { endpoint } = await withServer(() => ({ status: 200, body: JSON.stringify({ error: { code: "NoCurrentSource" } }) }));
    const client = new DevialetIpControlClient();
    await expect(client.getCurrentSource(endpoint)).rejects.toMatchObject({ kind: "logical", logical: { code: "NoCurrentSource" } });
  });

  it("X — an unrecognized logical error code is still representable, never crashes the client", async () => {
    const { endpoint } = await withServer(() => ({ status: 200, body: JSON.stringify({ error: { code: "SomeFutureFirmwareErrorCodeNotYetDocumented" } }) }));
    const client = new DevialetIpControlClient();
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).logical?.code).toBe("SomeFutureFirmwareErrorCodeNotYetDocumented");
  });

  it("Y — a request exceeding timeoutMs fails deterministically (kind: transport, timedOut: true) against a server that never responds", async () => {
    const hangingServer = createServer(() => {
      // Deliberately never call res.end() — the request hangs until our own
      // AbortController timeout fires.
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    servers.push(hangingServer);
    const addr = hangingServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new DevialetIpControlClient({ timeoutMs: 50 });
    const endpoint: DevialetEndpoint = { host: `http://127.0.0.1:${port}`, path: CUSTOM_PATH };
    const err = await client.getDevice(endpoint).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("transport");
    expect((err as DevialetApiError).timedOut).toBe(true);
  });

  it("known error codes list preserves the doc's own singular/plural inconsistency verbatim", async () => {
    const { KNOWN_DEVIALET_ERROR_CODES } = await import("./devialet-ip-control-client.js");
    expect(KNOWN_DEVIALET_ERROR_CODES).toContain("UnreachableDevices");
    expect(KNOWN_DEVIALET_ERROR_CODES).toContain("UnreachableDevice");
  });
});
