import { describe, expect, it } from "vitest";
import { assignRoom } from "./room-assignment.js";
import { mapUnifiedDevices } from "./unified-device-mapper.js";

describe("assignRoom", () => {
  it("user override always wins", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light", room: "Kitchen" }] })[0]!;
    const result = assignRoom({ device, userOverrideRoom: "Chef's Kitchen" });
    expect(result).toMatchObject({ room: "Chef's Kitchen", source: "user" });
  });

  it("falls to ETS room when no override is given", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Light", room: "Kitchen" }] })[0]!;
    expect(assignRoom({ device })).toMatchObject({ room: "Kitchen", source: "ets" });
  });

  it("falls to existing room mapping when a shared communication object was already assigned", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Living Room Light" }] })[0]!;
    const result = assignRoom({ device, existingRoomByObjectId: { "1/1/1": "Living Room" } });
    expect(result).toMatchObject({ room: "Living Room", source: "existing_room_mapping" });
  });

  it("falls to AI inference only after every real source is exhausted", () => {
    // "Light" alone (no prefix) — the Universal Device Intelligence Engine's name-based
    // room inference correctly finds nothing preceding the matched type, so this still
    // exercises "no real source resolves a room" rather than accidentally supplying one.
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Light" }] })[0]!;
    const result = assignRoom({ device, aiInference: () => "Study" });
    expect(result).toMatchObject({ room: "Study", source: "ai_inference" });
  });

  it("extracts the room from the device name when no other source provides one (§ Additional Enhancement)", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "R&D Downlight" }] })[0]!;
    const result = assignRoom({ device });
    expect(result).toMatchObject({ room: "R&D", source: "circuit_intelligence" });
    expect(result.reason).toContain("Downlight");
  });

  // § Live-reproduced bug fix — a real ETS project's "Conference Hanging" lighting circuit
  // (a DIN-rail DALI actuator physically mounted in a distribution board) resolved to room
  // "DB" instead of "Conference", because ETS's own location metadata records where the
  // actuator hardware sits, not where the circuit it controls belongs — and that metadata
  // unconditionally won over the device's own name. Skipping technical/utility room names
  // from ETS/KNX-IoT lets circuit_intelligence (name-based inference) supply the right
  // answer instead, without weakening ETS as a source for a device whose ETS location
  // genuinely IS a real room (the "falls to ETS room" test above).
  it("skips a technical/utility ETS room name (distribution board) so name-based inference supplies the real room", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Conference Hanging", room: "DB" }] })[0]!;
    const result = assignRoom({ device });
    expect(result).toMatchObject({ room: "Conference", source: "circuit_intelligence" });
  });

  it("skips a German-language technical ETS room name (Verteiler) the same way", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Kitchen Downlight", room: "Verteiler" }] })[0]!;
    const result = assignRoom({ device });
    expect(result).toMatchObject({ room: "Kitchen", source: "circuit_intelligence" });
  });

  it("a technical ETS room name does not block the existing-room-mapping source either", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Light", room: "DB" }] })[0]!;
    const result = assignRoom({ device, existingRoomByObjectId: { "1/1/1": "Conference" } });
    expect(result).toMatchObject({ room: "Conference", source: "existing_room_mapping" });
  });

  it("never fabricates a room — unassigned when nothing resolves it", () => {
    // "Light" alone (no prefix) — the Universal Device Intelligence Engine's name-based
    // room inference correctly finds nothing preceding the matched type, so this still
    // exercises "no real source resolves a room" rather than accidentally supplying one.
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Light" }] })[0]!;
    expect(assignRoom({ device })).toMatchObject({ room: null, source: "unassigned" });
  });
});
