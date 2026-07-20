import { describe, expect, it } from "vitest";
import { normalizeLocationName, resolveRoomAssignment, UNASSIGNED_ROOM_NAME } from "./room-assignment-engine.js";

describe("normalizeLocationName", () => {
  it("strips the product spec's own worked examples exactly", () => {
    expect(normalizeLocationName("Living Room AVR")).toBe("Living Room");
    expect(normalizeLocationName("Living AVR")).toBe("Living");
    expect(normalizeLocationName("Conference Zone2")).toBe("Conference");
    expect(normalizeLocationName("Bedroom Receiver")).toBe("Bedroom");
    expect(normalizeLocationName("Theater AVR")).toBe("Theater");
  });

  it("strips a leading brand token as well as a trailing category token", () => {
    expect(normalizeLocationName("Yamaha Media Room")).toBe("Media Room");
    expect(normalizeLocationName("Denon Living Room AVR")).toBe("Living Room");
  });

  it("leaves an interior word alone — only leading/trailing noise is stripped", () => {
    expect(normalizeLocationName("Main Street Loft")).toBe("Main Street Loft");
  });

  it("returns empty when every token is noise", () => {
    expect(normalizeLocationName("AVR")).toBe("");
    expect(normalizeLocationName("Zone2")).toBe("");
    expect(normalizeLocationName("Yamaha Receiver")).toBe("");
  });

  it("is a no-op for a name with no noise words", () => {
    expect(normalizeLocationName("Kitchen")).toBe("Kitchen");
  });
});

describe("resolveRoomAssignment — confidence tiers", () => {
  it("tier 100 (explicit_attribute): always auto-assigns, even a single-word name", () => {
    const d = resolveRoomAssignment({ raw: "Kitchen", source: "explicit_attribute" }, []);
    expect(d).toEqual({ kind: "assign", roomName: "Kitchen", isNewRoom: true, confidence: 100, source: "explicit_attribute" });
  });

  it("tier 90 (persistent_user_zone_name): auto-assigns a HEOS/MusicCast zone name verbatim, no stripping", () => {
    const d = resolveRoomAssignment({ raw: "Conference", source: "persistent_user_zone_name" }, []);
    expect(d).toMatchObject({ kind: "assign", roomName: "Conference", confidence: 90, isNewRoom: true });
  });

  it("tier 70 (friendly_name_heuristic): auto-assigns after normalization", () => {
    const d = resolveRoomAssignment({ raw: "Living Room AVR", source: "friendly_name_heuristic" }, []);
    expect(d).toMatchObject({ kind: "assign", roomName: "Living Room", confidence: 70, isNewRoom: true });
  });

  it("reuses an already-existing room by case-insensitive name match instead of creating a duplicate", () => {
    const d = resolveRoomAssignment({ raw: "living room avr", source: "friendly_name_heuristic" }, ["Living Room", "Kitchen"]);
    expect(d).toMatchObject({ kind: "assign", roomName: "Living Room", isNewRoom: false });
  });

  it("below-threshold heuristic (pure noise) never guesses — goes to Unassigned with the raw hint suggested", () => {
    const d = resolveRoomAssignment({ raw: "AVR", source: "friendly_name_heuristic" }, []);
    expect(d).toEqual({ kind: "unassigned", suggestedRoomName: "AVR", confidence: 70 });
  });

  it("a bare IP/id left after normalization is never treated as a room name", () => {
    const d = resolveRoomAssignment({ raw: "AVR 192.168.1.50", source: "friendly_name_heuristic" }, []);
    expect(d.kind).toBe("unassigned");
  });

  it("no hint at all → unassigned with no suggestion", () => {
    expect(resolveRoomAssignment(null, ["Kitchen"])).toEqual({ kind: "unassigned", suggestedRoomName: null, confidence: 0 });
    expect(resolveRoomAssignment(undefined, [])).toEqual({ kind: "unassigned", suggestedRoomName: null, confidence: 0 });
  });

  it("an empty/whitespace-only hint is treated the same as no hint", () => {
    expect(resolveRoomAssignment({ raw: "   ", source: "explicit_attribute" }, [])).toEqual({
      kind: "unassigned",
      suggestedRoomName: null,
      confidence: 0,
    });
  });
});

describe("UNASSIGNED_ROOM_NAME", () => {
  it("is the fixed, well-known bucket name from the product spec", () => {
    expect(UNASSIGNED_ROOM_NAME).toBe("Unassigned Devices");
  });
});
