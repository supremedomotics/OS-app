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

  it("testConnection resolves true on any HTTP response, without ever calling the write endpoint", async () => {
    const calledPaths: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calledPaths.push(url);
      return new Response("not found", { status: 404 });
    });
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 8080, fetchImpl });
    expect(await client.testConnection()).toBe(true);
    expect(calledPaths).toEqual(["http://192.168.1.50:8080"]);
  });

  it("testConnection resolves false on a network failure", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80, fetchImpl });
    expect(await client.testConnection()).toBe(false);
  });

  it("fetchNetwork and fetchState honestly reject — no such endpoint is documented", async () => {
    const client = new CasambiLocalRestClient({ gatewayIp: "192.168.1.50", restPort: 80 });
    await expect(client.fetchNetwork()).rejects.toThrow(CasambiLocalRestNotImplementedError);
    await expect(client.fetchState()).rejects.toThrow(CasambiLocalRestNotImplementedError);
  });
});
