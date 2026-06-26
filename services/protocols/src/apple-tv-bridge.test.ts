import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppleTvProtocolDriver } from "./apple-tv-driver.js";
import { createAppleTvConnect } from "./apple-tv-bridge.js";

/** An in-process stand-in for the Python appletv-py bridge. */
function startBridge(): Promise<{ server: Server; base: string; calls: string[]; state: Record<string, unknown> }> {
  const calls: string[] = [];
  const np: Record<string, unknown> = {
    state: "paused",
    app: "Netflix",
    title: "The Crown",
    artist: "S5 · E3",
    artwork_url: null,
    has_artwork: true,
    volume: 40,
    muted: false,
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        calls.push(`${req.method} ${req.url}`);
        res.setHeader("content-type", "application/json");
        if (req.url === "/connect") {
          res.end(JSON.stringify({ connected: true }));
        } else if (req.url?.endsWith("/command")) {
          const action = payload.action as string;
          if (action === "play") np.state = "playing";
          if (action === "volume") np.volume = payload.volume;
          if (action === "mute") np.muted = true;
          if (action === "unmute") np.muted = false;
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url?.endsWith("/now_playing")) {
          res.end(JSON.stringify(np));
        } else if (req.url?.endsWith("/artwork")) {
          res.setHeader("content-type", "image/png");
          res.end(png);
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ detail: "not found" }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, calls, state: np });
    });
  });
}

describe("Apple TV bridge client → driver (end-to-end over HTTP)", () => {
  let srv: Awaited<ReturnType<typeof startBridge>>;
  let driver: AppleTvProtocolDriver;
  const dev = "device-appletv" as DeviceId;

  beforeAll(async () => {
    srv = await startBridge();
    driver = new AppleTvProtocolDriver({
      pollMs: 1_000_000,
      connect: createAppleTvConnect({ baseUrl: srv.base }),
      artworkUrlFor: (id) => `https://home.example/v1/devices/${id}/media/artwork`,
    });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.42" });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => srv.server.close(() => r()));
  });

  it("opens a control session on bind", () => {
    expect(srv.calls).toContain("POST /connect");
  });

  it("maps Supreme media commands to bridge endpoints and reads now-playing", async () => {
    await driver.command(dev, { capability: "media", action: "play" });
    await driver.command(dev, { capability: "media", action: "volume", volume: 65 });
    await driver.command(dev, { capability: "media", action: "mute" });

    expect(srv.calls).toContain("POST /devices/10.0.0.42/command");
    const s = driver.getState(dev, "media") as { playback: string; volume: number; muted: boolean; source: string; title: string };
    expect(s.playback).toBe("playing");
    expect(s.volume).toBe(65);
    expect(s.muted).toBe(true);
    expect(s.source).toBe("Netflix"); // foreground app
    expect(s.title).toBe("The Crown"); // its content
  });

  it("advertises the gateway artwork URL and fetches cover-art bytes", async () => {
    const s = driver.getState(dev, "media") as { artworkUrl: string | null };
    expect(s.artworkUrl).toBe(`https://home.example/v1/devices/${dev}/media/artwork`);
    const art = await driver.getArtwork(dev);
    expect(art?.contentType).toBe("image/png");
    expect((art?.data.byteLength ?? 0) > 0).toBe(true);
  });

  it("surfaces bridge errors with their detail message", async () => {
    const connect = createAppleTvConnect({ baseUrl: `${srv.base}/nope` });
    await expect(connect("1.2.3.4")).rejects.toThrow(/appletv-bridge/);
  });
});
