import { describe, it, expect, vi } from "vitest";
import { buildWsSecurityHeader, getDeviceInformation, getMediaProfiles, getStreamUri, getMediaServiceEndpoint, OnvifSoapError, type SoapFetch } from "./onvif-soap.js";

describe("buildWsSecurityHeader", () => {
  it("produces a deterministic digest for the same nonce/time/password (spec formula)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const nonce = Buffer.from("0123456789abcdef");
    const h1 = buildWsSecurityHeader({ username: "admin", password: "secret" }, now, nonce);
    const h2 = buildWsSecurityHeader({ username: "admin", password: "secret" }, now, nonce);
    expect(h1).toBe(h2);
    expect(h1).toContain("PasswordDigest");
    expect(h1).toContain("<wsse:Username>admin</wsse:Username>");
  });
  it("never includes the plaintext password anywhere in the header", () => {
    const h = buildWsSecurityHeader({ username: "admin", password: "s3cr3t-value" });
    expect(h).not.toContain("s3cr3t-value");
  });
});

const DEVICE_INFO_XML = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<GetDeviceInformationResponse xmlns="http://www.onvif.org/ver10/device/wsdl">
<Manufacturer>Hikvision</Manufacturer><Model>DS-2CD2032-I</Model><FirmwareVersion>5.5.0</FirmwareVersion>
<SerialNumber>ABC123</SerialNumber><HardwareId>HW1</HardwareId>
</GetDeviceInformationResponse></s:Body></s:Envelope>`;

describe("getDeviceInformation", () => {
  it("parses manufacturer/model from a real-shaped response", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: DEVICE_INFO_XML }));
    const info = await getDeviceInformation("http://192.168.1.50/onvif/device_service", { username: "a", password: "b" }, fetchImpl);
    expect(info.manufacturer).toBe("Hikvision");
    expect(info.model).toBe("DS-2CD2032-I");
    expect(info.serialNumber).toBe("ABC123");
  });

  it("throws OnvifSoapError on a 401", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 401, text: "" }));
    await expect(getDeviceInformation("http://x/onvif/device_service", { username: "a", password: "b" }, fetchImpl)).rejects.toThrow(OnvifSoapError);
  });

  it("degrades gracefully on missing fields rather than throwing", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: "<Envelope><Body><GetDeviceInformationResponse/></Body></Envelope>" }));
    const info = await getDeviceInformation("http://x", null, fetchImpl);
    expect(info.manufacturer).toBeNull();
    expect(info.model).toBeNull();
  });
});

const PROFILES_XML = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<GetProfilesResponse xmlns="http://www.onvif.org/ver10/media/wsdl">
<Profiles token="MainStream" fixed="true"><Name>MainStream</Name></Profiles>
<Profiles token="SubStream" fixed="true"><Name>SubStream</Name></Profiles>
</GetProfilesResponse></s:Body></s:Envelope>`;

describe("getMediaProfiles", () => {
  it("parses multiple profiles and marks the first/main one", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: PROFILES_XML }));
    const profiles = await getMediaProfiles("http://x/onvif/media_service", { username: "a", password: "b" }, fetchImpl);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.token).toBe("MainStream");
    expect(profiles[0]!.isLikelyMain).toBe(true);
    expect(profiles[1]!.token).toBe("SubStream");
  });

  it("returns [] rather than throwing for a response with no profiles (partial ONVIF impl)", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: "<s:Envelope><s:Body><GetProfilesResponse/></s:Body></s:Envelope>" }));
    const profiles = await getMediaProfiles("http://x", { username: "a", password: "b" }, fetchImpl);
    expect(profiles).toEqual([]);
  });

  it("throws OnvifSoapError on auth failure", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 401, text: "" }));
    await expect(getMediaProfiles("http://x", { username: "a", password: "wrong" }, fetchImpl)).rejects.toThrow(OnvifSoapError);
  });
});

describe("getStreamUri", () => {
  it("returns the real RTSP URI from the response", async () => {
    const xml = `<s:Envelope><s:Body><GetStreamUriResponse><MediaUri><Uri>rtsp://192.168.1.50:554/Streaming/Channels/101</Uri></MediaUri></GetStreamUriResponse></s:Body></s:Envelope>`;
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: xml }));
    const uri = await getStreamUri("http://x", "MainStream", { username: "a", password: "b" }, fetchImpl);
    expect(uri).toBe("rtsp://192.168.1.50:554/Streaming/Channels/101");
  });

  it("returns null when no Uri tag is present", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: "<s:Envelope><s:Body><GetStreamUriResponse/></s:Body></s:Envelope>" }));
    const uri = await getStreamUri("http://x", "MainStream", { username: "a", password: "b" }, fetchImpl);
    expect(uri).toBeNull();
  });
});

describe("getMediaServiceEndpoint", () => {
  it("resolves from GetCapabilities when available", async () => {
    const xml = `<s:Envelope><s:Body><GetCapabilitiesResponse><Capabilities><Media><XAddr>http://192.168.1.50/onvif/media_service</XAddr></Media></Capabilities></GetCapabilitiesResponse></s:Body></s:Envelope>`;
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 200, text: xml }));
    const endpoint = await getMediaServiceEndpoint("http://192.168.1.50/onvif/device_service", { username: "a", password: "b" }, fetchImpl);
    expect(endpoint).toBe("http://192.168.1.50/onvif/media_service");
  });

  it("falls back to the naming convention when GetCapabilities fails", async () => {
    const fetchImpl: SoapFetch = vi.fn(async () => ({ status: 500, text: "" }));
    const endpoint = await getMediaServiceEndpoint("http://192.168.1.50/onvif/device_service", { username: "a", password: "b" }, fetchImpl);
    expect(endpoint).toBe("http://192.168.1.50/onvif/media_service");
  });
});
