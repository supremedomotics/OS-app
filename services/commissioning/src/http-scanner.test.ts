import { describe, expect, it } from "vitest";
import { HttpProtocolScanner } from "./http-scanner.js";

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, json: async () => payload }) as Response) as unknown as typeof fetch;
}

describe("HttpProtocolScanner", () => {
  it("normalizes the Python service response into DiscoveredDevices", async () => {
    const scanner = new HttpProtocolScanner({
      protocol: "knx",
      baseUrl: "http://127.0.0.1:9000",
      fetchImpl: fakeFetch({
        devices: [{ backend_id: "knx.1_1_3", name: "Kitchen Dimmer", capabilities: ["onoff", "brightness"] }],
      }),
    });
    const found = await scanner.scan();
    expect(found).toEqual([
      {
        backendId: "knx.1_1_3",
        suggestedName: "Kitchen Dimmer",
        capabilities: ["onoff", "brightness"],
        raw: { protocol: "knx" },
      },
    ]);
  });

  it("returns no devices when the scanner is unreachable", async () => {
    const scanner = new HttpProtocolScanner({
      protocol: "modbus",
      baseUrl: "http://127.0.0.1:9000",
      fetchImpl: (() => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await scanner.scan()).toEqual([]);
  });
});
