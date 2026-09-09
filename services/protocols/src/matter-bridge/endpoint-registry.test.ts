import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceId } from "@supreme/domain-model";
import {
  InMemoryMatterEndpointStore,
  FileMatterEndpointStore,
  MatterEndpointRegistry,
} from "./endpoint-registry.js";

describe("MatterEndpointRegistry", () => {
  it("allocates sequential, never-reused endpoint numbers starting at 1", () => {
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const a = registry.resolve("device-a" as DeviceId);
    const b = registry.resolve("device-b" as DeviceId);
    expect(a.endpointNumber).toBe(1);
    expect(b.endpointNumber).toBe(2);

    registry.remove("device-a" as DeviceId);
    const c = registry.resolve("device-c" as DeviceId);
    // §Endpoint architecture: freed numbers are never reissued to a different device.
    expect(c.endpointNumber).toBe(3);
  });

  it("resolve() is idempotent for an already-mapped device", () => {
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const first = registry.resolve("device-a" as DeviceId);
    const second = registry.resolve("device-a" as DeviceId);
    expect(second.endpointNumber).toBe(first.endpointNumber);
  });

  it("§ Matter Bridge Phase 2B — resolveButton() gives 4 buttons on the SAME keypad deviceId 4 DISTINCT endpoint numbers, never colliding on deviceId alone", () => {
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const btn1 = registry.resolveButton("keypad-a" as DeviceId, "btn1", 0x000f, "Button 1");
    const btn2 = registry.resolveButton("keypad-a" as DeviceId, "btn2", 0x000f, "Button 2");
    const btn3 = registry.resolveButton("keypad-a" as DeviceId, "btn3", 0x000f, "Button 3");
    const btn4 = registry.resolveButton("keypad-a" as DeviceId, "btn4", 0x000f, "Button 4");
    const numbers = [btn1, btn2, btn3, btn4].map((m) => m.endpointNumber);
    expect(new Set(numbers).size).toBe(4);
    for (const m of [btn1, btn2, btn3, btn4]) expect(m.deviceId).toBe("keypad-a");
  });

  it("resolveButton() is idempotent per (deviceId, controlId) pair, and a regular resolve() for the SAME deviceId (no controlId) stays a genuinely separate mapping", () => {
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const first = registry.resolveButton("keypad-a" as DeviceId, "btn1", 0x000f, "Button 1");
    const second = registry.resolveButton("keypad-a" as DeviceId, "btn1", 0x000f, "Button 1");
    expect(second.endpointNumber).toBe(first.endpointNumber);

    // The keypad device ITSELF (no controlId) — e.g. if it also declared a plain capability —
    // resolves to a genuinely different endpoint, never colliding with its own buttons.
    const deviceMapping = registry.resolve("keypad-a" as DeviceId);
    expect(deviceMapping.endpointNumber).not.toBe(first.endpointNumber);
  });

  it("removing one button leaves its sibling buttons on the SAME keypad untouched", () => {
    const registry = new MatterEndpointRegistry(new InMemoryMatterEndpointStore());
    const btn1 = registry.resolveButton("keypad-a" as DeviceId, "btn1", 0x000f, "Button 1");
    const btn2 = registry.resolveButton("keypad-a" as DeviceId, "btn2", 0x000f, "Button 2");
    registry.remove("keypad-a" as DeviceId, "btn1");
    expect(registry.all().find((m) => m.deviceId === "keypad-a" && m.controlId === "btn1")).toBeUndefined();
    const remaining = registry.all().find((m) => m.deviceId === "keypad-a" && m.controlId === "btn2");
    expect(remaining?.endpointNumber).toBe(btn2.endpointNumber);
  });
});

describe("FileMatterEndpointStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matter-bridge-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a mapping across a fresh store instance (restart simulation)", () => {
    const file = join(dir, "endpoints.json");
    const store1 = new FileMatterEndpointStore(file);
    const registry1 = new MatterEndpointRegistry(store1);
    const mapping = registry1.resolve("living-room-light" as DeviceId);

    // Simulate a process restart: brand-new store instance reading the same file.
    const store2 = new FileMatterEndpointStore(file);
    const registry2 = new MatterEndpointRegistry(store2);
    const resolved = registry2.resolve("living-room-light" as DeviceId);

    expect(resolved.endpointNumber).toBe(mapping.endpointNumber);
  });

  it("starts clean when no file exists yet", () => {
    const store = new FileMatterEndpointStore(join(dir, "does-not-exist.json"));
    expect(store.list()).toEqual([]);
  });

  it("§ Matter Bridge Phase 2B, Test M — persists 4 keypad button mappings across a fresh store instance, each keeping its own endpoint number (restart simulation)", () => {
    const file = join(dir, "endpoints.json");
    const store1 = new FileMatterEndpointStore(file);
    const registry1 = new MatterEndpointRegistry(store1);
    const before = ["btn1", "btn2", "btn3", "btn4"].map((id) => registry1.resolveButton("keypad-a" as DeviceId, id, 0x000f, `Button ${id}`));

    const store2 = new FileMatterEndpointStore(file);
    const registry2 = new MatterEndpointRegistry(store2);
    const after = ["btn1", "btn2", "btn3", "btn4"].map((id) => registry2.resolveButton("keypad-a" as DeviceId, id, 0x000f, `Button ${id}`));

    expect(after.map((m) => m.endpointNumber)).toEqual(before.map((m) => m.endpointNumber));
  });
});
