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
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Some Light" }] })[0]!;
    const result = assignRoom({ device, aiInference: () => "Study" });
    expect(result).toMatchObject({ room: "Study", source: "ai_inference" });
  });

  it("never fabricates a room — unassigned when nothing resolves it", () => {
    const device = mapUnifiedDevices({ ets: [{ id: "1/1/1", name: "Some Light" }] })[0]!;
    expect(assignRoom({ device })).toMatchObject({ room: null, source: "unassigned" });
  });
});
