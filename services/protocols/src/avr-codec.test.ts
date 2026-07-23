import { describe, expect, it } from "vitest";
import { commandToAvr, denonCapabilityConfig, parseAvrLine } from "./avr-codec.js";

/**
 * Pure-function tests for the Audyssey-family additions (§ Universal AVR SDK) — Dynamic
 * EQ / Audyssey MultEQ mode / Reference Level Offset / Dynamic Volume / DRC, all sourced
 * from the official Denon AVR control protocol PDF (Ver.8.6.0, p.13-14). No fake TCP
 * server needed since these are pure encode/decode functions, same convention as
 * avr-http-codec.test.ts.
 */
describe("avr-codec: Audyssey-family commands", () => {
  it("encodes Dynamic EQ on/off", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { dynamicEq: "on" } }, null)).toEqual(["PSDYNEQ ON"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { dynamicEq: "off" } }, null)).toEqual(["PSDYNEQ OFF"]);
  });

  it("encodes Audyssey MultEQ mode, rejecting unknown values", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { audysseyMode: "FLAT" } }, null)).toEqual(["PSMULTEQ:FLAT"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { audysseyMode: "BOGUS" } }, null)).toBeNull();
  });

  it("encodes Reference Level Offset, rejecting values outside the fixed enum", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { referenceLevel: 10 } }, null)).toEqual(["PSREFLEV 10"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { referenceLevel: 7 } }, null)).toBeNull();
  });

  it("encodes Dynamic Volume", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { dynamicVolume: "HEV" } }, null)).toEqual(["PSDYNVOL HEV"]);
  });

  it("encodes Dynamic Range Compression", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { drc: "AUTO" } }, null)).toEqual(["PSDRC AUTO"]);
  });

  it("combines multiple Audyssey-family fields into one token batch", () => {
    expect(
      commandToAvr({ capability: "media", action: "advanced", advanced: { dynamicEq: "on", referenceLevel: 5 } }, null),
    ).toEqual(["PSDYNEQ ON", "PSREFLEV 5"]);
  });

  it("never encodes Audyssey-family tokens for zone2 (main-zone only, same as tone/DSP)", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { dynamicEq: "on" } }, null, "zone2")).toBeNull();
  });

  it("parses PSDYNEQ echoes", () => {
    expect(parseAvrLine("PSDYNEQ ON")).toEqual({ kind: "dynamicEq", on: true });
    expect(parseAvrLine("PSDYNEQ OFF")).toEqual({ kind: "dynamicEq", on: false });
  });

  it("parses PSMULTEQ: echoes, ignoring unrecognized modes", () => {
    expect(parseAvrLine("PSMULTEQ:AUDYSSEY")).toEqual({ kind: "audysseyMode", mode: "AUDYSSEY" });
    expect(parseAvrLine("PSMULTEQ:BYP.LR")).toEqual({ kind: "audysseyMode", mode: "BYP.LR" });
    expect(parseAvrLine("PSMULTEQ:NOTAREALMODE")).toBeNull();
  });

  it("parses PSREFLEV echoes, ignoring out-of-enum values", () => {
    expect(parseAvrLine("PSREFLEV 15")).toEqual({ kind: "referenceLevel", db: 15 });
    expect(parseAvrLine("PSREFLEV 7")).toBeNull();
  });

  it("parses PSDYNVOL echoes", () => {
    expect(parseAvrLine("PSDYNVOL LIT")).toEqual({ kind: "dynamicVolume", mode: "LIT" });
  });

  it("parses PSDRC echoes", () => {
    expect(parseAvrLine("PSDRC MID")).toEqual({ kind: "drc", mode: "MID" });
  });

  it("does not misparse the pre-existing PSBAS/PSTRE/MS tokens after adding the new prefixes", () => {
    expect(parseAvrLine("PSBAS 56")).toEqual({ kind: "bass", bass: 6 });
    expect(parseAvrLine("PSTRE 44")).toEqual({ kind: "treble", treble: -6 });
    expect(parseAvrLine("MSSTEREO")).toEqual({ kind: "soundMode", mode: "STEREO" });
  });
});

describe("avr-codec: denonCapabilityConfig hasAudyssey gating", () => {
  it("omits Audyssey-family advancedControls when hasAudyssey is false (default)", () => {
    const config = denonCapabilityConfig({ hasZone2: false, hasToneControl: true });
    const keys = (config.advancedControls ?? []).map((c) => c.key);
    expect(keys).not.toContain("dynamicEq");
    expect(keys).not.toContain("audysseyMode");
  });

  it("advertises all five Audyssey-family advancedControls when hasAudyssey is true", () => {
    const config = denonCapabilityConfig({ hasZone2: false, hasToneControl: true, hasAudyssey: true });
    const keys = (config.advancedControls ?? []).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["dynamicEq", "audysseyMode", "referenceLevel", "dynamicVolume", "drc"]));
  });
});

/**
 * § RTI Capability Audit, Category A (docs/architecture/RTI-Capability-Audit.md) — Subwoofer
 * On/Off, Cinema/Music/Game/Pro Logic mode, Cinema EQ, Loudness Management, and Tone Control
 * on/off. All five confirmed via the same official Denon PDF (Ver.8.6.0, p.12/p.15).
 */
describe("avr-codec: RTI Capability Audit Category A commands", () => {
  it("encodes Tone Control on/off", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { toneControlEnabled: "on" } }, null)).toEqual(["PSTONE CTRL ON"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { toneControlEnabled: "off" } }, null)).toEqual(["PSTONE CTRL OFF"]);
  });

  it("encodes Subwoofer on/off", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { subwoofer: "on" } }, null)).toEqual(["PSSWR ON"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { subwoofer: "off" } }, null)).toEqual(["PSSWR OFF"]);
  });

  it("encodes Cinema/Music/Game/Pro Logic mode, rejecting unknown values", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { cinemaMode: "GAME" } }, null)).toEqual(["PSMODE:GAME"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { cinemaMode: "PRO LOGIC" } }, null)).toEqual(["PSMODE:PRO LOGIC"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { cinemaMode: "BOGUS" } }, null)).toBeNull();
  });

  it("encodes Cinema EQ on/off with no space before ON/OFF, matching the PDF's literal worked example", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { cinemaEq: "on" } }, null)).toEqual(["PSCINEMA EQ.ON"]);
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { cinemaEq: "off" } }, null)).toEqual(["PSCINEMA EQ.OFF"]);
  });

  it("encodes Loudness Management on/off", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { loudnessManagement: "on" } }, null)).toEqual(["PSLOM ON"]);
  });

  it("never encodes Category A tokens for zone2 (main-zone only)", () => {
    expect(commandToAvr({ capability: "media", action: "advanced", advanced: { subwoofer: "on" } }, null, "zone2")).toBeNull();
  });

  it("parses PSTONE CTRL echoes", () => {
    expect(parseAvrLine("PSTONE CTRL ON")).toEqual({ kind: "toneControlEnabled", on: true });
    expect(parseAvrLine("PSTONE CTRL OFF")).toEqual({ kind: "toneControlEnabled", on: false });
  });

  it("parses PSSWR echoes", () => {
    expect(parseAvrLine("PSSWR ON")).toEqual({ kind: "subwoofer", on: true });
    expect(parseAvrLine("PSSWR OFF")).toEqual({ kind: "subwoofer", on: false });
  });

  it("parses PSMODE: echoes, ignoring unrecognized modes", () => {
    expect(parseAvrLine("PSMODE:CINEMA")).toEqual({ kind: "cinemaMode", mode: "CINEMA" });
    expect(parseAvrLine("PSMODE:NOTAREALMODE")).toBeNull();
  });

  it("parses PSCINEMA EQ echoes", () => {
    expect(parseAvrLine("PSCINEMA EQ.ON")).toEqual({ kind: "cinemaEq", on: true });
    expect(parseAvrLine("PSCINEMA EQ.OFF")).toEqual({ kind: "cinemaEq", on: false });
  });

  it("parses PSLOM echoes", () => {
    expect(parseAvrLine("PSLOM ON")).toEqual({ kind: "loudnessManagement", on: true });
    expect(parseAvrLine("PSLOM OFF")).toEqual({ kind: "loudnessManagement", on: false });
  });

  it("does not misparse pre-existing tokens after adding the new PSMODE:/PSCINEMA/PSLOM/PSSWR/PSTONE CTRL prefixes", () => {
    expect(parseAvrLine("PSMULTEQ:AUDYSSEY")).toEqual({ kind: "audysseyMode", mode: "AUDYSSEY" });
    expect(parseAvrLine("MSSTEREO")).toEqual({ kind: "soundMode", mode: "STEREO" });
  });
});

describe("avr-codec: denonCapabilityConfig hasExtendedAudio / tone-control-enabled gating", () => {
  it("omits Category A advancedControls when hasExtendedAudio is false (default) and hasToneControl is false", () => {
    const config = denonCapabilityConfig({ hasZone2: false, hasToneControl: false });
    const keys = (config.advancedControls ?? []).map((c) => c.key);
    expect(keys).not.toContain("subwoofer");
    expect(keys).not.toContain("cinemaMode");
    expect(keys).not.toContain("cinemaEq");
    expect(keys).not.toContain("loudnessManagement");
    expect(keys).not.toContain("toneControlEnabled");
  });

  it("advertises toneControlEnabled when hasToneControl is true, independent of hasExtendedAudio", () => {
    const config = denonCapabilityConfig({ hasZone2: false, hasToneControl: true });
    const keys = (config.advancedControls ?? []).map((c) => c.key);
    expect(keys).toContain("toneControlEnabled");
    expect(keys).not.toContain("subwoofer");
  });

  it("advertises subwoofer/cinemaMode/cinemaEq/loudnessManagement when hasExtendedAudio is true", () => {
    const config = denonCapabilityConfig({ hasZone2: false, hasToneControl: false, hasExtendedAudio: true });
    const keys = (config.advancedControls ?? []).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["subwoofer", "cinemaMode", "cinemaEq", "loudnessManagement"]));
  });
});
