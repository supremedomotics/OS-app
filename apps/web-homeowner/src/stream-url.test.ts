import { describe, expect, it } from "vitest";
import { toSameOriginStreamUrl } from "./stream-url.js";

const origin = "https://192.168.0.105";

describe("toSameOriginStreamUrl", () => {
  it("rebases a localhost /stream/ URL onto the page origin, keeping path and query", () => {
    expect(toSameOriginStreamUrl("https://localhost/stream/api/webrtc?src=dev_1", origin)).toBe(
      "https://192.168.0.105/stream/api/webrtc?src=dev_1",
    );
  });
  it("leaves a URL already on the page origin untouched", () => {
    const u = "https://192.168.0.105/stream/api/stream.m3u8?src=dev_1";
    expect(toSameOriginStreamUrl(u, origin)).toBe(u);
  });
  it("leaves a non-/stream/ URL (e.g. an external streamer) untouched", () => {
    const u = "https://cdn.example.com/hls/dev_1/index.m3u8";
    expect(toSameOriginStreamUrl(u, origin)).toBe(u);
  });
  it("returns an unparseable value unchanged", () => {
    expect(toSameOriginStreamUrl("not a url", origin)).toBe("not a url");
  });
});
