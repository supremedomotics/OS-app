import { describe, expect, it, vi } from "vitest";
import { discoverAll } from "./coolmaster-discovery.js";
import type { CoolMasterConnection } from "./coolmaster-connection.js";
import type { CoolMasterGatewayInfo, CoolMasterUnitStatus } from "./coolmaster-types.js";

/**
 * § Friendly Name Discovery / Discovery Safety — isolated tests for `discoverAll`'s own
 * orchestration (props alongside units/lines/secondary devices), using a minimal fake
 * `CoolMasterConnection` rather than a real TCP fixture. This is the one place that can
 * assert things like "a props failure never fails the whole discovery pass" and "props is
 * never called when includeNames is false" precisely, without depending on (or bloating)
 * the shared full-stack fake-gateway harness `coolmaster-driver.test.ts` already uses for
 * control/feedback coverage.
 */

const gateway: CoolMasterGatewayInfo = { serial: "GW-1", firmwareVersion: "1.0", application: null, host: "127.0.0.1" };

function unit(uid: string): CoolMasterUnitStatus {
  return {
    uid,
    line: "L1",
    on: false,
    setpointC: 22,
    roomC: 21,
    mode: null,
    fanSpeed: null,
    swing: null,
    filterWarning: null,
    demand: null,
    faultCode: null,
    locked: null,
    inhibited: null,
    exitCode: "OK",
    source: "ascii",
  };
}

function fakeConnection(opts: {
  units: CoolMasterUnitStatus[];
  ascii: (command: string) => Promise<string[]>;
}): CoolMasterConnection {
  return {
    gatewayInfo: () => gateway,
    getUnitStatuses: async () => opts.units,
    executeAscii: opts.ascii,
  } as unknown as CoolMasterConnection;
}

describe("discoverAll — friendly names (§ Friendly Name Discovery)", () => {
  it("a props failure does NOT fail the whole discovery pass — units still come back, propNames is simply empty", async () => {
    const ascii = vi.fn(async (cmd: string) => {
      if (cmd === "props") throw new Error("simulated: props unsupported on this gateway");
      return [];
    });
    const conn = fakeConnection({ units: [unit("L1.100")], ascii });
    const result = await discoverAll(conn, undefined, { enrichWithQuery: false });
    expect(result.units).toHaveLength(1);
    expect(result.propNames.size).toBe(0);
  });

  it("a unit with no props entry is still discovered — props never gates which units exist", async () => {
    const ascii = vi.fn(async (cmd: string) => (cmd === "props" ? ["L1.101 name Kitchen"] : []));
    const conn = fakeConnection({ units: [unit("L1.100"), unit("L1.101")], ascii });
    const result = await discoverAll(conn, undefined, { enrichWithQuery: false });
    expect(result.units.map((u) => u.uid).sort()).toEqual(["L1.100", "L1.101"]);
    expect(result.propNames.get("L1.101")).toBe("Kitchen");
    expect(result.propNames.has("L1.100")).toBe(false); // unnamed, but still a discovered unit above
  });

  it("duplicate NAME VALUES across different UIDs are allowed — names aren't required to be unique", async () => {
    const ascii = vi.fn(async (cmd: string) => (cmd === "props" ? ["L1.100 name Office", "L1.101 name Office"] : []));
    const conn = fakeConnection({ units: [unit("L1.100"), unit("L1.101")], ascii });
    const result = await discoverAll(conn, undefined, { enrichWithQuery: false });
    expect(result.propNames.get("L1.100")).toBe("Office");
    expect(result.propNames.get("L1.101")).toBe("Office");
  });

  it("names with punctuation are preserved verbatim", async () => {
    const ascii = vi.fn(async (cmd: string) => (cmd === "props" ? ["L1.100 name Mom's Room - Upstairs"] : []));
    const conn = fakeConnection({ units: [unit("L1.100")], ascii });
    const result = await discoverAll(conn, undefined, { enrichWithQuery: false });
    expect(result.propNames.get("L1.100")).toBe("Mom's Room - Upstairs");
  });

  it("includeNames: false never calls props at all — the per-command secondary-device refresh path", async () => {
    const ascii = vi.fn(async () => []);
    const conn = fakeConnection({ units: [unit("L1.100")], ascii });
    await discoverAll(conn, undefined, { enrichWithQuery: false, includeNames: false });
    expect(ascii).not.toHaveBeenCalledWith("props");
  });

  it("includeNames defaulted (true) DOES call props during a full discovery pass", async () => {
    const ascii = vi.fn(async () => []);
    const conn = fakeConnection({ units: [unit("L1.100")], ascii });
    await discoverAll(conn, undefined, { enrichWithQuery: false });
    expect(ascii).toHaveBeenCalledWith("props");
  });
});

describe("discoverAll — duplicate UID within a single gateway's own response (§ Discovery Safety)", () => {
  it("a malformed ls2 response reporting the same UID twice never throws — discovery still completes", async () => {
    const ascii = vi.fn(async () => []);
    const conn = fakeConnection({ units: [unit("L1.100"), { ...unit("L1.100"), on: true }], ascii });
    await expect(discoverAll(conn, undefined, { enrichWithQuery: false })).resolves.toBeDefined();
  });
});
