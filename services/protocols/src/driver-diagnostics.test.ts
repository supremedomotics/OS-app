import { describe, expect, it } from "vitest";
import { DriverDiagnosticsTracker } from "./driver-diagnostics.js";

describe("DriverDiagnosticsTracker", () => {
  it("starts with real zero counters and null last-seen fields, never fabricated", () => {
    const t = new DriverDiagnosticsTracker();
    const snap = t.snapshot("disconnected", { protocol: "avr", driverVersion: "1.0.0" });
    expect(snap).toMatchObject({
      connectionStatus: "disconnected",
      packetsSent: 0,
      packetsReceived: 0,
      lastCommand: null,
      lastResponse: null,
      responseTimeMs: null,
      reconnectCount: 0,
      lastError: null,
      model: null,
      firmware: null,
    });
  });

  it("counts sends/receives and computes a response time from the send/receive pair", async () => {
    const t = new DriverDiagnosticsTracker();
    t.recordSend("PW?");
    await new Promise((r) => setTimeout(r, 5));
    t.recordReceive("PWON");
    const snap = t.snapshot("connected", { protocol: "avr", driverVersion: "1.0.0" });
    expect(snap.packetsSent).toBe(1);
    expect(snap.packetsReceived).toBe(1);
    expect(snap.lastCommand).toBe("PW?");
    expect(snap.lastResponse).toBe("PWON");
    expect(snap.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks reconnects and the last error independently of send/receive counters", () => {
    const t = new DriverDiagnosticsTracker();
    t.recordReconnect();
    t.recordReconnect();
    t.recordError("ECONNRESET");
    const snap = t.snapshot("connecting", { protocol: "heos", driverVersion: "1.0.0" });
    expect(snap.reconnectCount).toBe(2);
    expect(snap.lastError).toBe("ECONNRESET");
    expect(snap.packetsSent).toBe(0);
  });

  it("carries static info (model/firmware/ip/mac) straight through the snapshot", () => {
    const t = new DriverDiagnosticsTracker();
    const snap = t.snapshot("connected", {
      protocol: "yamaha",
      driverVersion: "1.0.0",
      model: "RX-A8A",
      firmware: null,
      ip: "192.168.1.50",
      mac: "aa:bb:cc:dd:ee:ff",
    });
    expect(snap.model).toBe("RX-A8A");
    expect(snap.ip).toBe("192.168.1.50");
    expect(snap.mac).toBe("aa:bb:cc:dd:ee:ff");
  });
});
