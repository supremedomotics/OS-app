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
});
