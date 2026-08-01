import { describe, expect, it, vi } from "vitest";
import { CasambiLocalRestClient, CasambiLocalRestNotImplementedError } from "./rest-client.js";
import { CASAMBI_TARGET_TYPE } from "./udp-codec.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((input: string | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as unknown as typeof fetch;
}

describe("CasambiLocalRestClient", () => {
  it("setTargetValue builds the documented GET /set/target_value URL", async () => {
    let capturedUrl = "";
    const fetchImpl = fakeFetch((url) => {
      capturedUrl = url;
      return new Response("ok");
    });
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 8080, fetchImpl });
    const result = await client.setTargetValue({ targetType: CASAMBI_TARGET_TYPE.device, targetId: 2, durationMs: 10, value: 80 });
    // p.358 example call: /set/target_value?type=1&id=2&duration=10&value=80
    expect(capturedUrl).toBe("http://192.168.1.50:8080/set/target_value?type=1&id=2&duration=10&value=80");
    expect(result).toBe("ok");
  });

  it("setTargetValue treats any non-'ok' body as an error, never throwing on a documented failure response", async () => {
    const fetchImpl = fakeFetch(() => new Response("error"));
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, fetchImpl });
    const result = await client.setTargetValue({ targetType: CASAMBI_TARGET_TYPE.device, targetId: 2, value: 80 });
    expect(result).toBe("error");
  });

  it("setTargetValue omits the duration param when no fade is given", async () => {
    let capturedUrl = "";
    const fetchImpl = fakeFetch((url) => {
      capturedUrl = url;
      return new Response("ok");
    });
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, fetchImpl });
    await client.setTargetValue({ targetType: CASAMBI_TARGET_TYPE.broadcast, targetId: 0, value: 0 });
    expect(capturedUrl).not.toContain("duration");
  });

  it("testConnection resolves reachable:true on any HTTP response, without ever calling the write endpoint", async () => {
    const calledPaths: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calledPaths.push(url);
      return new Response("not found", { status: 404 });
    });
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 8080, fetchImpl });
    expect(await client.testConnection()).toEqual({ reachable: true, httpStatus: 404, authFailed: false });
    expect(calledPaths).toEqual(["http://192.168.1.50:8080"]);
  });

  it("testConnection resolves reachable:false, authFailed:null on a network failure", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, fetchImpl });
    expect(await client.testConnection()).toEqual({ reachable: false, httpStatus: null, authFailed: null });
  });

  it("fetchNetwork and fetchState honestly reject — no such endpoint is documented", async () => {
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80 });
    await expect(client.fetchNetwork()).rejects.toThrow(CasambiLocalRestNotImplementedError);
    await expect(client.fetchState()).rejects.toThrow(CasambiLocalRestNotImplementedError);
  });

  describe("Gateway authentication (§ Casambi Local Gateway Auth)", () => {
    it("sends no Authorization header when no gateway credentials are configured", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      const fetchImpl = fakeFetch((_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response("ok");
      });
      const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, fetchImpl });
      await client.testConnection();
      expect(capturedHeaders?.Authorization).toBeUndefined();
    });

    it("sends HTTP Basic Auth built from Gateway Username/Password on every request", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      const fetchImpl = fakeFetch((_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response("ok");
      });
      const client = new CasambiLocalRestClient({
        gatewayIp: "192.168.1.50",
        restPort: 80,
        gatewayUsername: "admin",
        gatewayPassword: "secret",
        fetchImpl,
      });
      await client.testConnection();
      expect(capturedHeaders?.Authorization).toBe(`Basic ${Buffer.from("admin:secret").toString("base64")}`);

      await client.setTargetValue({ targetType: CASAMBI_TARGET_TYPE.device, targetId: 1, value: 100 });
      expect(capturedHeaders?.Authorization).toBe(`Basic ${Buffer.from("admin:secret").toString("base64")}`);
    });

    it("testConnection reports authFailed:true on a 401, without treating it as unreachable", async () => {
      const fetchImpl = fakeFetch(() => new Response("Unauthorized", { status: 401 }));
      const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, gatewayUsername: "admin", gatewayPassword: "wrong", fetchImpl });
      expect(await client.testConnection()).toEqual({ reachable: true, httpStatus: 401, authFailed: true });
    });

    it("testConnection reports authFailed:false when the gateway accepts the credentials", async () => {
      const fetchImpl = fakeFetch(() => new Response("ok", { status: 200 }));
      const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, gatewayUsername: "admin", gatewayPassword: "right", fetchImpl });
      expect(await client.testConnection()).toEqual({ reachable: true, httpStatus: 200, authFailed: false });
    });

    it("setTargetValue returns 'unauthorized' on a 401/403 instead of misreporting it as 'error'", async () => {
      const fetchImpl = fakeFetch(() => new Response("Forbidden", { status: 403 }));
      const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, gatewayUsername: "admin", gatewayPassword: "wrong", fetchImpl });
      const result = await client.setTargetValue({ targetType: CASAMBI_TARGET_TYPE.device, targetId: 1, value: 100 });
      expect(result).toBe("unauthorized");
    });
  });
});
