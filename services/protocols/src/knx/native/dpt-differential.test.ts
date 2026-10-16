/**
 * TEMPORARY migration evidence (§ KNX Ultimate removal gate). Compares the native DPT
 * codec against the still-installed `knxultimate` library as a black-box oracle — via its
 * public dptlib API only — to prove decode/encode parity on the DPTs production uses.
 * Delete this file when `knxultimate` is removed (it auto-skips if the package is absent);
 * the golden vectors in dpt.test.ts are the permanent record.
 *
 * Documented, intentional deviations (native is stricter or fixes a defect):
 *   - DPT 22.101  oracle returns a bit-field object; native returns the raw 16-bit number
 *                 `decodeHvacStatus` is written for (with the oracle, status decoded to null).
 *   - DPT 1       oracle accepts any non-zero octet as true; native requires exactly 0/1.
 *   - DPT 17      oracle passes reserved bits through; native rejects them.
 *   - DPT 9       oracle returns 670760.96 for the 0x7FFF invalid marker; native throws.
 *   - DPT 14      oracle passes NaN/Infinity through; native throws.
 *   - DPT 222     oracle keys are `Comfort/Standby/Economy`; `knx-codec.ts` `isKnxSetpoints`
 *                 requires lowercase, so with the oracle HVAC setpoints decoded to null.
 *                 Native emits lowercase. (Compared below with keys lowercased.)
 *   - DPT 9 / 222 encode rounds the mantissa to nearest; oracle truncates it once the
 *                 exponent is > 0 (e.g. 670 → 669.44 vs native 670.08). Native is closer.
 *   - DPT 5.003   exact half-steps (e.g. 180°) round up natively, down in the oracle.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { decodeDpt, encodeDpt, KnxDptError } from "./dpt.js";
import type { GroupData } from "./cemi.js";
import { makeRng } from "./test-support.js";

interface Oracle { fromBuffer(raw: Buffer, cfg: unknown): unknown; resolve(dpt: string): unknown; populateAPDU(v: unknown, apdu: { data?: Buffer }, dpt: string): unknown }
let oracle: Oracle | null = null;
try { oracle = (createRequire(import.meta.url)("knxultimate") as { dptlib: Oracle }).dptlib; } catch { oracle = null; }

const SIZES: Record<string, number> = {
  "1.001": 1, "5.001": 1, "5.003": 1, "5.004": 1, "5.010": 1, "5.100": 1, "6.001": 1, "6.010": 1, "7.001": 2, "7.600": 2, "8.001": 2,
  "9.001": 2, "9.004": 2, "9.007": 2, "12.001": 4, "13.010": 4, "14.056": 4, "17.001": 1, "20.102": 1, "20.105": 1,
  "22.101": 2, "222.100": 6, "232.600": 3, "251.600": 6,
};
const DEVIATING_DECODE = new Set(["22.101"]);
const lowerKeys = (o: unknown): unknown => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]));

describe.skipIf(!oracle)("native DPT decode == knxultimate decode (differential)", () => {
  for (const [dpt, size] of Object.entries(SIZES)) {
    it(`DPT ${dpt}`, () => {
      const rng = makeRng(Number(dpt.replace(".", "")));
      let compared = 0;
      for (let i = 0; i < 1500; i++) {
        const raw = rng.bytes(size);
        const theirs = (() => { try { return oracle!.fromBuffer(raw, oracle!.resolve(dpt)); } catch { return undefined; } })();
        const data: GroupData = dpt.startsWith("1.") ? { kind: "short", value: raw[0]! & 1 } : { kind: "bytes", bytes: raw };
        const feed = dpt.startsWith("1.") ? Buffer.from([raw[0]! & 1]) : raw;
        const expected = dpt.startsWith("1.") ? oracle!.fromBuffer(feed, oracle!.resolve(dpt)) : theirs;
        let mine: unknown;
        try { mine = decodeDpt(dpt, data); } catch (e) {
          expect(e).toBeInstanceOf(KnxDptError);
          continue; // strictness deviation (reserved bits / invalid marker): never a silent mismatch
        }
        if (DEVIATING_DECODE.has(dpt) || expected === undefined) continue;
        const norm = dpt === "222.100" ? lowerKeys(expected) : expected;
        expect(mine, `${dpt} ${raw.toString("hex")}`).toEqual(norm);
        compared++;
      }
      // DPT 17 rejects 3/4 of random octets (reserved bits) by design; DPT 1 inputs are masked.
      if (!DEVIATING_DECODE.has(dpt)) expect(compared).toBeGreaterThan(dpt === "17.001" ? 250 : 1000);
    });
  }
});

describe.skipIf(!oracle)("native DPT encode == knxultimate encode (differential)", () => {
  const vectors: Array<[string, unknown[]]> = [
    ["1.001", [true, false]],
    ["5.001", Array.from({ length: 101 }, (_, i) => i)],
    ["5.003", [0, 90, 360]],
    ["5.100", [0, 1, 2, 3, 100, 255]],
    ["6.010", [-128, -1, 0, 127]],
    ["7.600", [2000, 2700, 4000, 6500]],
    ["8.001", [-32768, -200, 0, 32767]],
    ["9.001", [-30, -0.5, 0, 0.01, 19.5, 21, 21.5, 100, 1000.5]],
    ["12.001", [0, 258, 4294967295]],
    ["13.010", [-2147483648, -256, 0, 2147483647]],
    ["14.056", [0, 1, -1, 1234.5]],
    ["17.001", [0, 5, 63]],
    ["20.102", [0, 1, 2, 3, 4]],
    ["232.600", [{ red: 255, green: 128, blue: 0 }, { red: 0, green: 0, blue: 0 }]],
    ["251.600", [{ red: 1, green: 2, blue: 3, white: 4, mR: 1, mG: 1, mB: 1, mW: 0 }]],
  ];
  for (const [dpt, values] of vectors) {
    it(`DPT ${dpt}`, () => {
      for (const v of values) {
        const apdu: { data?: Buffer } = {};
        oracle!.populateAPDU(v, apdu, dpt);
        const theirs = Buffer.from(apdu.data as Buffer);
        const mine = encodeDpt(dpt, v as never);
        const mineBuf = mine.kind === "short" ? Buffer.from([mine.value]) : mine.bytes;
        expect(mineBuf.toString("hex"), `${dpt} ${JSON.stringify(v)}`).toBe(theirs.toString("hex"));
      }
    });
  }
});
