import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoolMasterProtocolDriver } from "./coolmaster-driver.js";
import { commandToCoolMaster, parseUnitLine } from "./coolmaster-codec.js";

/** An in-process CoolMasterNet bridge: tracks one unit, answers `ls2`, applies commands. */
function startFakeCoolMaster(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  let on = false;
  let setC = 24;
  let mode = "Cool";
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sock.setEncoding("utf8");
      sock.write("\r\n>"); // bridge prompt on connect
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts.map((c) => c.trim()).filter(Boolean)) {
          received.push(cmd);
          if (cmd === "ls2") {
            sock.write(`L1.100 ${on ? "ON " : "OFF"} ${setC.toFixed(1)}C 22.5C Low ${mode} OK - 0\r\n>`);
          } else if (cmd === "on L1.100") { on = true; sock.write("OK\r\n>"); }
          else if (cmd === "off L1.100") { on = false; sock.write("OK\r\n>"); }
          else if (cmd.startsWith("temp L1.100 ")) { setC = Number(cmd.split(" ")[2]); sock.write("OK\r\n>"); }
          else if (cmd === "heat L1.100") { mode = "Heat"; sock.write("OK\r\n>"); }
          else sock.write("OK\r\n>");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received });
    });
  });
}

const nextEvent = (driver: CoolMasterProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = driver.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

describe("CoolMaster codec", () => {
  it("parses ls2 unit lines and encodes commands", () => {
    const unit = parseUnitLine("L1.100 ON 24.0C 22.5C Low Cool OK - 0");
    expect(unit).toMatchObject({ uid: "L1.100", on: true, setC: 24, roomC: 22.5, mode: "cool" });
    expect(commandToCoolMaster("L1.100", { capability: "onoff", action: "off" }, null)).toEqual(["off L1.100"]);
    expect(
      commandToCoolMaster("L1.100", { capability: "temperature", targetC: 22, mode: "heat" }, null),
    ).toEqual(["on L1.100", "heat L1.100", "temp L1.100 22"]);
  });
});

describe("CoolMasterProtocolDriver (in-process bridge over TCP)", () => {
  let bridge: Awaited<ReturnType<typeof startFakeCoolMaster>>;
  let driver: CoolMasterProtocolDriver;
  const dev = "device-hvac-lounge" as DeviceId;

  beforeAll(async () => {
    bridge = await startFakeCoolMaster();
    driver = new CoolMasterProtocolDriver({ host: "127.0.0.1", port: bridge.port, pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
    await driver.bind({ deviceId: dev, capability: "temperature", address: "L1.100" });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => bridge.server.close(() => r()));
  });

  it("turns a unit on and confirms via ls2 poll", async () => {
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });

    const ev = nextEvent(driver, (e) => e.capability === "temperature");
    await driver.poll();
    const state = (await ev).state as { kind: string; targetC: number; mode: string };
    expect(state.kind).toBe("temperature");
    expect(state.targetC).toBe(24);
    expect(state.mode).toBe("cool");
    expect(bridge.received).toContain("ls2");
  });

  it("sets a heat setpoint over real TCP", async () => {
    await driver.command(dev, { capability: "temperature", targetC: 22, mode: "heat" });
    const ev = nextEvent(driver, (e) => e.capability === "temperature");
    await driver.poll();
    const state = (await ev).state as { targetC: number; mode: string };
    expect(state.targetC).toBe(22);
    expect(state.mode).toBe("heat");
    expect(bridge.received).toContain("temp L1.100 22");
  });
});
