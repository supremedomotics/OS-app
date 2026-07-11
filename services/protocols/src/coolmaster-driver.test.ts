import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoolMasterProtocolDriver } from "./coolmaster-driver.js";

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A fake in-process CoolMasterNet gateway speaking real ASCII_IF framing (greeting +
 * prompt, CR-terminated commands, response-then-prompt) — same pattern the prior
 * driver's test suite used, extended to cover info/line/ls2/mode/advanced-control/
 * secondary-device commands so discovery, control, and feedback are all exercised
 * against something that behaves like the real wire protocol, not a mocked function.
 */
interface FakeGateway {
  server: Server;
  port: number;
  received: string[];
  unit: UnitFixture;
  /** The most recently connected client socket, server-side — lets a test simulate the
   * gateway dropping the connection by destroying it directly. */
  currentSocket: Socket | null;
}

function startFakeGateway(): Promise<FakeGateway> {
  const received: string[] = [];
  const unit: UnitFixture = { on: false, setC: 24, roomC: 22.5, fanSpeed: "Low", mode: "Cool" };
  const gateway: FakeGateway = { server: null as unknown as Server, port: 0, received, unit, currentSocket: null };
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      gateway.currentSocket = sock;
      sock.setEncoding("utf8");
      sock.write("CoolMasterNet v1.0\r\n>");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r");
        buf = parts.pop() ?? "";
        for (const cmd of parts.map((c) => c.trim()).filter(Boolean)) {
          received.push(cmd);
          handleCommand(sock, cmd, unit);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      gateway.server = server;
      gateway.port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(gateway);
    });
  });
}

interface UnitFixture {
  on: boolean;
  setC: number;
  roomC: number;
  fanSpeed: string;
  mode: string;
}

function handleCommand(sock: Socket, cmd: string, unit: UnitFixture): void {
  const ls2Line = () => `L1.100 ${unit.on ? "ON " : "OFF"} ${unit.setC.toFixed(1)}C ${unit.roomC.toFixed(1)}C ${unit.fanSpeed} ${unit.mode} OK - 0`;
  if (cmd === "info") return void sock.write("Serial: GW-TEST-01\r\nFirmware: 3.14\r\n>");
  if (cmd === "line") return void sock.write("L1 Daikin active\r\n>");
  if (cmd === "ls2") return void sock.write(`${ls2Line()}\r\n>`);
  if (cmd === "query L1.100") return void sock.write("Swing: Auto\r\nFilter: no\r\n>");
  if (cmd === "on L1.100") { unit.on = true; return void sock.write("OK\r\n>"); }
  if (cmd === "off L1.100") { unit.on = false; return void sock.write("OK\r\n>"); }
  if (cmd === "heat L1.100") { unit.on = true; unit.mode = "Heat"; return void sock.write("OK\r\n>"); }
  if (cmd.startsWith("temp L1.100 ")) { unit.setC = Number(cmd.split(" ")[2]); return void sock.write("OK\r\n>"); }
  if (cmd.startsWith("fspeed L1.100 ")) { unit.fanSpeed = cmd.split(" ")[2]!; return void sock.write("OK\r\n>"); }
  if (cmd === "wh" || cmd === "vam" || cmd === "main" || cmd === "group") return void sock.write(">"); // none present
  return void sock.write("OK\r\n>");
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

describe("CoolMasterProtocolDriver", () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
  let driver: CoolMasterProtocolDriver;
  const dev = "device-hvac-lounge" as DeviceId;

  beforeEach(async () => {
    gateway = await startFakeGateway();
    driver = new CoolMasterProtocolDriver({
      host: "127.0.0.1",
      asciiPort: gateway.port,
      protocol: "ascii", // no REST server in this fake gateway
      pollMs: 100_000, // tests trigger polls manually via poller internals is not exposed; use command()/discover() instead
      slowPollMs: 100_000,
      discoveryIntervalMs: 100_000,
      timeoutMs: 2_000,
      retryCount: 1,
      backoffBaseMs: 50,
      backoffMaxMs: 200,
    });
  });

  afterEach(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => gateway.server.close(() => r()));
  });

  it("connects and discovers the gateway + indoor unit", async () => {
    await driver.connect();
    const devices = await driver.discover();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ backendId: "L1.100", capabilities: ["onoff", "temperature"] });
    expect(gateway.received).toContain("info");
    expect(gateway.received).toContain("ls2");
  });

  it("binds a device and seeds its initial state from discovery", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
    await driver.bind({ deviceId: dev, capability: "temperature", address: "L1.100" });
    expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: false });
    expect(driver.getState(dev, "temperature")).toMatchObject({ targetC: 24, ambientC: 22.5, mode: "off" });
  });

  it("sends a real on/off command and confirms it via the next poll", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
    await driver.bind({ deviceId: dev, capability: "temperature", address: "L1.100" });

    const ev = nextEvent(driver, (e) => e.capability === "onoff");
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(gateway.received).toContain("on L1.100");
    await ev; // resolves once fastPoll (invoked implicitly by getUnitStatuses below) observes the change
  });

  it("resolves toggle from the currently cached state", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
    await driver.command(dev, { capability: "onoff", action: "toggle" }); // was off -> on
    expect(gateway.received).toContain("on L1.100");
  });

  it("sends mode + setpoint as two ordered commands for one temperature call", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "temperature", address: "L1.100" });
    await driver.command(dev, { capability: "temperature", mode: "heat", targetC: 21 });
    expect(gateway.received).toContain("heat L1.100");
    expect(gateway.received).toContain("temp L1.100 21");
  });

  it("sends an advanced fan-speed command via the temperature capability's advanced bag", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "temperature", address: "L1.100" });
    await driver.command(dev, { capability: "temperature", advanced: { fanSpeed: "High" } });
    expect(gateway.received).toContain("fspeed L1.100 High");
  });

  it("throws for an unbound device", async () => {
    await driver.connect();
    await expect(driver.command(dev, { capability: "onoff", action: "on" })).rejects.toThrow();
  });

  it("reports live feedback through onState from routine polling, not just commands", async () => {
    // A separate, fast-polling driver instance — the shared one above intentionally
    // polls at a very long interval so the OTHER tests aren't timing-dependent; this is
    // the one test that specifically exercises the poll-driven feedback path (as
    // opposed to the command-driven confirm-read path covered elsewhere), so it needs
    // its own short interval.
    const fastDriver = new CoolMasterProtocolDriver({
      host: "127.0.0.1",
      asciiPort: gateway.port,
      protocol: "ascii",
      pollMs: 100,
      slowPollMs: 100_000,
      discoveryIntervalMs: 100_000,
      timeoutMs: 2_000,
      retryCount: 1,
    });
    try {
      await fastDriver.connect();
      await fastDriver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
      gateway.unit.on = true; // simulate the HVAC line itself changing state, outside Supreme
      const ev = nextEvent(fastDriver, (e) => e.capability === "onoff" && (e.state as { on: boolean }).on === true);
      const event = await ev;
      expect(event.state).toEqual({ kind: "onoff", on: true });
    } finally {
      await fastDriver.disconnect();
    }
  });

  it("reconnects automatically after the connection drops", async () => {
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
    expect(driver.isConnected()).toBe(true);

    // Simulate the gateway dropping the TCP connection — destroy the socket from the
    // SERVER side, which is what a real gateway reboot/network blip looks like from the
    // driver's perspective (an unexpected close, not a graceful disconnect() call).
    gateway.currentSocket?.destroy();
    await waitUntil(() => !driver.isConnected(), 2000);

    // The poller's backoffBaseMs/backoffMaxMs are configured low (50ms/200ms) above so
    // this test doesn't need to wait long for the automatic reconnect to complete.
    await waitUntil(() => driver.isConnected(), 3000);

    // Prove the reconnect is FUNCTIONAL, not just that the socket flag flipped back —
    // a command sent after reconnecting must actually reach the (new) gateway session.
    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(gateway.received.filter((c) => c === "on L1.100")).toHaveLength(1);
  });
});
