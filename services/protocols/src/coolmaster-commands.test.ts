import { describe, expect, it } from "vitest";
import {
  cmdAllOff,
  cmdAllOn,
  cmdFanSpeed,
  cmdFilterReset,
  cmdGroupPower,
  cmdInfo,
  cmdInhibit,
  cmdLine,
  cmdLock,
  cmdLs,
  cmdLs2,
  cmdMainControllerPower,
  cmdMode,
  cmdOff,
  cmdOn,
  cmdPropsSetName,
  cmdQuery,
  cmdStat,
  cmdSwing,
  cmdTemp,
  cmdVentilationFanSpeed,
  cmdVentilationPower,
  cmdVirtualAddress,
  cmdWaterHeaterPower,
  cmdWaterHeaterTemp,
  encodePropsName,
  PROPS_NAME_MAX_LENGTH,
} from "./coolmaster-commands.js";
import { CoolMasterUnsupportedCommandError, CoolMasterValidationError } from "./coolmaster-errors.js";

describe("core on/off/mode/temp commands (high confidence)", () => {
  it("builds on/off", () => {
    expect(cmdOn("L1.100")).toBe("on L1.100");
    expect(cmdOff("L1.100")).toBe("off L1.100");
  });
  it("builds allon/alloff, with and without a line scope", () => {
    expect(cmdAllOn()).toBe("allon");
    expect(cmdAllOn("L1")).toBe("allon L1");
    expect(cmdAllOff("L1")).toBe("alloff L1");
  });
  it("builds a mode command using the mode word itself as the verb", () => {
    expect(cmdMode("L1.100", "cool")).toBe("cool L1.100");
    expect(cmdMode("L1.100", "dry")).toBe("dry L1.100");
  });
  it("builds a setpoint command", () => {
    expect(cmdTemp("L1.100", 22)).toBe("temp L1.100 22");
  });
  it("rejects an empty uid", () => {
    expect(() => cmdOn("")).toThrow(CoolMasterUnsupportedCommandError);
  });
});

describe("discovery/status verbs (high confidence)", () => {
  it("builds bare listing/status commands", () => {
    expect(cmdLs()).toBe("ls");
    expect(cmdLs2()).toBe("ls2");
    expect(cmdStat()).toBe("stat");
    expect(cmdInfo()).toBe("info");
    expect(cmdLine()).toBe("line");
  });
  it("builds a per-unit query", () => {
    expect(cmdQuery("L1.100")).toBe("query L1.100");
  });
});

describe("advanced control commands (medium confidence)", () => {
  it("builds fan speed / swing / filter reset / lock / inhibit", () => {
    expect(cmdFanSpeed("L1.100", "High")).toBe("fspeed L1.100 High");
    expect(cmdSwing("L1.100", "Auto")).toBe("swing L1.100 Auto");
    expect(cmdFilterReset("L1.100")).toBe("filt L1.100 reset");
    expect(cmdLock("L1.100", true)).toBe("lock L1.100 on");
    expect(cmdLock("L1.100", false)).toBe("lock L1.100 off");
    expect(cmdInhibit("L1.100", true)).toBe("inhibit L1.100 on");
  });
});

describe("secondary device commands (low confidence, inferred grammar)", () => {
  it("builds water heater power + temp", () => {
    expect(cmdWaterHeaterPower("W1.001", true)).toBe("wh W1.001 on");
    expect(cmdWaterHeaterTemp("W1.001", 55)).toBe("wh W1.001 temp 55");
  });
  it("builds main controller power", () => {
    expect(cmdMainControllerPower("M1.001", false)).toBe("main M1.001 off");
  });
  it("builds ventilation power + fan speed", () => {
    expect(cmdVentilationPower("V1.001", true)).toBe("vam V1.001 on");
    expect(cmdVentilationFanSpeed("V1.001", "Low")).toBe("vam V1.001 fspeed Low");
  });
  it("builds group power", () => {
    expect(cmdGroupPower("Downstairs", true)).toBe("group Downstairs on");
  });
  it("rejects an empty group id", () => {
    expect(() => cmdGroupPower("", true)).toThrow(CoolMasterUnsupportedCommandError);
  });
});

describe("unimplemented commands", () => {
  it("va (Virtual Address) throws explicitly rather than fabricating a command", () => {
    expect(() => cmdVirtualAddress()).toThrow(CoolMasterUnsupportedCommandError);
  });
});

// § Indoor-Unit Name Synchronization — the ONE `props` form with real hardware evidence.
describe("cmdPropsSetName / encodePropsName (§ Indoor-Unit Name Synchronization, live-confirmed)", () => {
  it("builds the live-confirmed 'props <uid> name <name>' command", () => {
    expect(cmdPropsSetName("L1.101", "Living Room")).toBe("props L1.101 name Living Room");
  });

  it("trims leading/trailing whitespace but preserves internal spaces", () => {
    expect(encodePropsName("  Living Room  ")).toBe("Living Room");
    expect(cmdPropsSetName("L1.101", "  Master Bedroom  ")).toBe("props L1.101 name Master Bedroom");
  });

  it("rejects an empty name (after trimming)", () => {
    expect(() => encodePropsName("")).toThrow(CoolMasterValidationError);
    expect(() => encodePropsName("   ")).toThrow(CoolMasterValidationError);
  });

  it("rejects CR/LF — never lets a name inject or terminate the ASCII_IF command line", () => {
    expect(() => encodePropsName("Living Room\r\noff L1.101")).toThrow(CoolMasterValidationError);
    expect(() => encodePropsName("Living\nRoom")).toThrow(CoolMasterValidationError);
  });

  it('rejects "|" — reserved by the gateway\'s own props table column delimiter', () => {
    expect(() => encodePropsName("Living | Room")).toThrow(CoolMasterValidationError);
  });

  it("accepts a name exactly at the assumed maximum length", () => {
    const exact = "A".repeat(PROPS_NAME_MAX_LENGTH);
    expect(encodePropsName(exact)).toBe(exact);
  });

  it("rejects a name one character over the assumed maximum length", () => {
    const tooLong = "A".repeat(PROPS_NAME_MAX_LENGTH + 1);
    expect(() => encodePropsName(tooLong)).toThrow(CoolMasterValidationError);
  });

  it("rejects an empty uid, matching every other command builder's guard", () => {
    expect(() => cmdPropsSetName("", "Living Room")).toThrow(CoolMasterUnsupportedCommandError);
  });
});
