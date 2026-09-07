import { describe, expect, it } from "vitest";
import { recommend, casambiDriverIds, discoverableDrivers } from "./discover.js";
import type { DriverEntry } from "./api.js";

function driver(overrides: Partial<DriverEntry> = {}): DriverEntry {
  return {
    key: "supreme-casambi",
    name: "Supreme Casambi",
    description: "",
    category: "lighting",
    channel: "official",
    version: "1.0.0",
    publisher: "Supreme Domotics",
    capabilities: ["onoff"],
    protocols: ["casambi"],
    requiresSku: "pro",
    configSchema: [],
    dependencies: [],
    operations: [],
    installed: true,
    enabled: true,
    status: "active",
    installedId: "drv-1",
    config: {},
    ...overrides,
  };
}

// § Multi-network Casambi, Stage 3 — `recommend()` used to match a discovered device's
// (now runtime-scoped) `protocol` against a driver row's bare manifest `protocols` array, which
// can never find a match for any Casambi instance but the first ("casambi#<id>" is never in
// `["casambi"]`). `driverId` fixes this by carrying the real identity directly.
describe("recommend", () => {
  it("matches by driverId — exact, works identically for a single-instance driver", () => {
    const network1 = driver({ installedId: "drv-net1" });
    expect(recommend([network1], "drv-net1", "casambi")).toBe(network1);
  });

  it("matches a SECOND Casambi instance by driverId even though its protocol is runtime-scoped and would never match `protocols`", () => {
    const network1 = driver({ installedId: "drv-net1", label: null });
    const network2 = driver({ installedId: "drv-net2", label: "Network 2" });
    const registry = [network1, network2];

    // The bug this fixes: matching by protocol string alone finds NOTHING for network2, because
    // its runtime protocol ("casambi#drv-net2") is never in either row's bare `protocols: ["casambi"]`.
    expect(registry.find((d) => d.protocols.includes("casambi#drv-net2" as never))).toBeUndefined();

    // driverId sidesteps that entirely.
    expect(recommend(registry, "drv-net2", "casambi#drv-net2")).toBe(network2);
    expect(recommend(registry, "drv-net1", "casambi")).toBe(network1);
  });

  it("falls back to protocol matching when driverId is absent — backward compatible with every non-Casambi driver", () => {
    const knx = driver({ key: "supreme-knx", protocols: ["knx"], installedId: "drv-knx" });
    expect(recommend([knx], null, "knx")).toBe(knx);
    expect(recommend([knx], undefined, "knx")).toBe(knx);
  });

  it("returns undefined when neither driverId nor protocol resolves to anything", () => {
    expect(recommend([driver()], "drv-unknown", undefined)).toBeUndefined();
    expect(recommend([], "drv-1", "casambi")).toBeUndefined();
  });
});

// § Multi-network Casambi, Stage 3 — `casambiDriverIds()` (plural) replaces `casambiDriverId()`
// (singular), which only ever returned the FIRST selected Casambi driver — with two networks
// selected, the second one's groups were completely unreachable through Discover Devices.
describe("casambiDriverIds", () => {
  it("returns every SELECTED Casambi instance, not just the first", () => {
    const network1 = driver({ installedId: "drv-net1" });
    const network2 = driver({ installedId: "drv-net2", label: "Network 2" });
    const registry = [network1, network2];
    const selected = new Set(["drv-net1", "drv-net2"]);
    expect(casambiDriverIds(registry, selected)).toEqual(["drv-net1", "drv-net2"]);
  });

  it("excludes a Casambi instance that exists but was NOT selected for this scan", () => {
    const network1 = driver({ installedId: "drv-net1" });
    const network2 = driver({ installedId: "drv-net2", label: "Network 2" });
    const selected = new Set(["drv-net1"]); // network2 deselected
    expect(casambiDriverIds([network1, network2], selected)).toEqual(["drv-net1"]);
  });

  it("excludes non-Casambi drivers even when selected", () => {
    const knx = driver({ key: "supreme-knx", protocols: ["knx"], installedId: "drv-knx" });
    const casambi = driver({ installedId: "drv-net1" });
    const selected = new Set(["drv-knx", "drv-net1"]);
    expect(casambiDriverIds([knx, casambi], selected)).toEqual(["drv-net1"]);
  });

  it("returns an empty array with no Casambi driver installed or selected", () => {
    expect(casambiDriverIds([], new Set())).toEqual([]);
  });
});

describe("discoverableDrivers", () => {
  it("includes only installed, enabled drivers with a real installedId", () => {
    const ok = driver();
    const notInstalled = driver({ installedId: null, installed: false });
    const disabled = driver({ installedId: "drv-2", enabled: false });
    expect(discoverableDrivers([ok, notInstalled, disabled])).toEqual([ok]);
  });

  it("both instances of a multi-instance Casambi install are independently discoverable", () => {
    const network1 = driver({ installedId: "drv-net1" });
    const network2 = driver({ installedId: "drv-net2", label: "Network 2" });
    expect(discoverableDrivers([network1, network2])).toEqual([network1, network2]);
  });
});
