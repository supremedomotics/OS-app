import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { parseSsdpResponse, ssdpSearch, type SsdpResponse, type SsdpSocket } from "./ssdp.js";
import { WiimProtocolDriver } from "./wiim-driver.js";
import { SonosProtocolDriver } from "./sonos-driver.js";

/** A fake SSDP socket that replays canned responses after M-SEARCH is sent. */
function fakeSocket(responses: { raw: string; address: string }[]): SsdpSocket {
  let handler: ((msg: Buffer, rinfo: { address: string }) => void) | null = null;
  return {
    on: (_e, cb) => void (handler = cb),
    bind: (cb) => cb(),
    send: () => {
      for (const r of responses) handler?.(Buffer.from(r.raw), { address: r.address });
    },
    close: () => {},
  };
}

const WIIM_RESP = [
  "HTTP/1.1 200 OK",
  "LOCATION: http://10.0.0.21:49152/description.xml",
  "SERVER: Linux/4.x UPnP/1.0 LinkPlay/4.6",
  "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
  "USN: uuid:FF98F4-WiiM::urn:schemas-upnp-org:device:MediaRenderer:1",
].join("\r\n");

const SONOS_RESP = [
  "HTTP/1.1 200 OK",
  "LOCATION: http://10.0.0.55:1400/xml/device_description.xml",
  "SERVER: Linux UPnP/1.0 Sonos/70.x",
  "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
  "USN: uuid:RINCON_ABC::urn:schemas-upnp-org:device:ZonePlayer:1",
].join("\r\n");

const OTHER_RESP = ["HTTP/1.1 200 OK", "SERVER: SomeRandomRenderer/1.0", "ST: urn:schemas-upnp-org:device:MediaRenderer:1"].join("\r\n");

describe("SSDP", () => {
  it("parses an SSDP response into headered fields", () => {
    const r = parseSsdpResponse(WIIM_RESP, "10.0.0.21");
    expect(r).toMatchObject({
      address: "10.0.0.21",
      location: "http://10.0.0.21:49152/description.xml",
      server: "Linux/4.x UPnP/1.0 LinkPlay/4.6",
      st: "urn:schemas-upnp-org:device:MediaRenderer:1",
    });
  });

  it("runs M-SEARCH and collects unique responses (fast timeout)", async () => {
    const found = await ssdpSearch({
      timeoutMs: 30,
      createSocket: () => fakeSocket([
        { raw: WIIM_RESP, address: "10.0.0.21" },
        { raw: SONOS_RESP, address: "10.0.0.55" },
      ]),
    });
    expect(found.map((r) => r.address).sort()).toEqual(["10.0.0.21", "10.0.0.55"]);
  });
});

describe("driver discovery over SSDP", () => {
  it("WiiM discover() claims only LinkPlay/WiiM renderers", async () => {
    const driver = new WiimProtocolDriver({
      ssdp: async () =>
        [
          parseSsdpResponse(WIIM_RESP, "10.0.0.21"),
          parseSsdpResponse(OTHER_RESP, "10.0.0.99"),
        ] as SsdpResponse[],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ backendId: "10.0.0.21", capabilities: ["media"] });
    expect(found[0]?.suggestedName).toContain("10.0.0.21");
  });

  it("Sonos discover() claims ZonePlayers", async () => {
    const driver = new SonosProtocolDriver({
      ssdp: async () => [parseSsdpResponse(SONOS_RESP, "10.0.0.55")] as SsdpResponse[],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ backendId: "10.0.0.55", capabilities: ["media"] });
  });

  it("commission-ready: discovered media devices carry the bindable IP as backendId", async () => {
    const driver = new WiimProtocolDriver({
      ssdp: async () => [parseSsdpResponse(WIIM_RESP, "10.0.0.21")] as SsdpResponse[],
    });
    const [d] = await driver.discover();
    // backendId is exactly what bind() expects as the host address.
    await driver.bind({ deviceId: "x" as DeviceId, capability: "media", address: d!.backendId });
    expect(driver.manages("x" as DeviceId)).toBe(true);
  });
});
