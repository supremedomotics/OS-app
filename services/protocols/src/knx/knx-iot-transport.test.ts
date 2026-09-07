import { describe, expect, it } from "vitest";
import { CoapKnxIotTransport } from "./knx-iot-transport.js";

/**
 * § Production defect fix — `get()` (the CoAP GET behind the "discovery.functional_blocks"
 * task, called once per discovered KNX-IoT device by `collectKnxIotSignals` — itself run
 * unconditionally before EVERY KNX scan, including a plain `.knxproj` file import with no
 * live gateway involved) had no timeout at all: if a device never answers (dropped
 * packet, partial CoAP implementation, firewall, stale/ghost discovery entry), the
 * underlying `coap` request's promise never resolves OR rejects — it hangs forever, and
 * every caller awaits it directly, so ONE unresponsive device on the network hung the
 * entire scan request. The frontend's own 90s client-side timeout then fired, surfacing
 * as "Request timed out after 90s" on every scan, permanently, until that one device
 * either started responding or left the network. These tests hit the REAL CoAP transport
 * (no fake) against a genuinely non-responding target, proving the fix at the actual
 * network layer, not just its interface plumbing.
 */
describe("CoapKnxIotTransport.get — bounded timeout (§ production defect fix)", () => {
  it("rejects with a real, timely error instead of hanging forever when nothing answers", async () => {
    const transport = new CoapKnxIotTransport();
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved, guaranteed unroutable/non-
    // responding, so this never depends on what's actually on the local network.
    const start = Date.now();
    await expect(transport.get("192.0.2.1", 5683, "/fb", 200)).rejects.toThrow(/timed out/i);
    const elapsedMs = Date.now() - start;
    // Bounded by the timeout we passed, with generous slack for CI scheduling —
    // the whole point is this is NOT the old "never resolves" behavior.
    expect(elapsedMs).toBeLessThan(5000);
  }, 10000);

  it("defaults to a 3000ms bound when no timeoutMs is given", async () => {
    const transport = new CoapKnxIotTransport();
    const start = Date.now();
    await expect(transport.get("192.0.2.1", 5683, "/fb")).rejects.toThrow(/timed out after 3000ms/i);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10000);
});
