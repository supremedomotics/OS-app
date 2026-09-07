import { describe, expect, it, vi } from "vitest";
import { HttpCasambiTransport } from "./cloud-transport.js";

const creds = { apiKey: "test-key", email: "admin@example.com", password: "pw" };

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("HttpCasambiTransport.createSession (§ live-confirmed fix — real Casambi REST shape)", () => {
  it("posts to /v1/networks/session with NO networkId in the path when none is given", async () => {
    const fetchImpl = fakeFetch({ net1: { sessionId: "sess-1", id: "net1", name: "Villa" } });
    const transport = new HttpCasambiTransport({ apiKey: creds.apiKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    await transport.createSession(creds);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://door.casambi.com/v1/networks/session");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Casambi-Key"]).toBe("test-key");
    expect(JSON.parse(init.body as string)).toEqual({ email: creds.email, password: creds.password });
  });

  it("passes networkId as a QUERY parameter, never a path segment — the real bug: the old code built /v1/networks/{id}/session, a route that doesn't exist (404)", async () => {
    const fetchImpl = fakeFetch({ net1: { sessionId: "sess-1", id: "net1", name: "Villa" } });
    const transport = new HttpCasambiTransport({ apiKey: creds.apiKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    await transport.createSession({ ...creds, networkId: "net1" });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://door.casambi.com/v1/networks/session?networkId=net1");
  });

  it("throws a real, honest error on a non-2xx response, naming the HTTP status", async () => {
    const fetchImpl = fakeFetch({ error: "unauthorized" }, 401);
    const transport = new HttpCasambiTransport({ apiKey: creds.apiKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(transport.createSession(creds)).rejects.toThrow(/HTTP 401/);
  });

  it("parses the map-keyed-by-network-id response shape Casambi's docs describe", async () => {
    const fetchImpl = fakeFetch({ net1: { sessionId: "sess-1", id: "net1", name: "Villa" }, net2: { sessionId: "sess-2", id: "net2", name: "Cabin" } });
    const transport = new HttpCasambiTransport({ apiKey: creds.apiKey, fetchImpl: fetchImpl as unknown as typeof fetch });
    const session = await transport.createSession({ ...creds, networkId: "net2" });
    expect(session).toEqual({ sessionId: "sess-2", networkId: "net2", networkName: "Cabin" });
  });
});
