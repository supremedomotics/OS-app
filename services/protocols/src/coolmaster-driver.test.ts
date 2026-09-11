import { createServer, type Server, type Socket } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoolMasterProtocolDriver } from "./coolmaster-driver.js";
import { PROPS_NAME_MAX_LENGTH } from "./coolmaster-commands.js";

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
  const unit: UnitFixture = { on: false, setC: 24, roomC: 22.5, fanSpeed: "Low", mode: "Cool", propName: "Sample room", rejectNameSync: false };
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
  /** § Friendly Name Discovery — the CoolMaster `props` name for L1.100. */
  propName: string;
  /** § Indoor-Unit Name Synchronization — when true, the fake gateway rejects the next
   * `props <uid> name <name>` SET command with "Bad Format" instead of applying it, so
   * tests can exercise the gateway-rejected failure path against a real (fake) TCP
   * round-trip, not a mocked function. */
  rejectNameSync: boolean;
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
  if (cmd === "props") return void sock.write(`L1.100 name ${unit.propName}\r\n>`);
  if (cmd.startsWith("props ") && cmd.includes(" name ")) {
    // § Indoor-Unit Name Synchronization — live-confirmed grammar: "props <uid> name <name>".
    if (unit.rejectNameSync) return void sock.write("Bad Format\r\n>");
    unit.propName = cmd.slice(cmd.indexOf(" name ") + " name ".length);
    return void sock.write("OK\r\n>");
  }
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

  describe("friendly names (§ Friendly Name Discovery)", () => {
    it("uses the CoolMaster props name as the discovered device's display name, UID unaffected", async () => {
      await driver.connect();
      const devices = await driver.discover();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ backendId: "L1.100", suggestedName: "Sample room" });
      expect(gateway.received).toContain("props");
    });

    it("a later props name change is reflected on explicit rediscovery, using the SAME backendId — never a duplicate device", async () => {
      await driver.connect();
      const before = await driver.discover();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ backendId: "L1.100", suggestedName: "Sample room" });

      gateway.unit.propName = "Master Bedroom";
      await driver.refreshDiscovery();
      const after = await driver.discover();

      expect(after).toHaveLength(1); // same single entity, not a second one
      expect(after[0]).toMatchObject({ backendId: "L1.100", suggestedName: "Master Bedroom" });
    });

    it("props is NOT re-sent on ordinary fast polling — only once, at discovery time", async () => {
      const fastDriver = new CoolMasterProtocolDriver({
        host: "127.0.0.1",
        asciiPort: gateway.port,
        protocol: "ascii",
        pollMs: 50,
        slowPollMs: 100_000,
        discoveryIntervalMs: 100_000,
        timeoutMs: 2_000,
        retryCount: 1,
      });
      try {
        await fastDriver.connect();
        expect(gateway.received.filter((c) => c === "props")).toHaveLength(1); // the one connect-time discovery pass
        await new Promise((r) => setTimeout(r, 220)); // several fast-poll cycles at 50ms
        expect(gateway.received.filter((c) => c === "props")).toHaveLength(1); // still just the one
      } finally {
        await fastDriver.disconnect();
      }
    });

    it("props is NOT re-sent as part of a per-command secondary-device refresh", async () => {
      await driver.connect();
      const before = gateway.received.filter((c) => c === "props").length;
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
      await driver.command(dev, { capability: "onoff", action: "on" }); // an indoor-unit command, not a secondary device, but exercises the same connection/queue
      expect(gateway.received.filter((c) => c === "props")).toHaveLength(before);
    });
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

  describe("gateway auto-discovery (§ REQUIREMENT 2)", () => {
    it("throws a clear config error when host is omitted and autoDiscover is not set — no behavior change for existing manual configs", () => {
      expect(() => new CoolMasterProtocolDriver({} as never)).toThrow(/host is required/);
    });

    it("with autoDiscover: true and no gatewaySerial, connect() resolves the host from the ONE gateway a LAN scan finds", async () => {
      const autoDriver = new CoolMasterProtocolDriver({
        autoDiscover: true,
        discoveryCandidateHosts: ["127.0.0.1"],
        asciiPort: gateway.port,
        protocol: "ascii",
        pollMs: 100_000,
        slowPollMs: 100_000,
        discoveryIntervalMs: 100_000,
        timeoutMs: 2_000,
        retryCount: 1,
      });
      try {
        await autoDriver.connect();
        expect(autoDriver.isConnected()).toBe(true);
        const devices = await autoDriver.discover();
        expect(devices[0]).toMatchObject({ backendId: "L1.100" });
      } finally {
        await autoDriver.disconnect();
      }
    });

    it("with autoDiscover: true and a gatewaySerial that matches nothing found, connect() rejects rather than silently picking a different gateway", async () => {
      const autoDriver = new CoolMasterProtocolDriver({
        autoDiscover: true,
        gatewaySerial: "NOT-THE-REAL-SERIAL",
        discoveryCandidateHosts: ["127.0.0.1"],
        asciiPort: gateway.port,
        protocol: "ascii",
        timeoutMs: 500,
      });
      await expect(autoDriver.connect()).rejects.toThrow(/no gateway with serial/);
    });

    it("with autoDiscover: true and no gatewaySerial, connect() rejects when zero gateways are found — never proceeds with a blank host", async () => {
      const autoDriver = new CoolMasterProtocolDriver({
        autoDiscover: true,
        discoveryCandidateHosts: ["127.0.0.1"],
        asciiPort: 1, // nothing listens there
        protocol: "ascii",
        timeoutMs: 300,
      });
      await expect(autoDriver.connect()).rejects.toThrow(/found no CoolMaster gateways/);
    });

    it("§ live-confirmed fix — with autoDiscover: true AND a known host, connect() uses the fast direct path and never runs a LAN scan at all", async () => {
      // No discoveryCandidateHosts given at all — if this fell back to a scan, it would try
      // to enumerate this machine's real network interfaces instead of the fake gateway,
      // and almost certainly fail to find it. Connecting successfully here IS the proof no
      // scan ever ran.
      const autoDriver = new CoolMasterProtocolDriver({
        autoDiscover: true,
        host: "127.0.0.1",
        gatewaySerial: "GW-TEST-01",
        asciiPort: gateway.port,
        protocol: "ascii",
        pollMs: 100_000,
        slowPollMs: 100_000,
        discoveryIntervalMs: 100_000,
        timeoutMs: 2_000,
        retryCount: 1,
      });
      try {
        await autoDriver.connect();
        expect(autoDriver.isConnected()).toBe(true);
      } finally {
        await autoDriver.disconnect();
      }
    });

    it("§ live-confirmed fix — with autoDiscover: true and a STALE known host that doesn't answer, connect() falls back to a fresh LAN scan and recovers (the actual DHCP-change recovery path)", async () => {
      // A real gateway's port doesn't change on a DHCP renewal — only its IP does — so the
      // "stale" case is: same asciiPort, wrong host. 127.0.0.2 has nothing listening;
      // discoveryCandidateHosts gives the fallback scan the REAL address (127.0.0.1) to find
      // instead, using the SAME port the gateway actually listens on.
      const autoDriver = new CoolMasterProtocolDriver({
        autoDiscover: true,
        host: "127.0.0.2", // stale/wrong IP — nothing listens here
        gatewaySerial: "GW-TEST-01",
        discoveryCandidateHosts: ["127.0.0.1"], // the fallback scan finds the real gateway here
        asciiPort: gateway.port,
        protocol: "ascii",
        timeoutMs: 500,
        retryCount: 1,
      });
      try {
        await autoDriver.connect();
        expect(autoDriver.isConnected()).toBe(true); // recovered via the fallback scan
        const devices = await autoDriver.discover();
        expect(devices[0]).toMatchObject({ backendId: "L1.100" });
      } finally {
        await autoDriver.disconnect();
      }
    });
  });

  describe("§ Indoor-Unit Name Synchronization (live-confirmed: 'props <uid> name <name>' -> OK)", () => {
    it("basic rename: sends the live-confirmed command, gets OK, and reports synced", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      const result = await driver.syncIndoorUnitName(dev, "Living Room");

      expect(gateway.received).toContain("props L1.100 name Living Room");
      expect(result).toEqual({ status: "synced" });
      expect(driver.getCoolMasterName(dev)).toBe("Living Room"); // reflected immediately, no rediscovery needed
      expect(driver.getNameSyncState(dev)).toMatchObject({ desiredName: "Living Room", status: "synced", error: null });
    });

    it("rename with spaces sends the name verbatim (internal whitespace preserved)", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      await driver.syncIndoorUnitName(dev, "Master Bedroom");

      expect(gateway.received).toContain("props L1.100 name Master Bedroom");
    });

    it("§ live-confirmed fix — a real 22-character name is NOT rejected by an invented length limit (regression: an earlier revision's assumed 20-character cap silently blocked this exact name)", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      const realWorldName = "Sample room for L1.101"; // 22 characters — live-confirmed to break with the old cap
      const result = await driver.syncIndoorUnitName(dev, realWorldName);

      expect(result).toEqual({ status: "synced" });
      expect(gateway.received).toContain(`props L1.100 name ${realWorldName}`);
    });

    it("a too-long name is rejected by validation and never reaches the wire", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      const tooLong = "A".repeat(PROPS_NAME_MAX_LENGTH + 1);
      const result = await driver.syncIndoorUnitName(dev, tooLong);

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/exceeding/);
      expect(gateway.received.some((c) => c.startsWith("props L1.100 name"))).toBe(false);
    });

    it("an empty name is rejected by validation and never reaches the wire", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      const result = await driver.syncIndoorUnitName(dev, "   ");

      expect(result.status).toBe("failed");
      expect(gateway.received.some((c) => c.startsWith("props L1.100 name"))).toBe(false);
    });

    it("a gateway rejection ('Bad Format') is reported as a failed sync, never mistaken for success", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
      gateway.unit.rejectNameSync = true;

      const result = await driver.syncIndoorUnitName(dev, "Living Room");

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/did not confirm/);
      expect(driver.getNameSyncState(dev)).toMatchObject({ status: "failed" });
    });

    it("throws for a device this driver instance does not manage", async () => {
      await driver.connect();
      await expect(driver.syncIndoorUnitName(dev, "Living Room")).rejects.toThrow(/not managed/);
    });

    it("rapid renames coalesce to the LATEST desired name — an in-between value is never written, and the final state is always correct", async () => {
      // § dedupe realism — the queue's coalesce-to-latest can only supersede a QUEUED item,
      // not one already shifted out and executing ("in flight"). Issuing all three calls in
      // the exact same microtask tick (Promise.all with no real elapsed time between them)
      // means the FIRST one ("Lounge") is already in flight the instant "Family Room" is
      // enqueued, so it can't be superseded and genuinely reaches the wire too — a real,
      // correct property of a serialized queue that can't cancel in-flight work, not a bug.
      // The middle value ("Family Room") is still queued when "Great Room" arrives, so THAT
      // one is guaranteed to be superseded and never sent — the actual guarantee this test
      // proves, plus that the driver's final state always converges on the last desired name.
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });

      const before = gateway.received.length;
      const [, second, third] = await Promise.all([
        driver.syncIndoorUnitName(dev, "Lounge"),
        driver.syncIndoorUnitName(dev, "Family Room"),
        driver.syncIndoorUnitName(dev, "Great Room"),
      ]);
      const propsSent = gateway.received.slice(before).filter((c) => c.startsWith("props L1.100 name"));

      expect(propsSent).not.toContain("props L1.100 name Family Room"); // superseded before it ever ran
      expect(propsSent[propsSent.length - 1]).toBe("props L1.100 name Great Room"); // the final write is always the latest desired name
      expect(driver.getCoolMasterName(dev)).toBe("Great Room");
      // The superseded caller is told so, honestly, rather than a fabricated success.
      expect(second!.status).toBe("failed");
      expect(second!.error).toMatch(/superseded/);
      expect(third).toEqual({ status: "synced" });
    });

    it("a duplicate rename (identical desired name) still performs a real write when called directly — 'no unnecessary write' is a RECONCILIATION policy, not a guard on every explicit call", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
      await driver.syncIndoorUnitName(dev, "Living Room");
      const before = gateway.received.filter((c) => c === "props L1.100 name Living Room").length;

      await driver.syncIndoorUnitName(dev, "Living Room");

      expect(gateway.received.filter((c) => c === "props L1.100 name Living Room")).toHaveLength(before + 1);
    });

    it("uidFor/getCoolMasterName return null for an unmanaged or unbound device", () => {
      const unmanaged = "device-not-bound" as DeviceId;
      expect(driver.uidFor(unmanaged)).toBeNull();
      expect(driver.getCoolMasterName(unmanaged)).toBeNull();
      expect(driver.getNameSyncState(unmanaged)).toBeNull();
    });

    it("uses the existing serialized command queue and connection — no second TCP connection is opened", async () => {
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "onoff", address: "L1.100" });
      const connectionsBefore = gateway.received.filter((c) => c === "info").length;

      await driver.syncIndoorUnitName(dev, "Living Room");

      // "info" only runs once, at the original connect() — a second networking path would
      // show up as another connection handshake (another "info"), which never happens.
      expect(gateway.received.filter((c) => c === "info")).toHaveLength(connectionsBefore);
    });
  });
});
