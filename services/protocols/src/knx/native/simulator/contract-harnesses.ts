/**
 * TEST SUPPORT ONLY. The two implementations the shared KnxConnection contract (knx-connection.contract.ts) is run against:
 *
 *   - LEGACY: the production `wrapKnxUltimate()` (exported for this purpose) over the REAL `knxultimate` dptlib and a fake `KNXClient`. The
 *     fake models only what was read in knxultimate 6.0.1's source and is therefore NOT a hardware or real-client result:
 *       · `write()` also emits an `indication` to every listener with `echoed = true` (KNXClient.js, tunnel branch of write());
 *       · a GroupValueRead indication carries `npdu.dataValue = Buffer.alloc(1, apci & 0x3f)` (NPDU.js `dataValue` getter) and the client
 *         forwards every L_DATA_IND (KNXClient.js ~2222) — the wrapper filters neither.
 *     Verifying these two against the real client on a loopback gateway is on the hardware/integration list.
 *   - NATIVE: `NativeKnxConnection` tunnelling into the deterministic simulator (ManualClock, virtual gateway and line).
 */
import { createRequire } from "node:module";
import type { KnxValue } from "../../../knx-codec.js";
import { wrapKnxUltimate, type KnxConnection, type KnxUltimateClient, type KnxUltimateDptLib } from "../../../knx-driver.js";
import { decodeDpt, encodeDpt } from "../dpt.js";
import { formatGroupAddress, parseGroupAddress } from "../address.js";
import { GA, createWorld } from "./test-world.js";

export interface WireWrite { ga: string; value: KnxValue; dpt: string }

export interface ContractHarness {
  readonly name: "legacy" | "native";
  readonly connection: KnxConnection;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(ga: string, value: KnxValue, dpt: string): Promise<void>;
  /** A device on the line writes `value` (encoded for `dpt`). */
  deviceWrites(ga: string, dpt: string, value: KnxValue): Promise<void>;
  deviceResponds(ga: string, dpt: string, value: KnxValue): Promise<void>;
  /** A device writes raw payload octets (no DPT encoding step), to reproduce exact on-wire values. */
  deviceWritesRaw(ga: string, bytes: number[]): Promise<void>;
  /** A GroupValueRead appears on the line. */
  deviceReads(ga: string): Promise<void>;
  /** Group writes this connection put on the wire, in order. */
  wire(): WireWrite[];
  failNextConnect(): void;
  /** Resources a FAILED connect() left behind (listeners/timers/sockets); 0 expected. */
  failedConnectResidue(): number;
  /** Exceptions that escaped into the transport's own receive path (a handler bug must never do that). */
  escapedErrors(): unknown[];
  /** Native only: strict-decode failures by code. */
  decodeFailures(): Record<string, number> | null;
  close(): Promise<void>;
  /** Lets a promise that needs the transport to make progress settle (native: advances virtual time; legacy: identity). */
  settle<T>(p: Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------------------------------------- legacy

let ultimate: { dptlib: KnxUltimateDptLib } | null = null;
try { ultimate = createRequire(import.meta.url)("knxultimate") as { dptlib: KnxUltimateDptLib }; } catch { ultimate = null; }
export const legacyAvailable = ultimate !== null;

type Cb = (...a: unknown[]) => void;

class FakeUltimateClient {
  private readonly listeners = new Map<string, Set<Cb>>();
  readonly writes: WireWrite[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  failConnect = false;
  constructor(private readonly dptlib: KnxUltimateDptLib & { populateAPDU(v: unknown, apdu: { data?: Buffer }, dpt: string): unknown }) {}
  on(event: string, cb: Cb): this { const s = this.listeners.get(event) ?? new Set(); s.add(cb); this.listeners.set(event, s); return this; }
  off(event: string, cb: Cb): this { this.listeners.get(event)?.delete(cb); return this; }
  count(event: string): number { return this.listeners.get(event)?.size ?? 0; }
  emit(event: string, ...a: unknown[]): void { for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...a); }
  Connect(): void { this.connectCalls++; queueMicrotask(() => (this.failConnect ? this.emit("error", new Error("refused")) : this.emit("connected"))); }
  async Disconnect(): Promise<void> { this.disconnectCalls++; }
  write(ga: string, value: KnxValue, dpt: string): void {
    this.writes.push({ ga, value, dpt });
    const apdu: { data?: Buffer } = {};
    this.dptlib.populateAPDU(value, apdu, dpt);
    this.emit("indication", packet(ga, apdu.data!, "write"), true); // the library's own echo of an outgoing write (echoed = true)
  }
}

const packet = (ga: string, dataValue: Buffer, kind: "write" | "response" | "read") => ({
  cEMIMessage: { dstAddress: { toString: () => ga }, npdu: { dataValue, isGroupWrite: kind === "write", isGroupResponse: kind === "response", isGroupRead: kind === "read" } },
});

export function legacyHarness(): ContractHarness {
  if (!ultimate) throw new Error("knxultimate is not installed");
  const dptlib = ultimate.dptlib as KnxUltimateDptLib & { populateAPDU(v: unknown, apdu: { data?: Buffer }, dpt: string): unknown };
  const client = new FakeUltimateClient(dptlib);
  const connection = wrapKnxUltimate(client as unknown as KnxUltimateClient, dptlib);
  const escaped: unknown[] = [];
  const deliver = (p: unknown): void => { try { client.emit("indication", p, false); } catch (e) { escaped.push(e); } };
  const encoded = (dpt: string, v: KnxValue): Buffer => { const a: { data?: Buffer } = {}; dptlib.populateAPDU(v, a, dpt); return a.data!; };
  return {
    name: "legacy", connection,
    connect: () => connection.connect(),
    disconnect: () => connection.disconnect(),
    write: (ga, v, dpt) => connection.write(ga, v, dpt),
    deviceWrites: async (ga, dpt, v) => deliver(packet(ga, encoded(dpt, v), "write")),
    deviceResponds: async (ga, dpt, v) => deliver(packet(ga, encoded(dpt, v), "response")),
    deviceWritesRaw: async (ga, bytes) => deliver(packet(ga, Buffer.from(bytes), "write")),
    deviceReads: async (ga) => deliver(packet(ga, Buffer.alloc(1, 0), "read")),
    wire: () => [...client.writes],
    failNextConnect: () => { client.failConnect = true; },
    failedConnectResidue: () => client.count("connected") + client.count("error") + (client.disconnectCalls === 0 ? 1 : 0), // listeners left, plus "never released the half-open client"
    escapedErrors: () => escaped,
    decodeFailures: () => null,
    close: async () => undefined,
    settle: (p) => p,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------- native

export function nativeHarness(): ContractHarness {
  const w = createWorld();
  const conn = w.connection();
  const dptByGa = new Map<number, string>();
  const wire: WireWrite[] = [];
  const tunnelIas = new Set([0xff01, 0xff02, 0xff03, 0xff04]);
  w.bus.monitor((t) => {
    if (!tunnelIas.has(t.source) || t.service !== "write" || !t.data) return;
    const dpt = dptByGa.get(t.destination) ?? "unknown";
    wire.push({ ga: formatGroupAddress(t.destination), value: dpt === "unknown" ? (null as never) : decodeDpt(dpt, t.data), dpt });
  });
  const onLine = async (ga: string, service: "write" | "response", dpt: string, v: KnxValue): Promise<void> => {
    w.bus.transmit({ source: w.sender.individualAddress, destination: parseGroupAddress(ga), service, data: encodeDpt(dpt, v) });
    await w.clock.advance(30);
  };
  return {
    name: "native", connection: conn,
    connect: () => w.until(conn.connect()),
    disconnect: () => w.until(conn.disconnect()),
    write: (ga, v, dpt) => { dptByGa.set(parseGroupAddress(ga), dpt); return w.until(conn.write(ga, v, dpt)); },
    deviceWrites: (ga, dpt, v) => onLine(ga, "write", dpt, v),
    deviceResponds: (ga, dpt, v) => onLine(ga, "response", dpt, v),
    deviceWritesRaw: async (ga, bytes) => { w.bus.transmit({ source: w.sender.individualAddress, destination: GA(ga), service: "write", data: { kind: "bytes", bytes: Buffer.from(bytes) } }); await w.clock.advance(30); },
    deviceReads: async (ga) => { w.bus.transmit({ source: w.sender.individualAddress, destination: GA(ga), service: "read", data: null }); await w.clock.advance(30); },
    wire: () => [...wire],
    failNextConnect: () => { w.iface.faults.refuseConnectStatus = 0x24; },
    failedConnectResidue: () => { const l = w.leaks(); return l.timers + l.sockets + l.channels; },
    escapedErrors: () => [],
    decodeFailures: () => conn.diagnostics().decodeFailures,
    settle: (p) => w.until(p, 2_000),
    close: async () => { await w.until(conn.disconnect()); await w.clock.advance(300_000); w.iface.shutdown(); },
  };
}
