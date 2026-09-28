import { describe, it, expect, vi } from "vitest";
import { discoverCameras, getOnvifStreamInfo, withCredentials, stripCredentials, CommissioningError } from "./rtsp-camera-service.js";
import type { SoapFetch } from "./onvif-soap.js";
import type { OnvifDiscoverySocket } from "./onvif-wsdiscovery.js";

const PROBE_MATCH_XML = `<d:ProbeMatches><d:ProbeMatch>
  <a:EndpointReference><a:Address>urn:uuid:aaaa1111-2222-3333-4444-555566667777</a:Address></a:EndpointReference>
  <d:Scopes>onvif://www.onvif.org/name/Driveway</d:Scopes>
  <d:XAddrs>http://192.168.1.50/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches>`;

describe("discoverCameras", () => {
  it("merges ONVIF + RTSP-probe signals into deduplicated results, streaming incremental updates", async () => {
    const partials: number[] = [];
    const onvifSocketFactory = vi.fn(async (): Promise<OnvifDiscoverySocket> => {
      const listeners: ((msg: Buffer, rinfo: { address: string }) => void)[] = [];
      return {
        send: () => {
          queueMicrotask(() => listeners.forEach((l) => l(Buffer.from(PROBE_MATCH_XML), { address: "192.168.1.50" })));
        },
        onMessage: (cb) => listeners.push(cb),
        close: () => {},
      };
    });
    const tcpProbe = vi.fn(async (host: string, port: number) => host === "192.168.1.51" && port === 554);

    const results = await discoverCameras({
      interfaces: ["192.168.1.10"],
      hostsOverride: ["192.168.1.50", "192.168.1.51"],
      timeoutMs: 20,
      onvifSocketFactory,
      tcpProbe,
      onResult: (partial) => partials.push(partial.length),
    });

    expect(results).toHaveLength(2);
    const onvifResult = results.find((r) => r.onvifAvailable);
    expect(onvifResult?.name).toBe("Driveway");
    expect(onvifResult?.onvifUuid).toBe("aaaa1111-2222-3333-4444-555566667777");
    const rtspOnly = results.find((r) => !r.onvifAvailable);
    expect(rtspOnly?.ipAddress).toBe("192.168.1.51");
    expect(partials.length).toBeGreaterThan(0); // real incremental reporting happened (§ STEP 13)
  });

  it("never crashes when there are no local interfaces at all", async () => {
    const results = await discoverCameras({ interfaces: [], hostsOverride: [] });
    expect(results).toEqual([]);
  });

  it("is cancellable", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = discoverCameras({
      interfaces: ["192.168.1.10"],
      hostsOverride: [],
      timeoutMs: 5000,
      onvifSocketFactory: async () => ({ send: () => {}, onMessage: () => {}, close: () => {} }),
      signal: controller.signal,
    });
    controller.abort();
    await promise;
    expect(Date.now() - started).toBeLessThan(500);
  });
});

function fetchWith(responses: Record<string, string>): SoapFetch {
  return vi.fn(async (url: string, body: string) => {
    if (/GetDeviceInformation/.test(body)) return { status: 200, text: responses.deviceInfo ?? "<s:Envelope><s:Body/></s:Envelope>" };
    if (/GetCapabilities/.test(body)) return { status: 200, text: responses.capabilities ?? "" };
    if (/GetProfiles\b/.test(body)) return { status: 200, text: responses.profiles ?? "<s:Envelope><s:Body/></s:Envelope>" };
    if (/GetStreamUri/.test(body)) return { status: 200, text: responses.streamUri ?? "<s:Envelope><s:Body/></s:Envelope>" };
    return { status: 404, text: "" };
  });
}

describe("getOnvifStreamInfo — § STEP 7 ONVIF commissioning", () => {
  it("returns main + substream URIs from real profile/stream queries", async () => {
    const fetchImpl = fetchWith({
      deviceInfo: `<s:Envelope><s:Body><GetDeviceInformationResponse><Manufacturer>Hikvision</Manufacturer><Model>DS-2CD</Model></GetDeviceInformationResponse></s:Body></s:Envelope>`,
      profiles: `<s:Envelope><s:Body><GetProfilesResponse><Profiles token="main"><Name>MainStream</Name></Profiles><Profiles token="sub"><Name>SubStream</Name></Profiles></GetProfilesResponse></s:Body></s:Envelope>`,
      streamUri: `<s:Envelope><s:Body><GetStreamUriResponse><MediaUri><Uri>rtsp://192.168.1.50:554/ch1</Uri></MediaUri></GetStreamUriResponse></s:Body></s:Envelope>`,
    });
    const info = await getOnvifStreamInfo({ deviceEndpoint: "http://192.168.1.50/onvif/device_service", credentials: { username: "admin", password: "x" }, fetchImpl });
    expect(info.manufacturer).toBe("Hikvision");
    expect(info.mainStreamUri).toBe("rtsp://192.168.1.50:554/ch1");
    expect(info.mainProfileToken).toBe("main");
    expect(info.subProfileToken).toBe("sub");
  });

  it("throws a CommissioningError with an installer-safe message when there are no media profiles", async () => {
    const fetchImpl = fetchWith({ profiles: `<s:Envelope><s:Body><GetProfilesResponse/></s:Body></s:Envelope>` });
    await expect(
      getOnvifStreamInfo({ deviceEndpoint: "http://192.168.1.50/onvif/device_service", credentials: { username: "a", password: "b" }, fetchImpl }),
    ).rejects.toThrow(CommissioningError);
  });

  it("throws a CommissioningError when profile retrieval is unauthorized", async () => {
    const fetchImpl: SoapFetch = vi.fn(async (url, body) => {
      if (/GetProfiles/.test(body)) return { status: 401, text: "" };
      return { status: 200, text: "<s:Envelope><s:Body/></s:Envelope>" };
    });
    await expect(
      getOnvifStreamInfo({ deviceEndpoint: "http://192.168.1.50/onvif/device_service", credentials: { username: "a", password: "wrong" }, fetchImpl }),
    ).rejects.toThrow(/username or password/i);
  });

  it("proceeds with unknown manufacturer/model when GetDeviceInformation fails but media works (partial ONVIF)", async () => {
    const fetchImpl: SoapFetch = vi.fn(async (url, body) => {
      if (/GetDeviceInformation/.test(body)) return { status: 500, text: "" };
      if (/GetProfiles\b/.test(body)) return { status: 200, text: `<s:Envelope><s:Body><GetProfilesResponse><Profiles token="main"><Name>Main</Name></Profiles></GetProfilesResponse></s:Body></s:Envelope>` };
      if (/GetStreamUri/.test(body)) return { status: 200, text: `<s:Envelope><s:Body><GetStreamUriResponse><MediaUri><Uri>rtsp://x/ch1</Uri></MediaUri></GetStreamUriResponse></s:Body></s:Envelope>` };
      return { status: 200, text: "<s:Envelope><s:Body/></s:Envelope>" };
    });
    const info = await getOnvifStreamInfo({ deviceEndpoint: "http://x/onvif/device_service", credentials: { username: "a", password: "b" }, fetchImpl });
    expect(info.manufacturer).toBeNull();
    expect(info.mainStreamUri).toBe("rtsp://x/ch1");
  });
});

describe("withCredentials / stripCredentials", () => {
  it("injects and strips userinfo symmetrically", () => {
    const withCreds = withCredentials("rtsp://192.168.1.50:554/ch1", { username: "admin", password: "s3cret" });
    expect(withCreds).toContain("admin:");
    expect(stripCredentials(withCreds)).toBe("rtsp://192.168.1.50:554/ch1");
  });

  it("never crashes on a malformed URI", () => {
    expect(() => withCredentials("not a url", { username: "a", password: "b" })).not.toThrow();
    expect(() => stripCredentials("not a url")).not.toThrow();
  });
});
