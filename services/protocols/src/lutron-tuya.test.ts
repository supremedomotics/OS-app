import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LutronProtocolDriver } from "./lutron-driver.js";
import { commandToLutron, parseLutronLine } from "./lutron-codec.js";
import { TuyaProtocolDriver, type TuyaDevice } from "./tuya-driver.js";

/** In-process Lutron LIP bridge: login/password handshake, #OUTPUT set, ?OUTPUT query, ~OUTPUT reports. */
function startLutron(): Promise<{ server: Server; port: number; received: string[]; levels: Record<string, number> }> {
  const received: string[] = [];
  const levels: Record<string, number> = { "5": 0 };
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sock.setEncoding("utf8");
      sock.write("login: "); // prompt without newline
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split(/\r\n|\r|\n/);
        buf = lines.pop() ?? "";
        for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
          received.push(line);
          if (line === "lutron") sock.write("password: ");
          else if (line === "integration") sock.write("GNET> ");
          else {
            const set = /^#OUTPUT,(\d+),1,(\d+)/.exec(line);
            const qry = /^\?OUTPUT,(\d+),1/.exec(line);
            if (set) {
              levels[set[1]!] = Number(set[2]);
              sock.write(`~OUTPUT,${set[1]},1,${Number(set[2]).toFixed(2)}\r\n`);
            } else if (qry) {
              sock.write(`~OUTPUT,${qry[1]},1,${(levels[qry[1]!] ?? 0).toFixed(2)}\r\n`);
            }
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received, levels });
    });
  });
}

const nextEvent = (d: LutronProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = d.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

describe("Lutron LIP driver (in-process bridge over TCP)", () => {
  let bridge: Awaited<ReturnType<typeof startLutron>>;
  let driver: LutronProtocolDriver;
  const dev = "device-lutron-dimmer" as DeviceId;

  beforeAll(async () => {
    bridge = await startLutron();
    driver = new LutronProtocolDriver({ host: "127.0.0.1", port: bridge.port });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "brightness", address: "5" });
    await new Promise((r) => setTimeout(r, 80)); // allow login handshake
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => bridge.server.close(() => r()));
  });

  it("encodes LIP + parses prompts and ~OUTPUT reports", () => {
    expect(commandToLutron({ capability: "brightness", action: "set", level: 60 }, "5", null)).toBe("#OUTPUT,5,1,60");
    expect(parseLutronLine("login: ")).toEqual({ kind: "login" });
    expect(parseLutronLine("~OUTPUT,5,1,75.00")).toEqual({ kind: "output", id: "5", level: 75 });
  });

  it("authenticates, sets a dimmer level, and reflects the ~OUTPUT report", async () => {
    const ev = nextEvent(driver, (e) => e.capability === "brightness");
    await driver.command(dev, { capability: "brightness", action: "set", level: 60 });
    const s = (await ev).state as { kind: string; on: boolean; level: number };
    expect(s.kind).toBe("brightness");
    expect(s.level).toBe(60);
    expect(s.on).toBe(true);
    // The bridge saw the login handshake + the #OUTPUT command.
    expect(bridge.received).toContain("lutron");
    expect(bridge.received).toContain("integration");
    expect(bridge.received.some((l) => l.startsWith("#OUTPUT,5,1,60"))).toBe(true);
  });
});

describe("Tuya driver (fake DPS device)", () => {
  it("maps capabilities to device-specific data points (DPS) both ways", async () => {
    let dps: Record<string, unknown> = { "1": false, "2": 10 };
    let push: ((d: Record<string, unknown>) => void) | null = null;
    const client: TuyaDevice = {
      connect: async () => {},
      disconnect: async () => {},
      set: async (d) => {
        dps = { ...dps, ...d };
        push?.(d);
      },
      get: async () => dps,
      onData: (h) => void (push = h),
    };
    const driver = new TuyaProtocolDriver({ connect: async () => client });
    await driver.connect();
    const dev = "device-tuya-bulb" as DeviceId;
    // brightMax 1000 → 50% should scale to ~505.
    await driver.bind({
      deviceId: dev,
      capability: "brightness",
      address: "tuya-abc",
      config: { dpOnoff: "1", dpBright: "2", brightMin: 10, brightMax: 1000 },
    });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.command(dev, { capability: "brightness", action: "set", level: 50 });
    expect(dps["1"]).toBe(true);
    expect(dps["2"]).toBe(505); // 10 + 0.5*(1000-10)
    // The device's pushed DPS update came back as a normalized Supreme state.
    const s = events.at(-1)?.state as { kind: string; level: number; on: boolean };
    expect(s.kind).toBe("brightness");
    expect(s.level).toBe(50);
    expect(s.on).toBe(true);
  });
});
