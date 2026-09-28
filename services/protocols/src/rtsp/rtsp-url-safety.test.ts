import { describe, it, expect } from "vitest";
import { validateRtspUrl } from "./rtsp-url-safety.js";

describe("validateRtspUrl — § STEP 11 SSRF guard", () => {
  it("accepts a private-LAN rtsp:// URL", () => {
    const r = validateRtspUrl("rtsp://192.168.1.50:554/Streaming/Channels/101");
    expect(r.ok).toBe(true);
    expect(r.host).toBe("192.168.1.50");
    expect(r.port).toBe(554);
  });
  it("defaults to port 554 when none is given", () => {
    expect(validateRtspUrl("rtsp://10.0.0.5/stream").port).toBe(554);
  });
  it("rejects a non-rtsp scheme (SSRF via http/file)", () => {
    expect(validateRtspUrl("http://192.168.1.50/").ok).toBe(false);
    expect(validateRtspUrl("file:///etc/passwd").ok).toBe(false);
  });
  it("rejects a public-internet IPv4 host", () => {
    const r = validateRtspUrl("rtsp://8.8.8.8/stream");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/local-network/i);
  });
  it("rejects malformed URLs without throwing", () => {
    expect(() => validateRtspUrl("not a url")).not.toThrow();
    expect(validateRtspUrl("not a url").ok).toBe(false);
  });
  it("accepts a local hostname (mDNS-resolvable)", () => {
    expect(validateRtspUrl("rtsp://camera.local:554/stream").ok).toBe(true);
  });
  it("rejects IPv6 as not yet supported (honest gap, not a silent bypass)", () => {
    expect(validateRtspUrl("rtsp://[::1]/stream").ok).toBe(false);
  });
});
