import { describe, expect, it } from "vitest";
import {
  albumArtUrl,
  buildAppCommandRequests,
  DEVICE_INFO_URL,
  MAIN_ZONE_STATUS_URL,
  parseDeletedSource,
  parseMainZoneStatus,
  parseRenameSource,
} from "./avr-http-codec.js";

// Fixture XML shapes mirror the REAL structure confirmed by fetching and reading
// `denonavr/input.py`'s actual parsing code this session — not guessed.
const RENAME_SOURCE_XML = `<?xml version="1.0" encoding="utf-8"?>
<rx>
  <cmd id="1" ...>
    <functionrename>
      <list>
        <name>SAT/CBL</name>
        <rename>DIRECTV</rename>
      </list>
      <list>
        <name>DVD</name>
        <rename>Blu-ray Player</rename>
      </list>
      <list>
        <name>AUX1</name>
        <rename>Turntable</rename>
      </list>
    </functionrename>
  </cmd>
</rx>`;

const DELETED_SOURCE_XML = `<?xml version="1.0" encoding="utf-8"?>
<rx>
  <cmd id="1" ...>
    <functiondelete>
      <list>
        <FuncName>TUNER</FuncName>
        <use>0</use>
      </list>
      <list>
        <FuncName>DVD</FuncName>
        <use>1</use>
      </list>
      <list>
        <FuncName>GAME</FuncName>
        <use>0</use>
      </list>
    </functiondelete>
  </cmd>
</rx>`;

describe("buildAppCommandRequests (§ Universal AVR SDK)", () => {
  it("builds the real <tx><cmd id=\"…\">…</cmd></tx> envelope confirmed via denonavr's actual request-body builder", () => {
    const [body] = buildAppCommandRequests([
      { id: "1", text: "GetRenameSource" },
      { id: "1", text: "GetDeletedSource" },
    ]);
    expect(body).toContain('<cmd id="1">GetRenameSource</cmd>');
    expect(body).toContain('<cmd id="1">GetDeletedSource</cmd>');
    expect(body).toMatch(/^<\?xml[^>]*\?><tx>.*<\/tx>$/);
  });

  it("chunks at the real 5-command-per-request cap instead of sending an oversized batch", () => {
    const commands = Array.from({ length: 12 }, (_, i) => ({ id: "1" as const, text: `Cmd${i}` }));
    const bodies = buildAppCommandRequests(commands);
    expect(bodies).toHaveLength(3); // 5 + 5 + 2
    expect((bodies[0]!.match(/<cmd /g) ?? []).length).toBe(5);
    expect((bodies[1]!.match(/<cmd /g) ?? []).length).toBe(5);
    expect((bodies[2]!.match(/<cmd /g) ?? []).length).toBe(2);
  });

  it("escapes XML-unsafe characters in command text rather than emitting malformed XML", () => {
    const [body] = buildAppCommandRequests([{ id: "1", text: "A & B < C > D" }]);
    expect(body).toContain("A &amp; B &lt; C &gt; D");
    expect(body).not.toContain("A & B < C > D");
  });

  it("returns an empty array for zero commands rather than an empty envelope", () => {
    expect(buildAppCommandRequests([])).toEqual([]);
  });
});

describe("parseRenameSource (§ Universal AVR SDK) — real shape from denonavr/input.py", () => {
  it("extracts every wire-token -> renamed-label pair", () => {
    const renamed = parseRenameSource(RENAME_SOURCE_XML);
    expect(renamed.get("SAT/CBL")).toBe("DIRECTV");
    expect(renamed.get("DVD")).toBe("Blu-ray Player");
    expect(renamed.get("AUX1")).toBe("Turntable");
    expect(renamed.size).toBe(3);
  });

  it("an input the receiver never renamed simply doesn't appear — callers keep their own default label", () => {
    const renamed = parseRenameSource(RENAME_SOURCE_XML);
    expect(renamed.has("TUNER")).toBe(false);
  });

  it("returns an empty map for XML with no functionrename section, never throws", () => {
    expect(parseRenameSource("<rx><cmd id=\"1\"></cmd></rx>").size).toBe(0);
  });

  it("returns an empty map for garbage input rather than throwing", () => {
    expect(parseRenameSource("not xml at all").size).toBe(0);
  });
});

describe("parseDeletedSource (§ Universal AVR SDK) — real shape from denonavr/input.py", () => {
  it("collects only the inputs marked use=\"0\" (hidden) — use=\"1\" stays visible", () => {
    const deleted = parseDeletedSource(DELETED_SOURCE_XML);
    expect(deleted.has("TUNER")).toBe(true);
    expect(deleted.has("GAME")).toBe(true);
    expect(deleted.has("DVD")).toBe(false);
    expect(deleted.size).toBe(2);
  });

  it("returns an empty set for XML with no functiondelete section, never throws", () => {
    expect(parseDeletedSource("<rx><cmd id=\"1\"></cmd></rx>").size).toBe(0);
  });
});

describe("albumArtUrl (§ Universal AVR SDK) — a literal URL builder, no XML/schema involved", () => {
  it("builds the real, confirmed-static album-art path", () => {
    expect(albumArtUrl("192.168.1.50", 8080)).toBe("http://192.168.1.50:8080/img/album%20art_S.png");
  });
});

// Fixture mirrors the REAL <ParentTag><value>TEXT</value></ParentTag> shape confirmed
// via denonavr's own `./Power/value`-style search strings in foundation.py/volume.py/
// input.py — built from scratch against that confirmed field list, not copied from any
// third-party cheat sheet (see docs/architecture/Denon-CheatSheet-Audit.md).
const MAIN_ZONE_STATUS_XML = `<?xml version="1.0" encoding="utf-8" ?>
<item>
<Power><value>ON</value></Power>
<ZonePower><value>ON</value></ZonePower>
<InputFuncSelect><value>DVD</value></InputFuncSelect>
<MasterVolume><value>-28.0</value></MasterVolume>
<Mute><value>off</value></Mute>
</item>`;

describe("DEVICE_INFO_URL / MAIN_ZONE_STATUS_URL (§ Denon Cheat Sheet Audit) — real, independently confirmed via denonavr/const.py", () => {
  it("are the real static paths, not guessed", () => {
    expect(DEVICE_INFO_URL).toBe("/goform/Deviceinfo.xml");
    expect(MAIN_ZONE_STATUS_URL).toBe("/goform/formMainZone_MainZoneXml.xml");
  });
});

describe("parseMainZoneStatus (§ Denon Cheat Sheet Audit) — real shape from denonavr/foundation.py, volume.py, input.py", () => {
  it("extracts power, mute, volume (dB), and current input from the legacy full-zone-state snapshot", () => {
    const status = parseMainZoneStatus(MAIN_ZONE_STATUS_XML);
    expect(status).toEqual({ power: "ON", muted: false, volumeDb: -28.0, input: "DVD" });
  });

  it("falls back to ZonePower when Power is absent", () => {
    const xml = `<item><ZonePower><value>STANDBY</value></ZonePower></item>`;
    expect(parseMainZoneStatus(xml).power).toBe("STANDBY");
  });

  it("returns null fields (never fabricated defaults) for a document with none of the confirmed tags", () => {
    expect(parseMainZoneStatus("<item></item>")).toEqual({ power: null, muted: null, volumeDb: null, input: null });
  });

  it("treats an empty <value></value> as absent, not as an empty string", () => {
    const xml = `<item><InputFuncSelect><value></value></InputFuncSelect></item>`;
    expect(parseMainZoneStatus(xml).input).toBeNull();
  });

  it("returns all-null fields for garbage input rather than throwing", () => {
    expect(() => parseMainZoneStatus("not xml at all")).not.toThrow();
    expect(parseMainZoneStatus("not xml at all").power).toBeNull();
  });

  it("mute value comparison is case-insensitive, matching denonavr's own STATE_ON check", () => {
    const xml = `<item><Mute><value>ON</value></Mute></item>`;
    expect(parseMainZoneStatus(xml).muted).toBe(true);
  });
});
