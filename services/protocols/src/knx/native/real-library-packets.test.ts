import { createRequire } from "node:module";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver, wrapKnxUltimate, type KnxConnection, type KnxUltimateClient, type KnxUltimateDptLib } from "../../knx-driver.js";

/**
 * Real `knxultimate` 6.0.1 PARSING (`KNXProtocol.parseMessage` over real KNXnet/IP TUNNELING_REQUEST / cEMI L_Data.ind bytes) → the library's own
 * `KNXTunnelingRequest`/`NPDU` objects → real `indication` events on a real (never connected, no socket) `KNXClient` → the real wrapper
 * (`wrapKnxUltimate`) → `KnxProtocolDriver`. Nothing about packet shape is hand-modelled: `dstAddress`, `npdu.dataValue`, `isGroupWrite/Response/Read`
 * all come from the library's parser.
 *
 * NOT proven here: that a real gateway behaves this way, or when a real client sets `echoed = true`. The `echoed` flag is the library's
 * documented-by-source second `indication` argument (KNXClient.js `write()` emits `indication(packet, true)`); the test passes it the way the
 * library does, it does not drive a connected client. Wire bytes are authored from the cEMI layout, independent of the library's encoder.
 * No gateway, no network, deterministic.
 */
type Lib = {
  KNXClient: new (o: unknown) => KnxUltimateClient & { emit(e: string, ...a: unknown[]): boolean };
  KNXProtocol: { parseMessage(b: Buffer): { knxMessage: unknown } };
  dptlib: KnxUltimateDptLib;
};
let lib: Lib | null = null;
try { lib = createRequire(import.meta.url)("knxultimate") as Lib; } catch { lib = null; }

/** KNXnet/IP TUNNELING_REQUEST (channel 1, seq 0) carrying cEMI L_Data.ind from 1.1.5 to group `ga`; `tpdu` = the 2 TPDU/APCI bytes (data in the low 6 bits of the last). */
function tunnelingInd(ga: string, tpdu: [number, number]): Buffer {
  const [m, mid, sub] = ga.split("/").map(Number) as [number, number, number];
  const dst = (m << 11) | (mid << 8) | sub;
  const cemi = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x11, 0x05, dst >> 8, dst & 0xff, 0x01, tpdu[0], tpdu[1]]);
  const conn = Buffer.from([0x04, 0x01, 0x00, 0x00]);
  const header = Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 6 + conn.length + cemi.length]);
  return Buffer.concat([header, conn, cemi]);
}
const WRITE_ON: [number, number] = [0x00, 0x81];
const WRITE_OFF: [number, number] = [0x00, 0x80];
const RESPONSE_ON: [number, number] = [0x00, 0x41];
const RESPONSE_OFF: [number, number] = [0x00, 0x40];
const READ: [number, number] = [0x00, 0x00];

const DEV = "device-real-packets" as DeviceId;
describe.skipIf(lib === null)("real knxultimate-parsed packets → real wrapper → KnxProtocolDriver (no gateway)", () => {
  let client: Lib["KNXClient"] extends new (o: unknown) => infer C ? C : never;
  let connection: KnxConnection;
  let wrapped: KnxConnection;
  const received: string[] = [];
  afterEach(async () => { await wrapped?.disconnect().catch(() => undefined); });

  /** Parse with the library, then emit as the library's client does for inbound (`echoed = false`) or its own transmission (`echoed = true`). */
  const inbound = (ga: string, tpdu: [number, number], echoed = false): void => {
    const { knxMessage } = lib!.KNXProtocol.parseMessage(tunnelingInd(ga, tpdu));
    client.emit("indication", knxMessage, echoed);
  };
  async function rig(config: Record<string, unknown>) {
    received.length = 0;
    client = new lib!.KNXClient({ hostProtocol: "TunnelUDP", ipAddr: "127.0.0.1", ipPort: 3671 });
    wrapped = wrapKnxUltimate(client, lib!.dptlib);
    // Only the transport verbs are replaced: connect is a no-op (no socket), and write records then emits what the library emits for its own send.
    connection = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      write: async (ga, value) => { received.push(`write ${ga}=${JSON.stringify(value)}`); inbound(ga, value ? WRITE_ON : WRITE_OFF, true); },
      observe: (ga, dpt, h) => wrapped.observe(ga, dpt, h),
    };
    const driver = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => connection });
    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.bind({ deviceId: DEV, capability: "onoff", address: "1/0/1", config: { dpt: "DPT1.001", ...config } });
    await driver.connect();
    return { driver, events };
  }
  const observed = (e: BackendStateEvent[]) => e.filter((x) => x.provenance === "observed");

  it("the library parses the bytes the way the wrapper reads them (guards the test's own premise)", () => {
    const w = lib!.KNXProtocol.parseMessage(tunnelingInd("1/0/2", WRITE_ON)).knxMessage as { cEMIMessage: { dstAddress: { toString(): string }; npdu: { isGroupWrite: boolean; isGroupRead: boolean; dataValue: Buffer } } };
    expect(w.cEMIMessage.dstAddress.toString()).toBe("1/0/2");
    expect(w.cEMIMessage.npdu.isGroupWrite).toBe(true);
    expect(w.cEMIMessage.npdu.isGroupRead).toBe(false);
    const r = lib!.KNXProtocol.parseMessage(tunnelingInd("1/0/2", READ)).knxMessage as typeof w;
    expect(r.cEMIMessage.npdu.isGroupRead).toBe(true);
  });

  it("1. incoming GroupValueWrite on the status GA is observed state", async () => {
    const { driver, events } = await rig({ statusAddress: "1/0/2" });
    inbound("1/0/2", WRITE_ON);
    expect(observed(events)).toHaveLength(1);
    expect(driver.getState(DEV, "onoff")).toMatchObject({ kind: "onoff", on: true });
  });

  it("2. incoming GroupValueResponse on the status GA is observed state", async () => {
    const { driver, events } = await rig({ statusAddress: "1/0/2" });
    inbound("1/0/2", RESPONSE_ON);
    expect(driver.getState(DEV, "onoff")).toMatchObject({ on: true });
    inbound("1/0/2", RESPONSE_OFF);
    expect(driver.getState(DEV, "onoff")).toMatchObject({ on: false });
    expect(observed(events)).toHaveLength(2);
  });

  it("3. incoming GroupValueRead is never exposed as a value: no observer call, no event, no state (its dataValue would decode as false)", async () => {
    const { driver, events } = await rig({ statusAddress: "1/0/2" });
    const seen: unknown[] = [];
    const off = wrapped.observe("1/0/2", "DPT1.001", (v) => seen.push(v));
    inbound("1/0/2", READ);
    expect(seen).toEqual([]);
    expect(observed(events)).toEqual([]);
    expect(driver.getState(DEV, "onoff")).toBeNull();
    inbound("1/0/2", WRITE_ON);                                  // a real report afterwards still flows (the filter is not a blanket drop)
    expect(seen).toEqual([true]);
    off();
  });

  it("4. the client's own transmission (echoed = true) is not delivered to observers and is not state", async () => {
    const { driver, events } = await rig({ statusAddress: "1/0/2" });
    const seen: unknown[] = [];
    wrapped.observe("1/0/2", "DPT1.001", (v) => seen.push(v));
    inbound("1/0/2", WRITE_ON, true);
    expect(seen).toEqual([]);
    expect(observed(events)).toEqual([]);
    expect(driver.getState(DEV, "onoff")).toBeNull();
  });

  it("5. shared command/status GA: the echo of our own command is not state (the echo filter is the only thing preventing it); a later device report is", async () => {
    const { driver, events } = await rig({ statusAddress: "1/0/1", feedbackOnCommandAddress: true });
    await driver.command(DEV, { capability: "onoff", action: "on" });
    expect(received).toEqual(["write 1/0/1=true"]);              // the command really went out, and its echo really reached the client's indication path
    expect(events.filter((e) => e.provenance === "commanded")).toHaveLength(1);
    expect(observed(events)).toEqual([]);
    expect(driver.getState(DEV, "onoff")).toBeNull();
    inbound("1/0/1", WRITE_OFF);                                 // someone else / the device reports
    expect(observed(events)).toHaveLength(1);
    expect(driver.getState(DEV, "onoff")).toMatchObject({ on: false });
  });
});
