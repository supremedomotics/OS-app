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
    expect(commandToAvr({ capability: "onoff", action: "on" }, null)).toEqual(["PWON"]);
    expect(commandToAvr({ capability: "media", action: "volume", volume: 50 }, null)).toEqual(["MV49"]);
    expect(parseAvrLine("PWON")).toEqual({ kind: "power", on: true });
    expect(parseAvrLine("MV60")).toEqual({ kind: "volume", volume: 61 });
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
    expect(state.advanced).toEqual({ bass: 2, treble: -1, soundMode: "STEREO" });
    expect(avr.received).toContain("PSBAS 52");
    expect(avr.received).toContain("PSTRE 49");
    expect(avr.received).toContain("MSSTEREO");
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
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
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
