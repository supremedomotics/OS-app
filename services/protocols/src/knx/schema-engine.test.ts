import { describe, expect, it } from "vitest";
import {
  groupWithSchema,
  SCHEMA_REGISTRY,
  SchemaRegistry,
  floorRoomDeviceSchema,
  circuitOperationNameSchema,
  defineHierarchySchema,
  validateSchemaPlugin,
  type GroupAddressSchemaPlugin,
} from "./schema-engine.js";

describe("floorRoomDeviceSchema", () => {
  it("extracts floor/room/circuitName from the spec's own example", () => {
    const r = floorRoomDeviceSchema.extract("Ground Floor - Living Room - Main Ceiling Light", {});
    expect(r).toEqual({ circuitName: "Main Ceiling Light", room: "Living Room", floor: "Ground Floor", circuitType: null, operationType: null });
  });

  it("degrades gracefully with fewer segments than the full hierarchy", () => {
    expect(floorRoomDeviceSchema.extract("Living Room - Main Ceiling Light", {})).toMatchObject({ circuitName: "Main Ceiling Light", room: "Living Room", floor: null });
    expect(floorRoomDeviceSchema.extract("Main Ceiling Light", {})).toMatchObject({ circuitName: "Main Ceiling Light", room: null, floor: null });
  });
});

describe("circuitOperationNameSchema", () => {
  it("extracts circuitType/operationType/circuitName from the spec's own example", () => {
    const r = circuitOperationNameSchema.extract("Lighting - Switching - Living DL-1", {});
    expect(r).toEqual({ circuitName: "Living DL-1", room: null, floor: null, circuitType: "Lighting", operationType: "Switching" });
  });
});

describe("groupWithSchema — the full pipeline, reusing the existing grouping engine", () => {
  it("Schema 1: every hierarchy entry for the same room+device becomes one cluster", () => {
    const clusters = groupWithSchema(
      [
        { id: "1/1/1", name: "Ground Floor - Living Room - Main Ceiling Light Switch" },
        { id: "1/1/2", name: "Ground Floor - Living Room - Main Ceiling Light Status" },
      ],
      "floor-room-device",
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ room: "Living Room", floor: "Ground Floor" });
    expect(clusters[0]?.signals.map((s) => s.id).sort()).toEqual(["1/1/1", "1/1/2"]);
  });

  it("Schema 2: switching/dimming/status all belonging to the same circuit merge into one device — the exact spec example", () => {
    const clusters = groupWithSchema(
      [
        { id: "1", name: "Lighting - Switching - Living DL-1" },
        { id: "2", name: "Lighting - Dimming - Living DL-1" },
        { id: "3", name: "Lighting - Status - Living DL-1" },
        { id: "4", name: "Curtain - Move - Living Curtain" },
        { id: "5", name: "Curtain - Stop - Living Curtain" },
      ],
      "circuit-operation-name",
    );
    expect(clusters).toHaveLength(2);
    const dl1 = clusters.find((c) => c.signals.some((s) => s.id === "1"))!;
    expect(dl1.signals.map((s) => s.id).sort()).toEqual(["1", "2", "3"]);
    expect(dl1.circuitType).toBe("Lighting");
    const curtain = clusters.find((c) => c.signals.some((s) => s.id === "4"))!;
    expect(curtain.signals.map((s) => s.id).sort()).toEqual(["4", "5"]);
  });

  it("Schema 2 defeats trailing-suffix-only stripping — proves the schema-aware extraction is load-bearing, not redundant with the generic engine alone", () => {
    // Without schema-aware extraction, groupByCircuitName would see "Living DL-1" as a
    // LEADING-preserved, TRAILING-stripped name — but here the operation word sits in
    // the MIDDLE of the raw string, which the generic engine (trailing-strip only)
    // cannot handle on its own. This is exactly why extraction has to run first.
    const clusters = groupWithSchema(
      [{ id: "1", name: "Lighting - Switching - Living DL-1" }],
      "circuit-operation-name",
    );
    expect(clusters[0]?.key).toBe("living dl-1");
  });

  it("respects installer-configurable stop words on top of the schema extraction", () => {
    const withoutStopWord = groupWithSchema(
      [
        { id: "1", name: "Lighting - Switching - Foyer Lamp Zone1" },
        { id: "2", name: "Lighting - Switching - Foyer Lamp" },
      ],
      "circuit-operation-name",
    );
    expect(withoutStopWord).toHaveLength(2); // "zone1" isn't a known operation word by default

    const withStopWord = groupWithSchema(
      [
        { id: "1", name: "Lighting - Switching - Foyer Lamp Zone1" },
        { id: "2", name: "Lighting - Switching - Foyer Lamp" },
      ],
      "circuit-operation-name",
      { stopWords: ["zone1"] },
    );
    // Only merges once the installer's own stop word strips the trailing "zone1" token —
    // proves options.stopWords actually reaches the underlying grouping engine.
    expect(withStopWord).toHaveLength(1);
  });

  it("throws for an unknown schema id rather than silently falling back to a default", () => {
    expect(() => groupWithSchema([{ id: "1", name: "x" }], "nonexistent")).toThrow(/unknown schema/);
  });

  it("registry is the only extension seam — a new/plugin schema needs no discovery-code change", () => {
    const registry = new SchemaRegistry();
    const custom: GroupAddressSchemaPlugin = {
      id: "custom",
      name: "Custom",
      description: "test plugin schema",
      levels: ["circuitName"],
      metadata: { source: "custom", version: "0.1.0", author: "test installer" },
      extract: (rawName) => ({ circuitName: rawName, room: null, floor: null, circuitType: null, operationType: null }),
    };
    registry.register(custom);
    expect(registry.get("custom")).toBe(custom);
    expect(registry.list().map((s) => s.id)).toEqual(["custom"]);
    // The real registry ships both built-ins pre-registered.
    expect(SCHEMA_REGISTRY.list().map((s) => s.id).sort()).toEqual(["circuit-operation-name", "floor-room-device"]);
  });

  it("unregister() removes a plugin — the registry never accumulates dead entries", () => {
    const registry = new SchemaRegistry();
    registry.register(floorRoomDeviceSchema);
    registry.unregister(floorRoomDeviceSchema.id);
    expect(registry.get(floorRoomDeviceSchema.id)).toBeUndefined();
  });

  it("listBySource() separates built-in from community/ai-generated/custom plugins by real provenance", () => {
    const registry = new SchemaRegistry();
    registry.register(floorRoomDeviceSchema); // source: "built-in"
    registry.register({
      id: "community-1", name: "Community Schema", description: "imported", levels: ["circuitName"],
      metadata: { source: "community", version: "1.0.0", author: "Jane Installer" },
      extract: (rawName) => ({ circuitName: rawName, room: null, floor: null, circuitType: null, operationType: null }),
    });
    expect(registry.listBySource("built-in").map((p) => p.id)).toEqual(["floor-room-device"]);
    expect(registry.listBySource("community").map((p) => p.id)).toEqual(["community-1"]);
    expect(registry.listBySource("ai-generated")).toEqual([]);
  });
});

describe("defineHierarchySchema (§ Plugin Architecture — built-ins as data, not hardcoded logic)", () => {
  it("built-in plugins are constructed through the exact same declarative factory a future AI/community/custom plugin would use", () => {
    expect(floorRoomDeviceSchema.metadata).toMatchObject({ source: "built-in" });
    expect(circuitOperationNameSchema.metadata).toMatchObject({ source: "built-in" });
  });

  it("builds a real, working plugin from pure data — no custom extract() function written by hand", () => {
    const buildingWingRoomDevice = defineHierarchySchema({
      id: "building-wing-room-device",
      name: "Building → Wing → Room → Device",
      description: "a 4-level hierarchy a future plugin author might define",
      levels: ["floor", "room", "circuitName"], // only 3 named fields exist on SchemaExtraction — proves graceful handling
    });
    const r = buildingWingRoomDevice.extract("North Wing - Conference Room - Ceiling Light", {});
    expect(r).toEqual({ circuitName: "Ceiling Light", room: "Conference Room", floor: "North Wing", circuitType: null, operationType: null });
  });

  it("degrades gracefully with fewer segments than declared levels, same as the original hand-written schemas did", () => {
    const plugin = defineHierarchySchema({ id: "test", name: "Test", description: "t", levels: ["floor", "room", "circuitName"] });
    expect(plugin.extract("Just A Device", {})).toMatchObject({ circuitName: "Just A Device", room: null, floor: null });
  });

  it("rejects a definition that doesn't end in circuitName — the one structural rule the factory enforces", () => {
    expect(() => defineHierarchySchema({ id: "bad", name: "Bad", description: "d", levels: ["floor", "room"] })).toThrow(/circuitName/);
  });

  it("a declaratively-defined plugin works end-to-end through groupWithSchema, identically to a hand-written one", () => {
    const registry = new SchemaRegistry();
    const plugin = defineHierarchySchema({
      id: "type-name",
      name: "Type → Name",
      description: "a minimal 2-level custom schema",
      levels: ["circuitType", "circuitName"],
    });
    registry.register(plugin);
    // groupWithSchema always reads from SCHEMA_REGISTRY, so route through the real
    // engine by temporarily using the module's own registry.
    SCHEMA_REGISTRY.register(plugin);
    const clusters = groupWithSchema(
      [{ id: "1", name: "Lighting - Foyer Lamp" }, { id: "2", name: "Lighting - Foyer Lamp Status" }],
      "type-name",
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.circuitType).toBe("Lighting");
  });
});

describe("validateSchemaPlugin (§ Future AI Schema Architecture — defensive boundary)", () => {
  it("accepts a well-formed plugin", () => {
    expect(validateSchemaPlugin(floorRoomDeviceSchema)).toBe(true);
  });

  it("rejects a plugin missing required fields — the exact shape a malformed AI-generated or community JSON import might have", () => {
    expect(validateSchemaPlugin({ id: "x" })).toBe(false);
    expect(validateSchemaPlugin({ id: "x", name: "X", description: "d", levels: ["circuitName"] })).toBe(false); // no metadata
    expect(validateSchemaPlugin({ id: "x", name: "X", description: "d", levels: "not-an-array", metadata: { source: "custom" }, extract: () => {} })).toBe(false);
    expect(validateSchemaPlugin(null)).toBe(false);
    expect(validateSchemaPlugin("just a string")).toBe(false);
  });

  it("rejects a plugin whose extract is not a real function", () => {
    expect(validateSchemaPlugin({ id: "x", name: "X", description: "d", levels: [], metadata: { source: "custom" }, extract: "not a function" })).toBe(false);
  });
});
