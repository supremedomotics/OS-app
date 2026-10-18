/**
 * Shared behavioural contract for the four-method `KnxConnection` seam (§ Clean-room KNX stack — Stage 4). One table of behaviours, executed
 * against the LEGACY wrapper and against NativeKnxConnection by knx-connection.contract.test.ts. Where the two implementations are known to
 * differ the case asserts BOTH sides explicitly ("legacy: …, native: …") and carries its classification — nothing is skipped or loosened to
 * get a green run, and no case is written to pass on one side only by accident.
 *
 * Classification vocabulary used below:
 *   SPEC        the native behaviour follows the KNX specification text the project holds / cites (stated per case);
 *   INTENTIONAL a deliberate native decision that no specification forces — compatible with the production driver's own decoders;
 *   LEGACY-DEFECT the legacy behaviour is wrong for SupremeOS regardless of spec (publishes garbage, fabricates feedback, aborts siblings).
 * Evidence for the legacy side of D3 and D5–D8 is knxultimate 6.0.1 source/library output, not a live bus (see contract-harnesses.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { KnxValue } from "../../../knx-codec.js";
import { legacyAvailable, legacyHarness, nativeHarness, type ContractHarness } from "./contract-harnesses.js";

const ROUND_TRIPS: Array<[string, KnxValue]> = [
  ["DPT1.001", true], ["DPT1.001", false], ["DPT1.100", true],
  ["DPT5.001", 0], ["DPT5.001", 60], ["DPT5.001", 100], ["DPT5.010", 200],
  ["DPT9.001", 21.5], ["DPT9.001", -5.5], ["DPT7.600", 3000], ["DPT20.102", 3], ["DPT20.105", 2],
  ["DPT232.600", { red: 255, green: 0, blue: 128 }],
  ["DPT251.600", { red: 1, green: 2, blue: 3, white: 4, mR: 1, mG: 1, mB: 1, mW: 0 }],
];

export function defineKnxConnectionContract(label: "legacy" | "native", make: () => ContractHarness): void {
  describe.skipIf(label === "legacy" && !legacyAvailable)(`KnxConnection contract — ${label}`, () => {
    let h: ContractHarness;
    const start = async (): Promise<ContractHarness> => { h = make(); await h.connect(); return h; };
    afterEach(async () => { await h?.close(); });
    const native = (): boolean => h.name === "native";

    // ------------------------------------------------------------------------------------------------------------ writes
    it.each(ROUND_TRIPS)("write %s %j puts exactly that value for that DPT on the wire", async (dpt, value) => {
      await start();
      await h.write("1/2/3", value, dpt);
      expect(h.wire()).toEqual([{ ga: "1/2/3", value, dpt }]);
    });

    it("20 simultaneous writes are all sent, once each, in call order", async () => {
      await start();
      const ps = Array.from({ length: 20 }, (_, i) => h.write(`3/0/${i}`, i, "DPT5.010"));
      await Promise.all(ps);
      expect(h.wire().map((x) => x.ga)).toEqual(Array.from({ length: 20 }, (_, i) => `3/0/${i}`));
      expect(h.wire().map((x) => x.value)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    // ------------------------------------------------------------------------------------------------------------ observers
    it.each(ROUND_TRIPS)("observe delivers a device's GroupValueWrite and GroupValueResponse decoded as %s %j", async (dpt, value) => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", dpt, (v) => got.push(v));
      await h.deviceWrites("1/1/1", dpt, value);
      await h.deviceResponds("1/1/1", dpt, value);
      expect(got).toEqual([value, value]);
    });

    it("observers are per group address", async () => {
      await start();
      const a: KnxValue[] = []; const b: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT1.001", (v) => a.push(v));
      h.connection.observe("1/1/2", "DPT1.001", (v) => b.push(v));
      await h.deviceWrites("1/1/2", "DPT1.001", true);
      expect(a).toEqual([]);
      expect(b).toEqual([true]);
    });

    it("two observers on one GA both run; unsubscribing one (twice) leaves the other; an early unsubscribe is never called", async () => {
      await start();
      const a: KnxValue[] = []; const b: KnxValue[] = []; const never: KnxValue[] = [];
      const offA = h.connection.observe("1/1/1", "DPT9.001", (v) => a.push(v));
      h.connection.observe("1/1/1", "DPT9.001", (v) => b.push(v));
      h.connection.observe("1/1/1", "DPT9.001", (v) => never.push(v))();
      await h.deviceWrites("1/1/1", "DPT9.001", 20);
      offA(); offA();
      await h.deviceWrites("1/1/1", "DPT9.001", 21);
      expect(a).toEqual([20]);
      expect(b).toEqual([20, 21]);
      expect(never).toEqual([]);
    });

    // ------------------------------------------------------------------------------------------------------------ lifecycle
    it("a failed connect leaves nothing behind (no listener, timer, socket or half-open client)", async () => {
      h = make();
      h.failNextConnect();
      await expect(h.connect()).rejects.toBeDefined();
      expect(h.failedConnectResidue()).toBe(0);
    });

    // ------------------------------------------------------------------------------------------------------------ KNOWN DIFFERENCES (both sides asserted)
    it("D5 handler isolation — a throwing handler: legacy aborts delivery to the others and the error escapes into the transport; native isolates it [LEGACY-DEFECT]", async () => {
      await start();
      const second: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT1.001", () => { throw new Error("handler bug"); });
      h.connection.observe("1/1/1", "DPT1.001", (v) => second.push(v));
      await h.deviceWrites("1/1/1", "DPT1.001", true);
      if (native()) { expect(second).toEqual([true]); expect(h.escapedErrors()).toEqual([]); }
      else { expect(second).toEqual([]); expect(h.escapedErrors()).toHaveLength(1); }
    });

    it("D6 after disconnect() — legacy keeps its observers registered and would still deliver; native releases them [INTENTIONAL, deterministic cleanup]", async () => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT1.001", (v) => got.push(v));
      await h.disconnect();
      await h.deviceWrites("1/1/1", "DPT1.001", true);
      expect(got).toEqual(native() ? [] : [true]);
    });

    it("D7 the connection's own write is NOT feedback — legacy delivers the library's echo of it to observers; native never does [LEGACY-DEFECT: infers state from transport acceptance]", async () => {
      await start();
      const echoes: KnxValue[] = [];
      h.connection.observe("1/0/1", "DPT1.001", (v) => echoes.push(v));
      await h.write("1/0/1", true, "DPT1.001");
      expect(echoes).toEqual(native() ? [] : [true]);
    });

    it("D8 a GroupValueRead is not a value — legacy hands it to observers as 0/false (library NPDU.dataValue); native ignores reads [LEGACY-DEFECT]", async () => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT1.001", (v) => got.push(v));
      await h.deviceReads("1/1/1");
      expect(got).toEqual(native() ? [] : [false]);
      if (native()) expect(h.decodeFailures()).toEqual({}); // ignored by service filter, not by an incidental decode error
    });

    it("D1 DPT 22.101 (0x0103) — legacy: bit-field object the driver cannot decode (HVAC status stays null in production); native: the raw 16-bit number decodeHvacStatus expects [INTENTIONAL; the object form is also spec-legitimate, but unusable by the driver]", async () => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT22.101", (v) => got.push(v));
      await h.deviceWritesRaw("1/1/1", [0x01, 0x03]);
      if (native()) expect(got).toEqual([0x0103]);
      else { expect(got).toHaveLength(1); expect(got[0]).toMatchObject({ Fault: true, StatusEcoH: true, HeatCoolMode: true }); }
    });

    it("D2 DPT 222.100 (0c1a 0c9a 0b00) — same values; legacy keys are Comfort/Standby/Economy, native lowercase as KnxSetpoints/isKnxSetpoints require [INTENTIONAL: key case is a library/API naming convention, not specified by the DPT]", async () => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT222.100", (v) => got.push(v));
      await h.deviceWritesRaw("1/1/1", [0x0c, 0x1a, 0x0c, 0x9a, 0x0b, 0x00]);
      expect(got).toEqual([native() ? { comfort: 21, standby: 23.56, economy: 15.36 } : { Comfort: 21, Standby: 23.56, Economy: 15.36 }]);
    });

    it("D3 DPT 9.001 0x7FFF — legacy publishes 670760.96 as a reading; native refuses it (not delivered, counted) and later good values still arrive [SPEC: 0x7FFF is the DPT 9 invalid-data code; legacy is a LEGACY-DEFECT]", async () => {
      await start();
      const got: KnxValue[] = [];
      h.connection.observe("1/1/1", "DPT9.001", (v) => got.push(v));
      await h.deviceWritesRaw("1/1/1", [0x7f, 0xff]);
      await h.deviceWrites("1/1/1", "DPT9.001", 21.5);
      expect(got).toEqual(native() ? [21.5] : [670760.96, 21.5]);
      if (native()) expect(h.decodeFailures()).toEqual({ invalid_data: 1 });
    });
  });
}
