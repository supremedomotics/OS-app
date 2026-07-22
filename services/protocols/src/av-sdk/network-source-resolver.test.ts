import { describe, expect, it } from "vitest";
import { HEOS_SOURCE_LABELS, resolveHeosSourceLabel } from "./network-source-resolver.js";

describe("resolveHeosSourceLabel", () => {
  it("resolves a mapped sid to its real service name (song-type media)", () => {
    expect(resolveHeosSourceLabel({ sourceId: 4, type: "song" })).toBe("Spotify");
    expect(resolveHeosSourceLabel({ sourceId: 10, type: "song" })).toBe("Tidal");
    expect(resolveHeosSourceLabel({ sourceId: 1024, type: "song" })).toBe("Local Music");
  });

  it("prefers the specific station name over the generic TuneIn service label", () => {
    expect(resolveHeosSourceLabel({ sourceId: 3, type: "station", station: "Jazz FM" })).toBe("Jazz FM");
  });

  it("falls back to the sid label when a station-type response has no station name", () => {
    expect(resolveHeosSourceLabel({ sourceId: 3, type: "station", station: null })).toBe("TuneIn");
  });

  it("returns null (never a guess) for an unmapped sid", () => {
    expect(resolveHeosSourceLabel({ sourceId: 9999, type: "song" })).toBeNull();
  });

  it("returns null when nothing is present at all", () => {
    expect(resolveHeosSourceLabel({})).toBeNull();
    expect(resolveHeosSourceLabel({ sourceId: null, type: null, station: null })).toBeNull();
  });

  it("does not include a label for sid 0 (aggregator id, not a displayable service)", () => {
    expect(HEOS_SOURCE_LABELS[0]).toBeUndefined();
  });
});
