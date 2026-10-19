/**
 * TEST SUPPORT ONLY. Lets the EXISTING knx-driver.test.ts (121 tests, written against an in-memory fake bus) run unmodified against
 * {@link NativeKnxConnection}: `KNX_DRIVER_BUS=native pnpm exec vitest run src/knx-driver.test.ts`. The test file keeps its assertions; only
 * the bus fixture is selected (see the top of that file).
 *
 * What is REAL in a native run: the tunnel client, the KNXnet/IP frames, the virtual gateway, the cEMI codec, the DPT encode/decode, the
 * telegram bus and the NativeKnxConnection. What is SHORT-CUT: `push()` (a device reporting on a status address) must be synchronous because
 * the legacy tests assert right after it, so it encodes the value for the observer's DPT, builds and re-parses a real L_Data.ind cEMI frame and
 * publishes it straight into the connection's bus — everything but the UDP hop. Writes are NOT short-cut: `writes` is what the virtual
 * gateway actually received, decoded from the wire for the DPT the driver asked for.
 *
 * GROUP-ADDRESS ALIASING: 60 of the 121 legacy tests use synthetic three-level group addresses whose main group exceeds 31 (e.g. "92/1/3"); KNX
 * three-level addressing has a 5-bit main group, so a native connection correctly rejects them (`invalid_address`; as an observer: inert and
 * recorded). They test driver logic, not addressing, so this harness maps each such string to a distinct valid address in main group 31 (one
 * bijection per bus) and maps back in `writes`. Valid addresses pass through untouched. The aliasing is the ONLY thing standing between those
 * 60 tests and a native run — it is a property of the tests' fixtures, not of the driver.
 *
 * A value a legacy test injects that cannot exist on the wire for the observer's DPT (e.g. a number the DPT cannot encode) makes `push()` throw
 * `NotRepresentable`; such tests are reported individually as "not applicable to a wire-level transport", never silently passed.
 */
import type { KnxConnection } from "../../../knx-driver.js";
import type { KnxValue } from "../../../knx-codec.js";
import { formatGroupAddress, isValidGroupAddress, parseGroupAddress } from "../address.js";
import { CemiMessageCode, decodeCemi, encodeGroupCemi, type GroupData } from "../cemi.js";
import { decodeDpt, encodeDpt } from "../dpt.js";
import type { NativeKnxConnection } from "../knx-connection.js";
import { telegramFromCemi } from "../telegram-bus.js";
import { systemClock } from "../transport.js";
import { expect } from "vitest";
import { createWorld, type World } from "./test-world.js";

const expect_name = (): string => expect.getState().currentTestName ?? "?";

/** Equality of a requested value and its wire decoding: a one-bit value may be requested as a boolean or as 0/1; everything else must match exactly. */
function sameValue(a: KnxValue, b: KnxValue): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) === Number(b);
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

export class NotRepresentable extends Error {
  constructor(message: string) { super(message); this.name = "NotRepresentable"; }
}

export interface DriverBus extends KnxConnection {
  readonly writes: Array<{ ga: string; value: KnxValue; dpt: string }>;
  push(ga: string, value: KnxValue): void;
}

const live = new Set<NativeDriverBus>();
export async function disposeNativeDriverBuses(): Promise<void> {
  await Promise.all([...live].map((b) => b.dispose()));
  live.clear();
}

const TUNNEL_IAS = new Set([0xff01, 0xff02, 0xff03, 0xff04]);

export class NativeDriverBus implements DriverBus {
  readonly writes: Array<{ ga: string; value: KnxValue; dpt: string }> = [];
  private readonly world: World;
  private readonly conn: NativeKnxConnection;
  private readonly wire: Array<{ destination: number; data: GroupData }> = [];
  private readonly observed = new Map<number, string[]>(); // destination -> DPTs of live observers, registration order
  private readonly aliasOf = new Map<string, string>();
  private readonly originalOf = new Map<string, string>();

  constructor() {
    this.world = createWorld({ clock: systemClock as never });
    this.conn = this.world.connection({ clock: systemClock });
    this.world.bus.monitor((t) => { if (TUNNEL_IAS.has(t.source) && t.service === "write" && t.data) this.wire.push({ destination: t.destination, data: t.data }); });
    live.add(this);
  }

  private alias(ga: string): string {
    if (isValidGroupAddress(ga)) return ga;
    let a = this.aliasOf.get(ga);
    if (!a) {
      const n = this.aliasOf.size;
      a = `31/${Math.floor(n / 256)}/${n % 256}`;
      this.aliasOf.set(ga, a);
      this.originalOf.set(a, ga);
    }
    return a;
  }

  async connect(): Promise<void> { await this.conn.connect(); }
  async disconnect(): Promise<void> { await this.conn.disconnect(); }

  async write(original: string, value: KnxValue, dpt: string): Promise<void> {
    const ga = this.alias(original);
    await this.conn.write(ga, value, dpt);
    const destination = parseGroupAddress(ga);
    const i = this.wire.findIndex((w) => w.destination === destination);
    if (i < 0) throw new Error(`native write to ${ga} was acknowledged but never reached the line`);
    const [w] = this.wire.splice(i, 1);
    // Record what the DRIVER asked for (that is what the legacy assertions are about), but only after proving the wire carries an equal value: a
    // wire value that differs from the request (rounding, truncation, wrong DPT) fails the test loudly instead of being masked.
    const onWire = decodeDpt(dpt, w!.data);
    if (!sameValue(onWire, value)) throw new Error(`native write to ${original} asked for ${JSON.stringify(value)} but ${JSON.stringify(onWire)} (${dpt}) is on the wire`);
    this.writes.push({ ga: this.originalOf.get(ga) ?? formatGroupAddress(destination), value, dpt });
  }

  observe(original: string, dpt: string, handler: (v: KnxValue) => void): () => void {
    const ga = this.alias(original);
    const destination = parseGroupAddress(ga);
    const list = this.observed.get(destination) ?? [];
    list.push(dpt);
    this.observed.set(destination, list);
    const off = this.conn.observe(ga, dpt, handler);
    return () => {
      off();
      const l = this.observed.get(destination);
      const k = l?.lastIndexOf(dpt) ?? -1;
      if (l && k >= 0) l.splice(k, 1);
    };
  }

  push(original: string, value: KnxValue): void {
    const destination = parseGroupAddress(this.alias(original));
    const dpt = this.observed.get(destination)?.at(-1); // the fake delivered to the most recently registered observer; encode for that DPT
    if (!dpt) return;
    let data: GroupData;
    // A one-bit DPT whose test value is an out-of-range integer (e.g. 7) is a 6-bit short value on the wire — the transport rejects it as undecodable.
    if (/^(?:dpt)?1(?:\.|$)/i.test(dpt) && typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 0x3f) data = { kind: "short", value };
    else try { data = encodeDpt(dpt, value); } catch (e) { throw new NotRepresentable(`${JSON.stringify(value)} cannot be encoded for ${dpt}: ${(e as Error).message}`); }
    const frame = decodeCemi(encodeGroupCemi({ messageCode: CemiMessageCode.L_DATA_IND, source: 0x1101, destination, service: "write", data }));
    this.conn.bus.publish(telegramFromCemi(frame)!);
  }

  /** Strict-decode drops, rejected observers and handler errors this bus saw (non-zero ⇒ the native path behaved differently from "deliver whatever was pushed"). */
  anomalies(): { decodeFailures: Record<string, number>; rejectedObservers: number; listenerErrors: number; aliasedGas: number } {
    const d = this.conn.diagnostics();
    return { decodeFailures: d.decodeFailures, rejectedObservers: d.rejectedObservers, listenerErrors: d.bus.listenerErrors, aliasedGas: this.aliasOf.size };
  }

  async dispose(): Promise<void> {
    if (process.env.KNX_PARITY_REPORT) {
      const a = this.anomalies();
      if (Object.keys(a.decodeFailures).length || a.rejectedObservers || a.listenerErrors) process.stderr.write(`PARITY-ANOMALY ${expect_name()} ${JSON.stringify(a)}\n`);
      process.stderr.write(`PARITY-ROW ${JSON.stringify({ test: expect_name(), ...a, writesOnWire: this.writes.length })}\n`); // one row per test: the evidence behind docs/knx/knx-native-group-parity-plan.md §6.1
    }
    await this.conn.disconnect();
    this.world.iface.shutdown();
  }
}
