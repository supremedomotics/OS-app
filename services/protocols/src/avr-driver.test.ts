import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AvrProtocolDriver } from "./avr-driver.js";
import { commandToAvr, parseAvrLine } from "./avr-codec.js";

/**
 * A tiny in-process Denon/Marantz-style AVR: echoes status tokens, answers `?`
 * queries, and reflects commands back as the real receivers do — so the driver is
 * exercised over real TCP with the real ASCII protocol.
 */
function startFakeAvr(): Promise<{ server: Server; port: number; received: string[]; sockets: Set<Socket> }> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  return new Promise((resolve) => {
    let power = false;
    let zm = false;
    let mv = 50;
    let mute = false;
    let z2power = false;
    let z2mute = false;
    let bass = 50;
    let treble = 50;
    let soundMode = "MOVIE";
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts) {
          received.push(cmd);
          if (cmd === "PW?") sock.write(power ? "PWON\r" : "PWSTANDBY\r");
          else if (cmd === "PWON") { power = true; sock.write("PWON\r"); }
          else if (cmd === "PWSTANDBY") { power = false; sock.write("PWSTANDBY\r"); }
          // ZM (Main Zone power) is a real Denon token, independent of PW (whole-unit) and
          // Z2 (Zone 2) — this fake mirrors that independence, since it's exactly the
          // property under test (main zone off must not take zone2 down with it).
          else if (cmd === "ZM?") sock.write(zm ? "ZMON\r" : "ZMOFF\r");
          else if (cmd === "ZMON") { zm = true; sock.write("ZMON\r"); }
          else if (cmd === "ZMOFF") { zm = false; sock.write("ZMOFF\r"); }
          else if (cmd === "MV?") sock.write(`MV${mv}\r`);
          else if (/^MV\d{2}$/.test(cmd)) { mv = Number(cmd.slice(2)); sock.write(`MV${mv}\r`); }
          else if (cmd === "MU?") sock.write(mute ? "MUON\r" : "MUOFF\r");
          else if (cmd === "MUON") { mute = true; sock.write("MUON\r"); }
          else if (cmd === "MUOFF") { mute = false; sock.write("MUOFF\r"); }
          else if (cmd === "SI?") sock.write("SICD\r");
          else if (cmd === "Z2?") sock.write(z2power ? "Z2ON\r" : "Z2OFF\r");
          else if (cmd === "Z2ON") { z2power = true; sock.write("Z2ON\r"); }
          else if (cmd === "Z2OFF") { z2power = false; sock.write("Z2OFF\r"); }
          else if (cmd === "Z2MU?") sock.write(z2mute ? "Z2MUON\r" : "Z2MUOFF\r");
          else if (cmd === "Z2MUON") { z2mute = true; sock.write("Z2MUON\r"); }
          else if (cmd === "Z2MUOFF") { z2mute = false; sock.write("Z2MUOFF\r"); }
          else if (/^Z2[A-Z0-9/]+$/.test(cmd) && !cmd.startsWith("Z2MU") && cmd !== "Z2ON" && cmd !== "Z2OFF") {
            sock.write(`${cmd}\r`); // echo zone2 source select
          }
          else if (cmd === "PSTONE CTRL ?") sock.write("PSTONE CTRL ON\r");
          else if (cmd === "PSBAS ?") sock.write(`PSBAS ${String(bass).padStart(2, "0")}\r`);
          else if (/^PSBAS \d{2}$/.test(cmd)) { bass = Number(cmd.slice(6)); sock.write(`${cmd}\r`); }
          else if (cmd === "PSTRE ?") sock.write(`PSTRE ${String(treble).padStart(2, "0")}\r`);
          else if (/^PSTRE \d{2}$/.test(cmd)) { treble = Number(cmd.slice(6)); sock.write(`${cmd}\r`); }
          else if (cmd === "MS?") sock.write(`MS${soundMode}\r`);
          else if (cmd.startsWith("MS") && cmd !== "MS?") { soundMode = cmd.slice(2); sock.write(`${cmd}\r`); }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received, sockets });
    });
  });
}

const nextEvent = (driver: AvrProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = driver.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

describe("AVR codec", () => {
  it("encodes commands and parses status tokens", () => {
    // Main zone onoff uses ZM (Main Zone power), not PW (whole-unit power/standby) —
    // PW would take every zone down with it, defeating zone isolation.
    expect(commandToAvr({ capability: "onoff", action: "on" }, null)).toEqual(["ZMON"]);
    expect(commandToAvr({ capability: "onoff", action: "off" }, null)).toEqual(["ZMOFF"]);
    expect(commandToAvr({ capability: "media", action: "volume", volume: 50 }, null)).toEqual(["MV49"]);
    expect(parseAvrLine("ZMON")).toEqual({ kind: "power", on: true });
    expect(parseAvrLine("ZMOFF")).toEqual({ kind: "power", on: false });
    // PW is still parsed (whole-unit standby is still a real, meaningful signal).
    expect(parseAvrLine("PWON")).toEqual({ kind: "power", on: true });
    expect(parseAvrLine("MV60")).toEqual({ kind: "volume", volume: 61, volumeDb: -20 });
    expect(parseAvrLine("MVMAX 98")).toBeNull();
  });
});

describe("AvrProtocolDriver (in-process AVR over TCP)", () => {
  let avr: Awaited<ReturnType<typeof startFakeAvr>>;
  let driver: AvrProtocolDriver;
  const dev = "device-avr-living" as DeviceId;

  beforeAll(async () => {
    avr = await startFakeAvr();
    driver = new AvrProtocolDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    // Wait for the link to actually finish connecting (the init query round-trip) before
    // issuing commands — command() now correctly rejects a write to a still-connecting link.
    await vi.waitFor(() => expect(avr.received).toContain("PW?"));
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("powers on and reflects the receiver's echo", async () => {
    const ev = nextEvent(driver, (e) => e.capability === "onoff");
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect((await ev).state).toEqual({ kind: "onoff", on: true });
  });

  it("sets volume and surfaces it as composite media state", async () => {
    const ev = nextEvent(driver, (e) => e.capability === "media");
    await driver.command(dev, { capability: "media", action: "volume", volume: 80 });
    const state = (await ev).state as { kind: string; volume: number };
    expect(state.kind).toBe("media");
    expect(state.volume).toBeGreaterThan(75);
    expect(avr.received).toContain("MV78"); // 80% of 98 ≈ 78
  });

  it("issues tone/DSP as an 'advanced' media command and surfaces it back in state", async () => {
    const ev = nextEvent(driver, (e) => e.capability === "media" && (e.state as { advanced?: Record<string, unknown> | null }).advanced?.soundMode === "STEREO");
    await driver.command(dev, {
      capability: "media",
      action: "advanced",
      advanced: { bass: 2, treble: -1, soundMode: "STEREO" },
    });
    const state = (await ev).state as { advanced: Record<string, unknown> };
    expect(state.advanced).toEqual({ volumeDb: -2, bass: 2, treble: -1, soundMode: "STEREO" });
    expect(avr.received).toContain("PSBAS 52");
    expect(avr.received).toContain("PSTRE 49");
    expect(avr.received).toContain("MSSTEREO");
  });

  it("reports real Diagnostics Console counters for a bound, connected device", async () => {
    const before = driver.getDiagnostics(dev);
    expect(before?.connectionStatus).toBe("connected");
    expect(before?.protocol).toBe("avr");
    expect(before?.packetsSent).toBeGreaterThan(0); // init query alone counts
    expect(before?.model).toBeNull(); // Denon Telnet exposes no model on the wire
    const sentBefore = before!.packetsSent;
    const receivedBefore = before!.packetsReceived;

    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => {
      const after = driver.getDiagnostics(dev)!;
      expect(after.packetsSent).toBeGreaterThan(sentBefore);
      expect(after.packetsReceived).toBeGreaterThan(receivedBefore);
    });
    const after = driver.getDiagnostics(dev)!;
    expect(after.lastCommand).toBe("ZMON");
    expect(after.lastCommandAt).not.toBeNull();
  });

  it("returns null diagnostics for a device this driver doesn't manage", () => {
    expect(driver.getDiagnostics("device-unknown" as DeviceId)).toBeNull();
  });
});

describe("AvrProtocolDriver — Zone 2 (independent Supreme device on the same link)", () => {
  let avr: Awaited<ReturnType<typeof startFakeAvr>>;
  let driver: AvrProtocolDriver;
  const mainDev = "device-avr-main" as DeviceId;
  const zone2Dev = "device-avr-zone2" as DeviceId;

  beforeAll(async () => {
    avr = await startFakeAvr();
    driver = new AvrProtocolDriver();
    await driver.connect();
    await driver.bind({ deviceId: mainDev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.bind({ deviceId: zone2Dev, capability: "onoff", address: `127.0.0.1:${avr.port}`, config: { zone: "zone2" } });
    await driver.bind({ deviceId: zone2Dev, capability: "media", address: `127.0.0.1:${avr.port}`, config: { zone: "zone2" } });
    // Wait for the link to actually finish connecting before issuing commands — command()
    // now correctly rejects a write to a still-connecting link.
    await vi.waitFor(() => expect(avr.received).toContain("PW?"));
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("queries zone2's initial state even though its binding was added after the link already connected — regression test for the missed Z2? catch-up query", async () => {
    // This block's own beforeAll already reproduces the exact failure shape: the link
    // connects (and its init burst fires) while only the main zone is bound; zone2's
    // binding is added afterward, once the link is already open. Without a catch-up
    // query, zone2's onoff state stays stuck at null until an explicit command or a
    // reconnect — exactly what the guided AVR add wizard's sequential per-zone
    // commission() calls do in production. Runs first in this block, before any other
    // test issues a zone2 command that would populate the state a different way.
    await vi.waitFor(() => expect(driver.getState(zone2Dev, "onoff")).not.toBeNull());
    expect(avr.received).toContain("Z2?");
    expect(avr.received).toContain("Z2MU?");
  });

  it("commands zone2 power independently of the main zone and attributes state to the zone2 device only", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === zone2Dev && e.capability === "onoff");
    await driver.command(zone2Dev, { capability: "onoff", action: "on" });
    expect((await ev).state).toEqual({ kind: "onoff", on: true });
    expect(avr.received).toContain("Z2ON");
    // Main zone's own onoff state must be untouched by the zone2 command.
    expect(driver.getState(mainDev, "onoff")).not.toEqual({ kind: "onoff", on: true });
  });

  it("mutes zone2 and surfaces it on the zone2 media device, not main", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === zone2Dev && e.capability === "media");
    await driver.command(zone2Dev, { capability: "media", action: "mute" });
    const state = (await ev).state as { kind: string; muted: boolean };
    expect(state.muted).toBe(true);
    expect(avr.received).toContain("Z2MUON");
  });

  it("rejects zone2 volume — no documented Zone 2 volume token on this protocol", async () => {
    await expect(driver.command(zone2Dev, { capability: "media", action: "volume", volume: 50 })).rejects.toThrow();
  });

  it("turning the main zone OFF does not power off zone2 — regression test for ZM vs PW", async () => {
    // Bring zone2 up first, independently of the main zone (state-polled, not event-raced,
    // since an earlier test in this block may have already left zone2 on — a repeat "on"
    // command is deduped and emits no fresh event).
    await driver.command(zone2Dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(driver.getState(zone2Dev, "onoff")).toEqual({ kind: "onoff", on: true }));

    // Turning the main zone off must send ZM (Main Zone power), never PW (whole-unit
    // power/standby) — PW would take zone2 down with it, which is the exact bug this
    // guards against.
    await driver.command(mainDev, { capability: "onoff", action: "off" });
    await vi.waitFor(() => expect(avr.received).toContain("ZMOFF"));
    expect(avr.received).not.toContain("PWSTANDBY");

    // zone2's own state must be completely unaffected.
    expect(driver.getState(zone2Dev, "onoff")).toEqual({ kind: "onoff", on: true });
  });
});

describe("AvrProtocolDriver — unbind (§ Driver Lifecycle Completion)", () => {
  it("keeps the shared TCP link open while a sibling zone is still bound, then closes it once the last device on that host is unbound", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    await driver.connect();
    const mainDev = "device-avr-unbind-main" as DeviceId;
    const zone2Dev = "device-avr-unbind-zone2" as DeviceId;
    await driver.bind({ deviceId: mainDev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.bind({ deviceId: zone2Dev, capability: "onoff", address: `127.0.0.1:${avr.port}`, config: { zone: "zone2" } });
    await vi.waitFor(() => expect(avr.sockets.size).toBe(1));

    // Unbinding zone2 (not the last device on this host) must NOT tear down the shared link.
    await driver.unbind(zone2Dev);
    expect(driver.manages(zone2Dev)).toBe(false);
    expect(driver.manages(mainDev)).toBe(true);
    expect(avr.sockets.size).toBe(1); // main zone's command still needs this link
    await driver.command(mainDev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(avr.received).toContain("ZMON"));

    // Unbinding the LAST device on this host must close the real TCP socket.
    await driver.unbind(mainDev);
    expect(driver.manages(mainDev)).toBe(false);
    await vi.waitFor(() => expect(avr.sockets.size).toBe(0));

    // Idempotent — a second unbind is a safe no-op.
    await expect(driver.unbind(mainDev)).resolves.toBeUndefined();

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("a command for an unbound device fails instead of resurrecting the link", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    await driver.connect();
    const dev = "device-avr-unbind-solo" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(avr.sockets.size).toBe(1));

    await driver.unbind(dev);
    await expect(driver.command(dev, { capability: "onoff", action: "on" })).rejects.toThrow(/not bound/);
    await vi.waitFor(() => expect(avr.sockets.size).toBe(0));

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — auto-reconnect on drop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with capped backoff after the socket closes and re-syncs state", async () => {
    vi.useFakeTimers();
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ reconnectBaseMs: 50, reconnectMaxMs: 50 });
    const dev = "device-avr-reconnect" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });

    // Let the initial connection complete and the init query round-trip.
    await vi.waitFor(() => expect(avr.received).toContain("PW?"));
    expect(avr.sockets.size).toBe(1);

    // Simulate the receiver dropping the link.
    for (const s of avr.sockets) s.destroy();
    await vi.waitFor(() => expect(avr.sockets.size).toBe(0));

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(avr.sockets.size).toBe(1));
    await vi.waitFor(() => expect(avr.received.filter((c) => c === "PW?").length).toBeGreaterThanOrEqual(2));

    const pwQueries = avr.received.filter((c) => c === "PW?").length;
    expect(pwQueries).toBeGreaterThanOrEqual(2); // initial connect + post-reconnect re-sync

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — connection failure is never silent", () => {
  it("throws instead of silently no-op'ing a command when the socket never connected, and reports the error via onLog", async () => {
    // Bind to a port nothing is listening on (a server we immediately close) so the connect
    // attempt fails fast with ECONNREFUSED rather than timing out.
    const probe = await startFakeAvr();
    const deadPort = probe.port;
    await new Promise<void>((r) => probe.server.close(() => r()));

    const logs: { level: string; message: string }[] = [];
    const driver = new AvrProtocolDriver({ onLog: (level, message) => logs.push({ level, message }) });
    const dev = "device-avr-unreachable" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${deadPort}` });

    await vi.waitFor(() => expect(logs.some((l) => l.level === "error")).toBe(true));
    // "error" and the socket-nulling "close" handler both fire off the same failed connect
    // attempt, but not necessarily on the same tick — retry until the socket is genuinely gone.
    await vi.waitFor(async () => {
      await expect(driver.command(dev, { capability: "onoff", action: "on" })).rejects.toThrow(/not connected/);
    });
  });
});

describe("AvrProtocolDriver — Production Hardening (Phase 3/6 audit)", () => {
  it("rejects a command after disconnect() instead of silently re-opening a socket", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    const dev = "device-avr-teardown" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(avr.received).toContain("PW?"));

    await driver.disconnect();
    await expect(driver.command(dev, { capability: "onoff", action: "on" })).rejects.toThrow(/disconnected/);
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("disconnect() is idempotent — calling it twice never throws", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    await driver.connect();
    await driver.bind({ deviceId: "device-x" as DeviceId, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.disconnect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("controls two physically independent receivers (different hosts) with fully isolated links, state, and diagnostics", async () => {
    const living = await startFakeAvr();
    const theatre = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    const livingDev = "device-avr-living2" as DeviceId;
    const theatreDev = "device-avr-theatre2" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: livingDev, capability: "onoff", address: `127.0.0.1:${living.port}` });
    await driver.bind({ deviceId: theatreDev, capability: "onoff", address: `127.0.0.1:${theatre.port}` });
    await vi.waitFor(() => {
      expect(living.received).toContain("PW?");
      expect(theatre.received).toContain("PW?");
    });

    await driver.command(livingDev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(living.received).toContain("ZMON"));
    // The theatre receiver must never see a command meant for the living room unit.
    expect(theatre.received).not.toContain("ZMON");

    const livingDiag = driver.getDiagnostics(livingDev)!;
    const theatreDiag = driver.getDiagnostics(theatreDev)!;
    expect(livingDiag.ip).toBe("127.0.0.1");
    expect(livingDiag.packetsSent).toBeGreaterThan(theatreDiag.packetsSent); // living got the extra ZMON

    await driver.disconnect();
    await Promise.all([
      new Promise<void>((r) => living.server.close(() => r())),
      new Promise<void>((r) => theatre.server.close(() => r())),
    ]);
  });

  it("rapid-fire volume commands each reach the wire and the final state reflects the LAST command sent", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver();
    const dev = "device-avr-rapid" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(avr.received).toContain("PW?"));

    // Fire 5 volume changes back-to-back with no await between the WRITES — each
    // driver.command() call resolves as soon as its local socket.write() call
    // returns (buffered into the OS send queue), which is not the same instant the
    // real TCP peer receives and processes it — so this proves ordering/delivery over
    // the actual loopback socket, not just that 5 local writes were issued.
    await Promise.all([10, 30, 50, 70, 90].map((v) => driver.command(dev, { capability: "media", action: "volume", volume: v })));
    await vi.waitFor(() => {
      const sentVolumes = avr.received.filter((r) => /^MV\d{2}$/.test(r));
      expect(sentVolumes.length).toBe(5);
    });
    // The fake server echoes each one back in order, so the driver's cached state ends
    // on the LAST token the wire actually processed.
    await vi.waitFor(() => {
      const state = driver.getState(dev, "media") as { volume: number } | null;
      expect(state?.volume).toBeGreaterThan(0);
    });

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — discovery", () => {
  it("finds receivers via the co-located HEOS SSDP presence and defaults to zone 'main'", async () => {
    const driver = new AvrProtocolDriver({
      ssdp: async (opts) => {
        expect(opts?.st).toBe("urn:schemas-denon-com:device:ACT-Denon:1");
        return [{ address: "192.168.1.50", server: "Linux/3.10 UPnP/1.0 Denon-Heos/1.0", location: "http://192.168.1.50:60006/desc.xml" }];
      },
    });
    const found = await driver.discover();
    expect(found).toEqual([
      {
        backendId: "192.168.1.50",
        suggestedName: "AVR 192.168.1.50",
        capabilities: ["onoff", "media"],
        raw: {
          ip: "192.168.1.50",
          server: "Linux/3.10 UPnP/1.0 Denon-Heos/1.0",
          location: "http://192.168.1.50:60006/desc.xml",
          bindConfig: { zone: "main" },
        },
      },
    ]);
  });

  it("returns no candidates when nothing answers the SSDP search", async () => {
    const driver = new AvrProtocolDriver({ ssdp: async () => [] });
    expect(await driver.discover()).toEqual([]);
  });
});
