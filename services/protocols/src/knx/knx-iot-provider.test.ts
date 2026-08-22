import { describe, expect, it } from "vitest";
import { KnxIotProvider } from "./knx-iot-provider.js";
import type { DiscoveredEntry, IKnxIotTransport } from "./knx-iot-transport.js";

/** A fake transport standing in for the real CoAP/UDP one — proves the provider's
 * mapping/diagnostics logic without a real KNX IoT device or network. */
class FakeTransport implements IKnxIotTransport {
  discoverCalls = 0;
  getCalls: { host: string; port: number; pathname: string }[] = [];
  entries: DiscoveredEntry[] = [];
  functionalBlocksResponse = "</fb/1>;rt=\"urn:knx:fb.1\"";
  shouldFailGet = false;

  async discoverOnce(): Promise<DiscoveredEntry[]> {
    this.discoverCalls++;
    return this.entries;
  }

  lastGetTimeoutMs: number | undefined;
  async get(host: string, port: number, pathname: string, timeoutMs?: number): Promise<string> {
    this.getCalls.push({ host, port, pathname });
    this.lastGetTimeoutMs = timeoutMs;
    if (this.shouldFailGet) throw new Error("no response");
    return this.functionalBlocksResponse;
  }

  observeHandlers: ((payload: string) => void)[] = [];
  observe(_host: string, _port: number, _pathname: string, onUpdate: (payload: string) => void): () => void {
    this.observeHandlers.push(onUpdate);
    return () => { this.observeHandlers = this.observeHandlers.filter((h) => h !== onUpdate); };
  }
}

describe("KnxIotProvider", () => {
  it("maps real discovery responses to DiscoveredDevice, never fabricating one when nothing answers", async () => {
    const transport = new FakeTransport();
    const provider = new KnxIotProvider({ transport });
    expect(await provider.discover()).toEqual([]);

    transport.entries = [{ host: "10.0.0.42", linkFormat: "</dev>;rt=\"urn:knx:dev\"" }];
    const devices = await provider.discover();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ backendId: "knx-iot:10.0.0.42", suggestedName: "10.0.0.42", capabilities: [] });
    expect(devices[0]?.raw).toMatchObject({ host: "10.0.0.42", source: "knx-iot" });
  });

  it("executes discovery.functional_blocks as a real per-device CoAP GET, not a fabricated result", async () => {
    const transport = new FakeTransport();
    const provider = new KnxIotProvider({ transport });
    const body = await provider.execute({ kind: "discovery.functional_blocks", host: "10.0.0.42" });
    expect(body).toBe(transport.functionalBlocksResponse);
    expect(transport.getCalls).toEqual([{ host: "10.0.0.42", port: 5683, pathname: "/fb" }]);
  });

  it("§ production defect fix — passes its configured discoveryTimeoutMs through to the functional-blocks GET, so a non-responding device can never hang the scan forever", async () => {
    const transport = new FakeTransport();
    const provider = new KnxIotProvider({ transport, discoveryTimeoutMs: 1234 });
    await provider.execute({ kind: "discovery.functional_blocks", host: "10.0.0.42" });
    expect(transport.lastGetTimeoutMs).toBe(1234);
  });

  it("throws for any task kind outside its registered responsibilities, rather than silently no-op'ing", async () => {
    const provider = new KnxIotProvider({ transport: new FakeTransport() });
    await expect(provider.execute({ kind: "bus.group_write", groupAddress: "1/1/1", dpt: "1.001", value: true }))
      .rejects.toThrow(/unsupported task/);
  });

  it("never claims bus.monitor — subscribe() throws so it can't silently duplicate KNX Ultimate's job", () => {
    const provider = new KnxIotProvider({ transport: new FakeTransport() });
    expect(() => provider.subscribe()).toThrow(/not applicable/);
  });

  it("observeResource wires real transport notifications into the caller's handler and counts them", () => {
    const transport = new FakeTransport();
    const provider = new KnxIotProvider({ transport });
    const updates: string[] = [];
    const unsubscribe = provider.observeResource("10.0.0.42", "/dp/1", (p) => updates.push(p));
    expect(transport.observeHandlers).toHaveLength(1);
    transport.observeHandlers[0]?.("on");
    expect(updates).toEqual(["on"]);
    expect(provider.diagnostics().packetsReceived).toBe(1);
    unsubscribe();
    expect(transport.observeHandlers).toHaveLength(0);
  });

  it("diagnostics reflect real transport errors, never fabricated success", async () => {
    const transport = new FakeTransport();
    transport.shouldFailGet = true;
    const provider = new KnxIotProvider({ transport });
    await expect(provider.execute({ kind: "discovery.functional_blocks", host: "10.0.0.42" })).rejects.toThrow("no response");
    expect(provider.diagnostics().lastError).toBe("no response");
  });
});
