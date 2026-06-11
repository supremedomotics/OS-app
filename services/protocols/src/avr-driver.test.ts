import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvrProtocolDriver } from "./avr-driver.js";
import { commandToAvr, parseAvrLine } from "./avr-codec.js";

/**
 * A tiny in-process Denon/Marantz-style AVR: echoes status tokens, answers `?`
 * queries, and reflects commands back as the real receivers do — so the driver is
 * exercised over real TCP with the real ASCII protocol.
 */
function startFakeAvr(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  return new Promise((resolve) => {
    let power = false;
    let mv = 50;
    let mute = false;
    const server = createServer((sock: Socket) => {
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
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received });
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
});
