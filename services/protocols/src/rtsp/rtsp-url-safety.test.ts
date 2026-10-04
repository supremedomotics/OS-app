import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns";
import { validateRtspUrl, validateOnvifEndpointUrl } from "./rtsp-url-safety.js";

describe("validateRtspUrl — § STEP 11 SSRF guard", () => {
  it("accepts a private-LAN rtsp:// URL", async () => {
    const r = await validateRtspUrl("rtsp://192.168.1.50:554/Streaming/Channels/101");
    expect(r.ok).toBe(true);
    expect(r.host).toBe("192.168.1.50");
    expect(r.port).toBe(554);
    expect(r.resolvedAddress).toBe("192.168.1.50");
  });
  it("defaults to port 554 when none is given", async () => {
    expect((await validateRtspUrl("rtsp://10.0.0.5/stream")).port).toBe(554);
  });
  it("rejects a non-rtsp scheme (SSRF via http/file)", async () => {
    expect((await validateRtspUrl("http://192.168.1.50/")).ok).toBe(false);
    expect((await validateRtspUrl("file:///etc/passwd")).ok).toBe(false);
  });
  it("rejects a public-internet IPv4 host", async () => {
    const r = await validateRtspUrl("rtsp://8.8.8.8/stream");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/local-network/i);
  });
  it("rejects malformed URLs without throwing", async () => {
    await expect(validateRtspUrl("not a url")).resolves.not.toThrow();
    expect((await validateRtspUrl("not a url")).ok).toBe(false);
  });
  it("rejects IPv6 as not yet supported (honest gap, not a silent bypass)", async () => {
    expect((await validateRtspUrl("rtsp://[::1]/stream")).ok).toBe(false);
  });

  describe("§ TLS transport — rtsps:// scheme", () => {
    it("accepts a private-LAN rtsps:// URL the same way rtsp:// is accepted, now that real TLS transport exists", async () => {
      const r = await validateRtspUrl("rtsps://192.168.1.50:322/stream");
      expect(r.ok).toBe(true);
      expect(r.host).toBe("192.168.1.50");
      expect(r.port).toBe(322);
      expect(r.resolvedAddress).toBe("192.168.1.50");
    });
    it("applies the same public-internet SSRF rejection to rtsps://", async () => {
      const r = await validateRtspUrl("rtsps://8.8.8.8/stream");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/local-network/i);
    });
    it("still rejects other non-rtsp(s) schemes (SSRF via http/file)", async () => {
      expect((await validateRtspUrl("http://192.168.1.50/")).ok).toBe(false);
      expect((await validateRtspUrl("file:///etc/passwd")).ok).toBe(false);
    });
  });

  describe("§ FINDING 1 — DNS resolution for manual hostnames (SSRF via DNS)", () => {
    let lookupSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      lookupSpy = vi.spyOn(dns.promises, "lookup");
    });
    afterEach(() => {
      lookupSpy.mockRestore();
    });

    it("accepts a hostname that resolves to a private LAN address", async () => {
      lookupSpy.mockResolvedValue({ address: "192.168.1.77", family: 4 } as any);
      const r = await validateRtspUrl("rtsp://camera.local:554/stream");
      expect(r.ok).toBe(true);
      expect(r.resolvedAddress).toBe("192.168.1.77");
    });

    it("rejects a hostname that resolves to a public/non-private IP (SSRF bypass attempt)", async () => {
      lookupSpy.mockResolvedValue({ address: "8.8.8.8", family: 4 } as any);
      const r = await validateRtspUrl("rtsp://attacker.example:554/stream");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/local-network/i);
      expect(r.resolvedAddress).toBe("8.8.8.8");
    });

    it("rejects a hostname that fails to resolve, rather than silently letting it through", async () => {
      lookupSpy.mockRejectedValue(new Error("ENOTFOUND"));
      const r = await validateRtspUrl("rtsp://nonexistent.invalid:554/stream");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/resolved/i);
    });
  });
});

describe("validateOnvifEndpointUrl — § FINDING 3 SSRF guard on ONVIF endpoints", () => {
  it("accepts a private-LAN http:// ONVIF endpoint", async () => {
    const r = await validateOnvifEndpointUrl("http://192.168.1.60/onvif/device_service");
    expect(r.ok).toBe(true);
  });
  it("rejects a public-internet ONVIF endpoint", async () => {
    const r = await validateOnvifEndpointUrl("http://8.8.8.8/onvif/device_service");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/local-network/i);
  });
  it("rejects a non-http(s) scheme", async () => {
    expect((await validateOnvifEndpointUrl("file:///etc/passwd")).ok).toBe(false);
  });

  it("rejects an ONVIF hostname resolving to a public IP", async () => {
    const lookupSpy = vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "1.2.3.4", family: 4 } as any);
    try {
      const r = await validateOnvifEndpointUrl("http://attacker.example/onvif/device_service");
      expect(r.ok).toBe(false);
    } finally {
      lookupSpy.mockRestore();
    }
  });
});
