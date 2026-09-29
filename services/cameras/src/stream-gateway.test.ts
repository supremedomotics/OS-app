import { describe, expect, it, vi } from "vitest";
import { StreamGateway, playableUrls, withoutEnableSrtp } from "./stream-gateway.js";

describe("playableUrls", () => {
  it("derives go2rtc HLS + WebRTC URLs", () => {
    expect(playableUrls("go2rtc", "https://hub.local/stream/", "front")).toEqual([
      { kind: "hls", url: "https://hub.local/stream/api/stream.m3u8?src=front" },
      { kind: "webrtc", url: "https://hub.local/stream/api/webrtc?src=front" },
    ]);
  });
  it("derives MediaMTX HLS + WHEP URLs", () => {
    expect(playableUrls("mediamtx", "https://hub.local/stream", "front")).toEqual([
      { kind: "hls", url: "https://hub.local/stream/front/index.m3u8" },
      { kind: "webrtc", url: "https://hub.local/stream/front/whep" },
    ]);
  });
});

describe("StreamGateway", () => {
  it("publishes playable streams plus the rtsp source, and registers with the engine", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const gw = new StreamGateway({
      engine: "go2rtc",
      baseUrl: "https://hub.local/stream",
      apiUrl: "http://go2rtc:1984",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const streams = await gw.publish("cam-1", "rtsp://10.0.0.5/h264");
    expect(streams.map((s) => s.kind)).toEqual(["hls", "webrtc", "rtsp"]);
    expect(streams.find((s) => s.kind === "rtsp")?.url).toBe("rtsp://10.0.0.5/h264");
    // Source was registered with the go2rtc admin API.
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/api/streams?name=cam-1&src=rtsp%3A%2F%2F10.0.0.5%2Fh264");
    expect((opts as RequestInit).method).toBe("PUT");
  });

  it("still returns URLs when registration fails (advisory)", async () => {
    const gw = new StreamGateway({
      baseUrl: "https://hub.local/stream",
      apiUrl: "http://go2rtc:1984",
      fetchImpl: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    const streams = await gw.publish("cam-2", "rtsp://x/y");
    expect(streams.some((s) => s.kind === "hls")).toBe(true);
  });
});

describe("withoutEnableSrtp", () => {
  it("removes only the enableSrtp parameter", () => {
    expect(withoutEnableSrtp("rtsps://192.168.0.1:7441/TOKEN?enableSrtp")).toBe("rtsps://192.168.0.1:7441/TOKEN");
    expect(withoutEnableSrtp("rtsps://h:7441/TOKEN?enableSrtp&other=1")).toBe("rtsps://h:7441/TOKEN?other=1");
  });
  it("leaves URLs without it, and unparseable input, unchanged", () => {
    expect(withoutEnableSrtp("rtsp://10.0.0.5:554/stream1")).toBe("rtsp://10.0.0.5:554/stream1");
    expect(withoutEnableSrtp("not a url")).toBe("not a url");
  });
  it("registers the source with go2rtc without enableSrtp", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const gw = new StreamGateway({ engine: "go2rtc", baseUrl: "https://hub.local/stream", apiUrl: "http://127.0.0.1:1984", fetchImpl: fetchImpl as unknown as typeof fetch });
    await gw.publish("cam-3", "rtsps://192.168.0.1:7441/TOKEN?enableSrtp");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("src=rtsps%3A%2F%2F192.168.0.1%3A7441%2FTOKEN");
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain("enableSrtp");
  });
});
