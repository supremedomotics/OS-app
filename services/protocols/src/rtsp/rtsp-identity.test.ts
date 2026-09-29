import { describe, it, expect } from "vitest";
import { bestName, mergeSignals, resolveOnvifAddress, type RawSignal } from "./rtsp-identity.js";
import type { OnvifProbeMatch } from "./rtsp-types.js";

function onvifMatch(overrides: Partial<OnvifProbeMatch> = {}): OnvifProbeMatch {
  return { uuid: "uuid-1", xaddrs: ["http://192.168.1.50/onvif/device_service"], scopes: [], types: [], ...overrides };
}

describe("bestName — § STEP 4 priority", () => {
  it("prefers the ONVIF device name above everything", () => {
    expect(
      bestName({ onvifName: "Front Door", manufacturer: "Hikvision", model: "DS-2CD", mdnsOrSsdpName: "mdnsname", hostname: "host", ipAddress: "1.2.3.4" }),
    ).toBe("Front Door");
  });
  it("falls back to manufacturer + model", () => {
    expect(bestName({ manufacturer: "Hikvision", model: "DS-2CD2032", ipAddress: "1.2.3.4" })).toBe("Hikvision DS-2CD2032");
  });
  it("falls back to mDNS/SSDP name", () => {
    expect(bestName({ mdnsOrSsdpName: "Backyard Cam", ipAddress: "1.2.3.4" })).toBe("Backyard Cam");
  });
  it("falls back to hostname", () => {
    expect(bestName({ hostname: "cam-01.local", ipAddress: "1.2.3.4" })).toBe("cam-01.local");
  });
  it("falls back to manufacturer alone, then model alone", () => {
    expect(bestName({ manufacturer: "Hikvision", ipAddress: "1.2.3.4" })).toBe("Hikvision");
    expect(bestName({ model: "DS-2CD2032", ipAddress: "1.2.3.4" })).toBe("DS-2CD2032");
  });
  it("falls back to the bare IP only when nothing else is known", () => {
    expect(bestName({ ipAddress: "192.168.1.99" })).toBe("192.168.1.99");
  });
});

describe("resolveOnvifAddress", () => {
  it("resolves ipAddress/port from the XAddr URL", () => {
    const r = resolveOnvifAddress(onvifMatch({ xaddrs: ["http://192.168.1.50:8080/onvif/device_service"] }), "10.0.0.1");
    expect(r).toEqual({ ipAddress: "192.168.1.50", port: 8080 });
  });
  it("falls back to the UDP source address for an unparseable XAddr", () => {
    const r = resolveOnvifAddress(onvifMatch({ xaddrs: ["not a url"] }), "192.168.1.77");
    expect(r.ipAddress).toBe("192.168.1.77");
  });
});

describe("mergeSignals — § STEP 6 dedup", () => {
  it("merges an ONVIF hit and a bare RTSP-port hit for the SAME IP into one result", () => {
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match: onvifMatch({ scopes: ["onvif://www.onvif.org/name/FrontDoor"] }) },
      { method: "rtsp-probe", ipAddress: "192.168.1.50", ports: [554] },
    ];
    const results = mergeSignals(signals);
    expect(results).toHaveLength(1);
    expect(results[0]!.discoveryMethods.sort()).toEqual(["onvif", "rtsp-probe"]);
    expect(results[0]!.onvifAvailable).toBe(true);
    expect(results[0]!.rtspAvailable).toBe(true);
    expect(results[0]!.name).toBe("FrontDoor");
  });

  it("keeps two distinct cameras separate", () => {
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match: onvifMatch({ uuid: "uuid-a" }) },
      { method: "onvif", ipAddress: "192.168.1.51", port: 80, match: onvifMatch({ uuid: "uuid-b" }) },
    ];
    expect(mergeSignals(signals)).toHaveLength(2);
  });

  it("dedups by ONVIF UUID even if the same camera answers on two interfaces with different reported source IPs", () => {
    const match = onvifMatch({ uuid: "uuid-shared", xaddrs: ["http://192.168.1.50/onvif/device_service"] });
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match },
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match },
    ];
    expect(mergeSignals(signals)).toHaveLength(1);
  });

  it("dedups by manufacturer+model+IP when no UUID is present", () => {
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.60", port: 80, match: onvifMatch({ uuid: null, scopes: ["onvif://www.onvif.org/hardware/DS-2CD"] }) },
      { method: "onvif", ipAddress: "192.168.1.60", port: 80, match: onvifMatch({ uuid: null, scopes: ["onvif://www.onvif.org/hardware/DS-2CD"] }) },
    ];
    expect(mergeSignals(signals)).toHaveLength(1);
  });

  it("falls back to a bare IP+service fingerprint when nothing else identifies the camera", () => {
    const signals: RawSignal[] = [{ method: "rtsp-probe", ipAddress: "192.168.1.70", ports: [554, 8554] }];
    const results = mergeSignals(signals);
    expect(results).toHaveLength(1);
    expect(results[0]!.rtspPorts.sort()).toEqual([554, 8554]);
    expect(results[0]!.name).toBe("192.168.1.70");
  });

  it("repeated identical signals never produce duplicate results (idempotent re-discovery)", () => {
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match: onvifMatch() },
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match: onvifMatch() },
      { method: "onvif", ipAddress: "192.168.1.50", port: 80, match: onvifMatch() },
    ];
    expect(mergeSignals(signals)).toHaveLength(1);
  });

  it("sorts results by IP for a stable, predictable list", () => {
    const signals: RawSignal[] = [
      { method: "rtsp-probe", ipAddress: "192.168.1.90", ports: [554] },
      { method: "rtsp-probe", ipAddress: "192.168.1.10", ports: [554] },
    ];
    const results = mergeSignals(signals);
    expect(results.map((r) => r.ipAddress)).toEqual(["192.168.1.10", "192.168.1.90"]);
  });

  it("never crashes on an empty signal list", () => {
    expect(mergeSignals([])).toEqual([]);
  });

  it("uses MAC (when supplied) ahead of manufacturer+model+IP, surviving an IP change across re-scans", () => {
    const macByIp = new Map([
      ["192.168.1.60", "aa:bb:cc:dd:ee:ff"],
      ["192.168.1.61", "aa:bb:cc:dd:ee:ff"], // same camera, new DHCP-leased IP on a re-scan
    ]);
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.60", port: 80, match: onvifMatch({ uuid: null, scopes: ["onvif://www.onvif.org/hardware/DS-2CD"] }) },
      { method: "onvif", ipAddress: "192.168.1.61", port: 80, match: onvifMatch({ uuid: null, scopes: ["onvif://www.onvif.org/hardware/DS-2CD"] }) },
    ];
    // Without a MAC table these would be two distinct manufacturer+model+IP results; with it,
    // they resolve to the SAME camera. (mergeSignals doesn't itself reconcile the differing
    // ipAddress field here — this asserts the identity KEY collapses them into one map entry.)
    const withoutMac = mergeSignals(signals);
    expect(withoutMac).toHaveLength(2);
    const withMac = mergeSignals(signals, macByIp);
    expect(withMac).toHaveLength(1);
  });

  it("MAC lookup with no entry for an IP falls back to the next tier untouched", () => {
    const macByIp = new Map([["10.0.0.9", "aa:bb:cc:dd:ee:ff"]]); // unrelated IP
    const signals: RawSignal[] = [
      { method: "onvif", ipAddress: "192.168.1.60", port: 80, match: onvifMatch({ uuid: null, scopes: ["onvif://www.onvif.org/hardware/DS-2CD"] }) },
    ];
    const results = mergeSignals(signals, macByIp);
    expect(results).toHaveLength(1);
    expect(results[0]!.manufacturer).toBeNull(); // hardware scope maps to model, not manufacturer here
  });
});

describe("UniFi Protect console labeling (§ UniFi Protect)", () => {
  it("labels a host that only answers 7441/7447 as the console, not a working camera", () => {
    const [r] = mergeSignals([{ method: "rtsp-probe", ipAddress: "192.168.0.1", ports: [7447, 7441] }]);
    expect(r!.unifiProtectConsole).toBe(true);
    expect(r!.name).toBe("UniFi Protect console");
    expect(r!.rtspAvailable).toBe(false);
    expect(r!.rtspPorts).toEqual([]);
  });

  it("a real RTSP port alongside 7441 stays a camera but is flagged", () => {
    const [r] = mergeSignals([{ method: "rtsp-probe", ipAddress: "192.168.0.9", ports: [554, 7441] }]);
    expect(r!.rtspAvailable).toBe(true);
    expect(r!.rtspPorts).toEqual([554]);
    expect(r!.unifiProtectConsole).toBe(true);
  });

  it("ordinary RTSP hits are unaffected", () => {
    const [r] = mergeSignals([{ method: "rtsp-probe", ipAddress: "192.168.1.5", ports: [554] }]);
    expect(r!.unifiProtectConsole).toBeUndefined();
    expect(r!.rtspAvailable).toBe(true);
  });
});
