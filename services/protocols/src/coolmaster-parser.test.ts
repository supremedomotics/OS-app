import { describe, expect, it } from "vitest";
import {
  isCoolMasterUid,
  lineOfUid,
  mergeQueryDetail,
  parseGatewayInfo,
  parseGroupLine,
  parseKeyValueLines,
  parseLineInfo,
  parseLs2Block,
  parseLs2Line,
  parseLsLine,
  parseMainControllerLine,
  parseTemperatureToken,
  parseUnitJson,
  parseUnitJsonList,
  parseVentilationLine,
  parseWaterHeaterLine,
  supremeModeFromCoolMaster,
} from "./coolmaster-parser.js";

describe("UID", () => {
  it("recognizes plain and multi-segment UIDs", () => {
    expect(isCoolMasterUid("L1.100")).toBe(true);
    expect(isCoolMasterUid("W1.001")).toBe(true);
    expect(isCoolMasterUid("L1.01.00")).toBe(true); // 4-digit UID mode
    expect(isCoolMasterUid("not-a-uid")).toBe(false);
    expect(isCoolMasterUid("")).toBe(false);
  });

  it("extracts the HVAC line segment", () => {
    expect(lineOfUid("L1.100")).toBe("L1");
    expect(lineOfUid("L2.05")).toBe("L2");
  });
});

describe("parseTemperatureToken", () => {
  it("parses bare and Celsius-suffixed values", () => {
    expect(parseTemperatureToken("24.0C")).toBe(24);
    expect(parseTemperatureToken("18")).toBe(18);
  });
  it("converts Fahrenheit to Celsius", () => {
    expect(parseTemperatureToken("75F")).toBeCloseTo(23.9, 1);
  });
  it("returns null for garbage", () => {
    expect(parseTemperatureToken("n/a")).toBeNull();
  });
});

describe("supremeModeFromCoolMaster", () => {
  it("maps mode words, treating dry as the closest analogue (cool)", () => {
    expect(supremeModeFromCoolMaster("heat", true)).toBe("heat");
    expect(supremeModeFromCoolMaster("dry", true)).toBe("cool");
    expect(supremeModeFromCoolMaster("fan", true)).toBe("fan_only");
  });
  it("is always off when the unit itself is off, regardless of the last mode", () => {
    expect(supremeModeFromCoolMaster("cool", false)).toBe("off");
    expect(supremeModeFromCoolMaster(null, false)).toBe("off");
  });
});

describe("parseLs2Line / parseLs2Block", () => {
  it("parses a space-separated ls2 line (matches the previously validated wire format)", () => {
    const unit = parseLs2Line("L1.100 ON 24.0C 22.5C Low Cool OK - 0");
    expect(unit).toMatchObject({ uid: "L1.100", line: "L1", on: true, setpointC: 24, roomC: 22.5, mode: "cool", fanSpeed: "Low", exitCode: "OK" });
  });

  it("also tolerates comma-separated fields", () => {
    const unit = parseLs2Line("L1.101,OFF,20,19.5,High,Heat,OK");
    expect(unit).toMatchObject({ uid: "L1.101", on: false, setpointC: 20, roomC: 19.5, fanSpeed: "High", mode: "heat" });
  });

  it("returns null for a non-unit line", () => {
    expect(parseLs2Line("not a unit line at all")).toBeNull();
  });

  it("parses a whole block, skipping unparseable lines", () => {
    const units = parseLs2Block(["L1.100 ON 24.0C 22.5C Low Cool OK - 0", "garbage", "L1.101 OFF 20.0C 19.0C Auto Auto OK - 0"]);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.uid)).toEqual(["L1.100", "L1.101"]);
  });
});

describe("parseLsLine", () => {
  it("parses the basic listing", () => {
    expect(parseLsLine("L1.100 ON")).toEqual({ uid: "L1.100", on: true });
  });
});

describe("parseUnitJson / parseUnitJsonList (REST v2)", () => {
  it("parses the documented field names", () => {
    const unit = parseUnitJson({ uid: "L1.100", onoff: "ON", mode: "cool", st: 24, rt: 22.5, fspeed: "Low", filt: false, dmnd: true, fault: 0 });
    expect(unit).toMatchObject({ uid: "L1.100", on: true, mode: "cool", setpointC: 24, roomC: 22.5, fanSpeed: "Low", filterWarning: false, demand: true, faultCode: null });
  });

  it("treats a non-zero/non-empty fault as present", () => {
    const unit = parseUnitJson({ uid: "L1.100", onoff: true, fault: "E4" });
    expect(unit?.faultCode).toBe("E4");
  });

  it("rejects a row with no valid uid", () => {
    expect(parseUnitJson({ onoff: true })).toBeNull();
  });

  it("parses a list, skipping invalid rows", () => {
    const units = parseUnitJsonList([{ uid: "L1.100", onoff: true }, { onoff: true }]);
    expect(units).toHaveLength(1);
  });
});

describe("parseKeyValueLines / parseGatewayInfo / parseLineInfo", () => {
  it("parses colon, equals, and space-separated key/value forms", () => {
    const kv = parseKeyValueLines(["Serial: ABC123", "Firmware=1.2.3", "Application CoolMasterNet"]);
    expect(kv).toEqual({ serial: "ABC123", firmware: "1.2.3", application: "CoolMasterNet" });
  });

  it("builds gateway info from an info response, falling back to host when serial is unreported", () => {
    const info = parseGatewayInfo(["Firmware: 3.14"], "192.168.1.50");
    expect(info).toEqual({ serial: "192.168.1.50", firmwareVersion: "3.14", application: null, host: "192.168.1.50" });
  });

  it("parses HVAC line listings", () => {
    const lines = parseLineInfo(["L1 Daikin active", "L2 disabled"]);
    expect(lines).toEqual([
      { id: "L1", manufacturer: null, active: true },
      { id: "L2", manufacturer: null, active: false },
    ]);
  });
});

describe("mergeQueryDetail", () => {
  it("overlays query detail without clobbering fields the query response doesn't mention", () => {
    const base = parseLs2Line("L1.100 ON 24.0C 22.5C Low Cool OK - 0")!;
    const merged = mergeQueryDetail(base, ["Swing: Auto", "Filter: yes", "Lock: off"]);
    expect(merged.swing).toBe("Auto");
    expect(merged.filterWarning).toBe(true);
    expect(merged.locked).toBe(false);
    expect(merged.setpointC).toBe(24); // untouched
  });
});

describe("secondary device type parsers (low confidence, inferred grammar)", () => {
  it("parses a water heater line", () => {
    expect(parseWaterHeaterLine("W1.001 ON 55C 50C OK")).toMatchObject({ uid: "W1.001", on: true, setpointC: 55, roomC: 50, faultCode: null });
  });
  it("parses a ventilation line", () => {
    expect(parseVentilationLine("V1.001 ON High OK")).toMatchObject({ uid: "V1.001", on: true, fanSpeed: "High" });
  });
  it("parses a main controller line", () => {
    expect(parseMainControllerLine("M1.001 ON OK")).toMatchObject({ uid: "M1.001", on: true, faultCode: null });
  });
  it("parses a group line with members", () => {
    const group = parseGroupLine("Downstairs L1.100 L1.101 L1.102");
    expect(group).toEqual({ id: "Downstairs", label: "Downstairs", memberUids: ["L1.100", "L1.101", "L1.102"] });
  });
  it("returns null for a group line with no resolvable members", () => {
    expect(parseGroupLine("SomeGroup")).toBeNull();
  });
});
