import { describe, expect, it } from "vitest";
import { AvrDiagnosticsRecorder } from "./avr-diagnostics.js";

describe("AvrDiagnosticsRecorder", () => {
  it("assigns sequential, zero-padded correlation IDs", () => {
    const r = new AvrDiagnosticsRecorder();
    expect(r.nextId()).toBe("AVR-000001");
    expect(r.nextId()).toBe("AVR-000002");
  });

  it("captures a full event lifecycle under one correlation ID with the requested field shapes", () => {
    const r = new AvrDiagnosticsRecorder();
    const id = r.nextId();
    r.recordReceived(id, "192.168.1.50", 23, "MV63");
    r.recordParsed(id, { kind: "volume", volume: 63, volumeDb: 0 });
    r.recordPatch(id, "patchMedia", {
      host: "192.168.1.50", port: 23, zone: "main", capability: "media",
      deviceId: "device123", bindingFound: true, oldState: { volume: 50 }, newState: { volume: 63 },
    });
    r.recordStateCache(id, {
      deviceId: "device123", capability: "media", changed: true, listenerCount: 2,
      oldState: { volume: 50 }, newState: { volume: 63 },
    });
    r.recordDiagnosticStage(id, "Gateway", { published: true });
    r.recordDiagnosticStage(id, "WebSocket", { sent: true, subscribedRooms: 1 });

    const log = r.exportLog();
    expect(log).toContain(`[${id}][TCP]`);
    expect(log).toContain('host=192.168.1.50');
    expect(log).toContain('line="MV63"');
    expect(log).toContain(`[${id}][Parser]`);
    expect(log).toContain(`[${id}][patchMedia]`);
    expect(log).toContain("binding");
    expect(log).toContain(`[${id}][StateCache]`);
    expect(log).toContain("changed=true");
    expect(log).toContain(`[${id}][Gateway]`);
    expect(log).toContain("published=true");
    expect(log).toContain(`[${id}][WebSocket]`);
    expect(log).toContain("sent=true");
  });

  it("captures unknown-protocol lines with hex/ascii/length/firstToken/sender/frequency, never a bare 'unrecognized' message", () => {
    const r = new AvrDiagnosticsRecorder();
    const id1 = r.nextId();
    r.recordUnknown(id1, "192.168.1.50", 23, "ZZQ99");
    const id2 = r.nextId();
    r.recordUnknown(id2, "192.168.1.50", 23, "ZZQ99");

    const log = r.exportLog();
    expect(log).not.toMatch(/unrecognized line/i);
    expect(log).toContain("hex=");
    expect(log).toContain("ascii=");
    expect(log).toContain("firstToken=ZZQ99");
    expect(log).toContain("length=5");
    expect(log).toContain('"ZZQ99" observed 2 times');

    const counters = r.snapshot();
    expect(counters.unknownCommands).toBe(2);
  });

  it("keeps counters exact: received/parsed/dispatched/dropped/bindingsMissing/cacheDeduplicated/gatewayPublishes/websocketSends", () => {
    const r = new AvrDiagnosticsRecorder();

    const id1 = r.nextId();
    r.recordReceived(id1, "h", 23, "MV63");
    r.recordParsed(id1, { kind: "volume", volume: 63, volumeDb: 0 });
    r.recordPatch(id1, "patchMedia", { host: "h", port: 23, zone: "main", capability: "media", deviceId: "d1", bindingFound: true });
    r.recordStateCache(id1, { deviceId: "d1", capability: "media", changed: true, listenerCount: 1, oldState: null, newState: {} });
    r.recordDiagnosticStage(id1, "Gateway", { published: true });
    r.recordDiagnosticStage(id1, "WebSocket", { sent: true, subscribedRooms: 1 });

    // A second event for the same value: deduplicated by the state cache (changed: false).
    const id2 = r.nextId();
    r.recordReceived(id2, "h", 23, "MV63");
    r.recordParsed(id2, { kind: "volume", volume: 63, volumeDb: 0 });
    r.recordPatch(id2, "patchMedia", { host: "h", port: 23, zone: "main", capability: "media", deviceId: "d1", bindingFound: true });
    r.recordStateCache(id2, { deviceId: "d1", capability: "media", changed: false, listenerCount: 1, oldState: {}, newState: {} });

    // A third event with no binding for this host/port/zone.
    const id3 = r.nextId();
    r.recordReceived(id3, "h", 23, "PW?");
    r.recordParsed(id3, { kind: "power", on: true });
    r.recordPatch(id3, "emitFor", { host: "h", port: 23, zone: "zone2", capability: "onoff", deviceId: null, bindingFound: false });
    r.recordDropped(id3, "no onoff binding for this host/port/zone");

    const c = r.snapshot();
    expect(c.commandsReceived).toBe(3);
    expect(c.commandsParsed).toBe(3);
    expect(c.eventsDispatched).toBe(1);
    expect(c.cacheDeduplicated).toBe(1);
    expect(c.bindingsMissing).toBe(1);
    expect(c.eventsDropped).toBe(2); // = bindingsMissing + cacheDeduplicated
    expect(c.gatewayPublishes).toBe(1);
    expect(c.websocketSends).toBe(1);
  });

  it("produces a session report with all requested counters at export/shutdown time", () => {
    const r = new AvrDiagnosticsRecorder();
    const id = r.nextId();
    r.recordReceived(id, "h", 23, "MV63");
    r.recordUnknown(r.nextId(), "h", 23, "ZZQ99");

    const report = r.sessionReport();
    expect(report).toContain("commands received:");
    expect(report).toContain("commands parsed:");
    expect(report).toContain("unknown commands:");
    expect(report).toContain("events dispatched:");
    expect(report).toContain("events dropped:");
    expect(report).toContain("bindings missing:");
    expect(report).toContain("cache deduplicated:");
    expect(report).toContain("gateway publishes:");
    expect(report).toContain("websocket sends:");
    expect(r.exportLog()).toContain(report.slice(0, 40));
  });

  it("evicts the oldest raw lines once the buffer cap is hit, without corrupting counters", () => {
    const r = new AvrDiagnosticsRecorder({ maxBufferedLines: 5 });
    for (let i = 0; i < 20; i++) {
      const id = r.nextId();
      r.recordReceived(id, "h", 23, `MV${i}`);
    }
    const log = r.exportLog();
    expect(log).toContain("were evicted");
    expect(r.snapshot().commandsReceived).toBe(20); // counters stay exact regardless of buffer eviction
  });
});
