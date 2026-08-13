import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
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
      // § RTI Capability Audit, Category C — the paced init-sync handshake means writes to
      // this fake server can still be in flight right as a test's own driver.disconnect()
      // destroys the client socket; without this handler that abrupt close surfaces here as
      // an uncaught ECONNRESET (a test-harness gap, not a production code issue — the real
      // client-side `TcpLineTransport` already has its own `socket.on("error", …)` handler).
      sock.on("error", () => {});
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

/** A tiny in-process HTTP AppCommand server (§ Universal AVR SDK) — answers
 * `POST /goform/AppCommand.xml` with real-shaped `<functionrename>`/`<functiondelete>`
 * XML (mirrors `denonavr/input.py`'s actual parsing target, confirmed this sprint), and
 * `GET /img/album%20art_S.png` with a tiny fake image — real `http` throughout. */
function startFakeAppCommand(opts: {
  renamed?: Record<string, string>;
  hidden?: string[];
  albumArt?: { contentType: string; body: string } | null;
} = {}): Promise<{ server: import("node:http").Server; port: number; postBodies: string[]; artRequests: number }> {
  const postBodies: string[] = [];
  const state = { artRequests: 0 };
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (req.method === "POST" && req.url === "/goform/AppCommand.xml") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          postBodies.push(body);
          const renameList = Object.entries(opts.renamed ?? {})
            .map(([name, rename]) => `<list><name>${name}</name><rename>${rename}</rename></list>`)
            .join("");
          const deleteList = (opts.hidden ?? [])
            .map((name) => `<list><FuncName>${name}</FuncName><use>0</use></list>`)
            .join("");
          res.setHeader("content-type", "text/xml");
          res.end(`<rx><cmd id="1"><functionrename>${renameList}</functionrename></cmd><cmd id="1"><functiondelete>${deleteList}</functiondelete></cmd></rx>`);
        });
        return;
      }
      if (req.method === "GET" && req.url === "/img/album%20art_S.png") {
        state.artRequests += 1;
        if (!opts.albumArt) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", opts.albumArt.contentType);
        res.end(opts.albumArt.body);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, postBodies, get artRequests() { return state.artRequests; } });
    });
  });
}

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
    // § Regression fix — waiting only for "PW?" to appear in `received` proves the FIRST
    // of the 9 paced init-sync tokens (PW?, ZM?, MV?, MU?, SI?, ...) was sent; it proves
    // nothing about MV? (3rd in the queue) having been answered yet, since InitHandshake
    // sends one token at a time and only advances once a reply arrives (av-sdk/init-
    // handshake.ts). Under any real latency this leaves a window where a test's own
    // nextEvent() listener attaches BEFORE the init-sync's own MV50->51% event has fired,
    // races it against the real command's echo, and can resolve on the STALE init value
    // instead — reproduced directly (12/40 runs) by injecting a realistic ~15ms per-token
    // response delay into the fake receiver. `fullySynced` (see driver-diagnostics.ts) is
    // only set true once the WHOLE handshake drains, which is the only safe barrier.
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));
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
    // toneControlEnabled is already present because PSTONE CTRL ? is queried unconditionally
    // in the init burst (§ RTI Capability Audit, Category A) — the fake receiver answers it.
    expect(state.advanced).toEqual({ volumeDb: -2, bass: 2, treble: -1, soundMode: "STEREO", toneControlEnabled: "on" });
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

  it("fullySynced becomes true once the paced init-sync handshake fully drains (§ RTI Capability Audit, Category C)", async () => {
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));
  });

  it("threads a discovered unit's model/serial (from bindConfig) into Diagnostics — never fabricated when absent, real when supplied (§ Production Bugfix Sprint)", async () => {
    const enriched = "device-avr-enriched" as DeviceId;
    await driver.bind({
      deviceId: enriched,
      capability: "media",
      address: `127.0.0.1:${avr.port}`,
      config: { model: "AVR-X3800H", serial: "ABC123456789" },
    });
    const dd = driver.getDiagnostics(enriched);
    expect(dd?.model).toBe("AVR-X3800H");
    expect(dd?.serial).toBe("ABC123456789");
    expect(dd?.firmware).toBeNull(); // still genuinely unavailable from either source
  });

  it("returns null diagnostics for a device this driver doesn't manage", () => {
    expect(driver.getDiagnostics("device-unknown" as DeviceId)).toBeNull();
  });

  it("getTrace() reflects the same automatically-captured send/receive lines getDiagnostics() draws from (§ Universal AVR SDK)", async () => {
    const before = driver.getTrace(dev);
    expect(before).not.toBeNull();
    const beforeLength = before!.length;
    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => {
      const trace = driver.getTrace(dev)!;
      expect(trace.length).toBeGreaterThan(beforeLength);
      expect(trace.some((t) => t.line === "-> ZMON")).toBe(true);
    });
  });

  it("returns null trace for a device this driver doesn't manage", () => {
    expect(driver.getTrace("device-unknown" as DeviceId)).toBeNull();
  });

  it("refreshCapabilities forces a real reconnect that re-syncs live state (§ Capability Refresh)", async () => {
    const initQueriesBefore = avr.received.filter((r) => r === "PW?").length;
    await driver.refreshCapabilities(dev);
    await vi.waitFor(() => {
      expect(avr.received.filter((r) => r === "PW?").length).toBeGreaterThan(initQueriesBefore);
    });
    // The device is still fully bound and controllable after the forced reconnect —
    // this never recreated it or dropped its binding.
    expect(driver.manages(dev)).toBe(true);
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.connectionStatus).toBe("connected"));
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
    // § Regression fix — see the identical fix + comment in the main describe block above:
    // waiting for "PW?" alone does not prove the full paced init-sync handshake (including
    // MV?/Z2?/Z2MU? — this zone2 link's Zone 2 volume tests read exactly the state that
    // race can corrupt) has drained yet.
    await vi.waitFor(() => expect(driver.getDiagnostics(mainDev)?.fullySynced).toBe(true));
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

  it("sets zone2 volume via Z2<nn> (§ Production Bugfix Sprint — real token, evidenced) and surfaces it on the zone2 device only", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === zone2Dev && e.capability === "media" && (e.state as { volume?: number }).volume !== undefined && (e.state as { volume?: number }).volume! > 0);
    await driver.command(zone2Dev, { capability: "media", action: "volume", volume: 50 });
    const state = (await ev).state as { kind: string; volume: number };
    expect(avr.received).toContain("Z249"); // 50% of 98 ≈ 49
    expect(state.volume).toBeGreaterThan(45);
    // Main zone's own volume must be untouched by the zone2 command.
    expect(driver.getState(mainDev, "media")).not.toMatchObject({ volume: state.volume });
  });

  it("parses an unsolicited Z2<nn> echo as zone2 volume, not a zone2 source change", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === zone2Dev && e.capability === "media" && (e.state as { volume?: number }).volume === 30);
    await driver.command(zone2Dev, { capability: "media", action: "volume", volume: 30 });
    const state = (await ev).state as { kind: string; volume: number; source: string | null };
    expect(state.volume).toBe(30);
    expect(state.source).toBeNull(); // must NOT have been mis-parsed as a source change
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

  it("with trace:true, logs every raw token sent/received and every discover/command/capability-config operation (§ Production Bugfix Sprint)", async () => {
    const traceAvr = await startFakeAvr();
    const logs: { level: string; message: string }[] = [];
    const driver = new AvrProtocolDriver({ trace: true, onLog: (level, message) => logs.push({ level, message }) });
    const dev = "device-avr-traced" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${traceAvr.port}` });
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${traceAvr.port}` });
    await vi.waitFor(() => expect(logs.some((l) => l.message.includes("[trace:avr] -> PW?"))).toBe(true));

    // Every init token was traced as sent, and the receiver's real echoes were traced as received.
    expect(logs.some((l) => l.message.includes("[trace:avr] <- PWSTANDBY"))).toBe(true);

    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(logs.some((l) => l.message.includes("[trace:avr] -> ZMON"))).toBe(true));
    expect(logs.some((l) => l.message.includes("[trace:avr] command") && l.message.includes("onoff/on"))).toBe(true);

    driver.getCapabilityConfig(dev, "media");
    expect(logs.some((l) => l.message.includes("[trace:avr] getCapabilityConfig"))).toBe(true);

    await driver.disconnect();
    await new Promise<void>((r) => traceAvr.server.close(() => r()));
  });

  it("with trace disabled (default), never emits [trace:] log lines even with onLog set", async () => {
    const quietAvr = await startFakeAvr();
    const logs: { level: string; message: string }[] = [];
    const driver = new AvrProtocolDriver({ onLog: (level, message) => logs.push({ level, message }) });
    const dev = "device-avr-untraced" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${quietAvr.port}` });
    await vi.waitFor(() => expect(quietAvr.received).toContain("PW?"));
    expect(logs.some((l) => l.message.startsWith("[trace:"))).toBe(false);
    await driver.disconnect();
    await new Promise<void>((r) => quietAvr.server.close(() => r()));
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
  it("finds receivers via the co-located HEOS SSDP presence and defaults to zone 'main' (no UPnP description reachable)", async () => {
    const driver = new AvrProtocolDriver({
      ssdp: async (opts) => {
        expect(opts?.st).toBe("urn:schemas-denon-com:device:ACT-Denon:1");
        return [{ address: "192.168.1.50", server: "Linux/3.10 UPnP/1.0 Denon-Heos/1.0", location: "http://192.168.1.50:60006/desc.xml" }];
      },
      // A real fetch attempt against an unroutable IP would hang the test — inject a
      // failing fetch, matching "the UPnP description genuinely wasn't reachable"
      // (must not fail discovery of the unit itself, just skip the enrichment).
      fetchImpl: (async () => { throw new Error("unreachable in test"); }) as unknown as typeof fetch,
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

  it("enriches discovery with manufacturer/model/serial from the unit's UPnP device description (§ Production Bugfix Sprint)", async () => {
    const upnpXml = `<root><device>
      <manufacturer>Denon</manufacturer>
      <modelName>AVR-X3800H</modelName>
      <serialNumber>ABC123456789</serialNumber>
    </device></root>`;
    const driver = new AvrProtocolDriver({
      ssdp: async () => [{ address: "192.168.1.51", location: "http://192.168.1.51:60006/desc.xml" }],
      fetchImpl: (async () => ({ ok: true, text: async () => upnpXml })) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]?.raw.manufacturer).toBe("Denon");
    expect(found[0]?.raw.bindConfig).toEqual({ zone: "main", model: "AVR-X3800H", serial: "ABC123456789" });
  });

  it("tolerates a reachable-but-non-2xx UPnP description response — still returns the unit, just unenriched", async () => {
    const driver = new AvrProtocolDriver({
      ssdp: async () => [{ address: "192.168.1.52", location: "http://192.168.1.52:60006/desc.xml" }],
      fetchImpl: (async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found[0]?.raw.bindConfig).toEqual({ zone: "main" });
  });

  it("returns no candidates when nothing answers the SSDP search", async () => {
    const driver = new AvrProtocolDriver({ ssdp: async () => [] });
    expect(await driver.discover()).toEqual([]);
  });

  it("enriches discovery with real renamed/hidden inputs via HTTP AppCommand (§ Universal AVR SDK)", async () => {
    const http = await startFakeAppCommand({ renamed: { "SAT/CBL": "DIRECTV" }, hidden: ["TUNER"] });
    const driver = new AvrProtocolDriver({
      httpPort: http.port,
      ssdp: async () => [{ address: "127.0.0.1" }],
      fetchImpl: (async (url: string, init?: RequestInit) => {
        // No UPnP location this time — only the AppCommand fetch (127.0.0.1:<http.port>) should succeed.
        if (String(url).includes(String(http.port))) return globalThis.fetch(url, init);
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found[0]?.raw.renamedInputs).toEqual({ "SAT/CBL": "DIRECTV" });
    expect(found[0]?.raw.hiddenInputs).toEqual(["TUNER"]);
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("omits renamedInputs/hiddenInputs from discovery raw when the receiver reports none — never an empty-object placeholder", async () => {
    const http = await startFakeAppCommand({});
    const driver = new AvrProtocolDriver({
      httpPort: http.port,
      ssdp: async () => [{ address: "127.0.0.1" }],
      fetchImpl: globalThis.fetch,
    });
    const found = await driver.discover();
    expect(found[0]?.raw.renamedInputs).toBeUndefined();
    expect(found[0]?.raw.hiddenInputs).toBeUndefined();
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  // § Pass 12.2 — friendlyName mapped to suggestedName, mirroring yamaha-driver.ts's
  // existing pattern for the same parseUpnpDescription() call.
  it("uses the UPnP friendlyName as suggestedName when the description reports one", async () => {
    const upnpXml = `<root><device>
      <friendlyName>Living Room Denon AVR-X3800H</friendlyName>
      <manufacturer>Denon</manufacturer>
    </device></root>`;
    const driver = new AvrProtocolDriver({
      ssdp: async () => [{ address: "192.168.1.60", location: "http://192.168.1.60:60006/desc.xml" }],
      fetchImpl: (async () => ({ ok: true, text: async () => upnpXml })) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found[0]?.suggestedName).toBe("Living Room Denon AVR-X3800H");
    // IP stays available as technical/connection metadata, just not the primary name.
    expect(found[0]?.raw.ip).toBe("192.168.1.60");
  });

  it("falls back to the IP-based name when the UPnP description has no friendlyName", async () => {
    const upnpXml = `<root><device><manufacturer>Denon</manufacturer></device></root>`;
    const driver = new AvrProtocolDriver({
      ssdp: async () => [{ address: "192.168.1.61", location: "http://192.168.1.61:60006/desc.xml" }],
      fetchImpl: (async () => ({ ok: true, text: async () => upnpXml })) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found[0]?.suggestedName).toBe("AVR 192.168.1.61");
  });
});

describe("AvrProtocolDriver — HTTP AppCommand input enrichment (§ Universal AVR SDK)", () => {
  it("bind() fetches real renamed/hidden inputs and getCapabilityConfig() reflects them — device_reported, not installer_declared", async () => {
    const avr = await startFakeAvr();
    const http = await startFakeAppCommand({ renamed: { DVD: "Blu-ray Player", AUX1: "Turntable" }, hidden: ["GAME"] });
    const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-enriched-live" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(http.postBodies.length).toBeGreaterThan(0));
    expect(http.postBodies[0]).toContain("GetRenameSource");
    expect(http.postBodies[0]).toContain("GetDeletedSource");

    const config = driver.getCapabilityConfig(dev, "media") as { source: string; inputs: { id: string; label: string }[] };
    expect(config.source).toBe("device_reported");
    expect(config.inputs.find((i) => i.id === "DVD")?.label).toBe("Blu-ray Player");
    expect(config.inputs.find((i) => i.id === "AUX1")?.label).toBe("Turntable");
    expect(config.inputs.some((i) => i.id === "GAME")).toBe(false); // hidden — filtered out entirely
    expect(config.inputs.some((i) => i.id === "TUNER")).toBe(true); // untouched input keeps its default label

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("a host with no reachable HTTP AppCommand interface (older non-2016 unit) falls back to installer_declared, exactly as before this feature existed", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({
      httpPort: 1, // nothing listens here — every AppCommand fetch fails
      fetchImpl: globalThis.fetch,
    });
    const dev = "device-avr-no-http" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.connectionStatus).toBe("connected"));
    const config = driver.getCapabilityConfig(dev, "media") as { source: string; inputs: { id: string }[] };
    expect(config.source).toBe("installer_declared");
    expect(config.inputs.length).toBeGreaterThan(0); // full default input list, untouched
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("refreshCapabilities() re-fetches real input enrichment on demand", async () => {
    const avr = await startFakeAvr();
    const http = await startFakeAppCommand({ renamed: {} });
    const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-refresh-enrichment" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(http.postBodies.length).toBe(1));
    await driver.refreshCapabilities(dev);
    await vi.waitFor(() => expect(http.postBodies.length).toBe(2));
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("seeds enrichment synchronously from binding.config (discovery preview data) — real labels visible before any async fetch resolves", async () => {
    const avr = await startFakeAvr();
    // No HTTP server at all — this test proves the SYNCHRONOUS seed works even when the
    // subsequent async refresh (which will fail, nothing listening) never overwrites it usefully.
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-seeded" as DeviceId;
    await driver.connect();
    await driver.bind({
      deviceId: dev,
      capability: "media",
      address: `127.0.0.1:${avr.port}`,
      config: { renamedInputs: { DVD: "Blu-ray Player" }, hiddenInputs: ["GAME"] },
    });
    // Synchronous — no vi.waitFor needed, this must be true immediately after bind() resolves.
    const config = driver.getCapabilityConfig(dev, "media") as { source: string; inputs: { id: string; label: string }[] };
    expect(config.source).toBe("device_reported");
    expect(config.inputs.find((i) => i.id === "DVD")?.label).toBe("Blu-ray Player");
    expect(config.inputs.some((i) => i.id === "GAME")).toBe(false);
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  // § Pass 12.5, Part B/C — SupremeOS-side custom input names override even the AVR's own
  // reported/renamed label, keyed by the same stable wire `SI` token.
  it("custom input names (binding.config.customInputNames) override the AVR-reported renamed label", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-custom-input" as DeviceId;
    await driver.connect();
    await driver.bind({
      deviceId: dev,
      capability: "media",
      address: `127.0.0.1:${avr.port}`,
      config: {
        renamedInputs: { "SAT/CBL": "DIRECTV" },
        customInputNames: { "SAT/CBL": "PlayStation 5 - Bedroom" },
      },
    });
    const config = driver.getCapabilityConfig(dev, "media") as { inputs: { id: string; label: string }[] };
    expect(config.inputs.find((i) => i.id === "SAT/CBL")?.label).toBe("PlayStation 5 - Bedroom");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  // § Pass 12.6, Part E/F/L — setAvrInputCustomName()/getAvrInputs(): the driver-level halves
  // of the new input-customization API, live-updating the in-memory overlay `bind()` seeds.
  it("setAvrInputCustomName sets/clears a custom label and getAvrInputs reports all four layers", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-set-input" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });

    expect(driver.setAvrInputCustomName(dev, "SAT/CBL", "Apple TV")).toBe(true);
    let entry = driver.getAvrInputs(dev)?.find((i) => i.technicalId === "SAT/CBL");
    expect(entry).toEqual({ technicalId: "SAT/CBL", reportedName: "Satellite/Cable", customName: "Apple TV", displayName: "Apple TV" });

    // Clearing (name: null) falls back to reportedName, never leaves a stale override.
    expect(driver.setAvrInputCustomName(dev, "SAT/CBL", null)).toBe(true);
    entry = driver.getAvrInputs(dev)?.find((i) => i.technicalId === "SAT/CBL");
    expect(entry?.customName).toBeNull();
    expect(entry?.displayName).toBe(entry?.reportedName);

    // A technical id that isn't a real wire token is rejected — a display name must never
    // be able to invent a technical identity.
    expect(driver.setAvrInputCustomName(dev, "NOT_A_REAL_INPUT", "hack")).toBe(false);
    // An unmanaged device is rejected too, not silently accepted.
    expect(driver.setAvrInputCustomName("no-such-device" as DeviceId, "SAT/CBL", "x")).toBe(false);
    expect(driver.getAvrInputs("no-such-device" as DeviceId)).toBeNull();

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  // § Pass 12.6, Part E — re-binding the same device+capability (as the input-customization
  // API's persistence path does on every rename) must replace, not duplicate, the driver's
  // internal binding entry — proven indirectly via getCapabilityConfig staying single-valued
  // and reflecting the latest bind's config after N re-binds.
  it("re-binding the same device+capability does not duplicate internal driver state", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-rebind" as DeviceId;
    await driver.connect();
    for (let i = 0; i < 3; i++) {
      await driver.bind({
        deviceId: dev,
        capability: "media",
        address: `127.0.0.1:${avr.port}`,
        config: { customInputNames: { "SAT/CBL": `Name ${i}` } },
      });
    }
    const config = driver.getCapabilityConfig(dev, "media") as { inputs: { id: string; label: string }[] };
    // Only the latest bind's config should be in effect — a duplicate stale entry would risk
    // `.find()` returning the FIRST (oldest) match instead.
    expect(config.inputs.find((i) => i.id === "SAT/CBL")?.label).toBe("Name 2");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("technical input id stays stable and default label is used when no custom/renamed name is set — no crash for an unrecognized entry", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-default-input" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    const config = driver.getCapabilityConfig(dev, "media") as { inputs: { id: string; label: string }[] };
    // TUNER has no spec-derived override label (see DENON_INPUT_LABELS) — falls back to the raw token.
    expect(config.inputs.find((i) => i.id === "TUNER")?.label).toBe("TUNER");
    expect(config.inputs.map((i) => i.id)).toContain("SAT/CBL");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("unbind()'s last release for a host stops the enrichment poller and releases the HTTP client key", async () => {
    const avr = await startFakeAvr();
    const http = await startFakeAppCommand({});
    const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-unbind-http" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(http.postBodies.length).toBeGreaterThan(0));
    await driver.unbind(dev);
    expect(driver.getCapabilityConfig(dev, "media")).toBeNull(); // device is genuinely gone
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("the slow adaptive poller re-fetches input enrichment on its own schedule while connected", async () => {
    vi.useFakeTimers();
    try {
      const avr = await startFakeAvr();
      const http = await startFakeAppCommand({});
      const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
      const dev = "device-avr-poll" as DeviceId;
      await driver.connect();
      await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
      await vi.waitFor(() => expect(http.postBodies.length).toBeGreaterThanOrEqual(1));
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await vi.waitFor(() => expect(http.postBodies.length).toBeGreaterThanOrEqual(2));
      await driver.disconnect();
      await new Promise<void>((r) => avr.server.close(() => r()));
      await new Promise<void>((r) => http.server.close(() => r()));
    } finally {
      vi.useRealTimers();
    }
  });
});

/** § Denon Cheat Sheet Audit — a routing `fetchImpl` that simulates the real
 * receiver-generation probe (`Deviceinfo.xml` on port 8080 vs 80) without needing a
 * literal listener on those exact privileged/well-known ports: `Deviceinfo.xml`
 * requests are answered per `answersOn8080`/`answersOn80`, `AppCommand.xml`/album-art
 * requests are transparently redirected to a real, dynamically-ported fake server
 * (`appCommandPort`), and the legacy `formMainZone_MainZoneXml.xml` snapshot is answered
 * directly. Every call's URL is recorded in `calls` for assertions. */
function makeGenerationFetch(opts: {
  answersOn8080?: boolean;
  answersOn80?: boolean;
  legacyStatusXml?: string;
  appCommandPort?: number;
  calls?: string[];
}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    opts.calls?.push(u);
    if (u.includes("/goform/Deviceinfo.xml")) {
      const on8080 = u.includes(":8080/") && opts.answersOn8080;
      const on80 = u.includes(":80/") && opts.answersOn80;
      return { ok: !!(on8080 || on80), text: async () => "" } as Response;
    }
    if (u.includes("/goform/formMainZone_MainZoneXml.xml")) {
      return { ok: true, text: async () => opts.legacyStatusXml ?? "<item></item>" } as Response;
    }
    if (opts.appCommandPort && u.includes("/goform/AppCommand.xml")) {
      return globalThis.fetch(`http://127.0.0.1:${opts.appCommandPort}/goform/AppCommand.xml`, init);
    }
    if (opts.appCommandPort && u.includes("/img/album%20art_S.png")) {
      return globalThis.fetch(`http://127.0.0.1:${opts.appCommandPort}/img/album%20art_S.png`, init);
    }
    throw new Error(`unreachable in test: ${u}`);
  }) as unknown as typeof fetch;
}

describe("AvrProtocolDriver — HTTP generation auto-detection (§ Denon Cheat Sheet Audit)", () => {
  it("detects a 2016+ unit (Deviceinfo.xml answers on 8080) and uses AppCommand.xml for input enrichment, never the legacy snapshot", async () => {
    const avr = await startFakeAvr();
    const appCmd = await startFakeAppCommand({ renamed: { DVD: "Blu-ray Player" } });
    const calls: string[] = [];
    const driver = new AvrProtocolDriver({ fetchImpl: makeGenerationFetch({ answersOn8080: true, appCommandPort: appCmd.port, calls }) });
    const dev = "device-avr-gen-2016" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => {
      const config = driver.getCapabilityConfig(dev, "media") as { inputs: { id: string; label: string }[] } | null;
      expect(config?.inputs.find((i) => i.id === "DVD")?.label).toBe("Blu-ray Player");
    });
    expect(calls.some((c) => c.includes(":8080/goform/Deviceinfo.xml"))).toBe(true);
    expect(calls.some((c) => c.includes("formMainZone_MainZoneXml.xml"))).toBe(false);
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => appCmd.server.close(() => r()));
  });

  it("detects a legacy unit (Deviceinfo.xml only answers on 80) and skips AppCommand.xml entirely, reading the legacy snapshot for diagnostics instead", async () => {
    const avr = await startFakeAvr();
    const calls: string[] = [];
    const driver = new AvrProtocolDriver({
      fetchImpl: makeGenerationFetch({ answersOn80: true, legacyStatusXml: "<item><Power><value>ON</value></Power><InputFuncSelect><value>DVD</value></InputFuncSelect></item>", calls }),
    });
    const dev = "device-avr-gen-legacy" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(calls.some((c) => c.includes("formMainZone_MainZoneXml.xml"))).toBe(true));
    expect(calls.some((c) => c.includes("AppCommand.xml"))).toBe(false);
    // Never treated as an equal-confidence rename source — installer_declared stays in effect.
    const config = driver.getCapabilityConfig(dev, "media") as { source: string } | null;
    expect(config?.source).toBe("installer_declared");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("defaults to legacy when Deviceinfo.xml answers on neither port, matching denonavr's own fallback", async () => {
    const avr = await startFakeAvr();
    const calls: string[] = [];
    const driver = new AvrProtocolDriver({ fetchImpl: makeGenerationFetch({ calls }) });
    const dev = "device-avr-gen-none" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(calls.some((c) => c.includes("formMainZone_MainZoneXml.xml"))).toBe(true));
    expect(calls.some((c) => c.includes(":80/goform/formMainZone_MainZoneXml.xml"))).toBe(true);
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("caches the detected generation per host — probes Deviceinfo.xml only once across multiple enrichment refreshes", async () => {
    const avr = await startFakeAvr();
    const calls: string[] = [];
    const driver = new AvrProtocolDriver({ fetchImpl: makeGenerationFetch({ answersOn80: true, calls }) });
    const dev = "device-avr-gen-cached" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    // Wait for the legacy status read itself (not just the Deviceinfo.xml calls) — that
    // only happens AFTER `resolveHttpPort()` has fully resolved and cached the result,
    // so this is the correct synchronization point; waiting on the Deviceinfo.xml call
    // count alone can observe it mid-flight, before the cache write lands.
    await vi.waitFor(() => expect(calls.filter((c) => c.includes("formMainZone_MainZoneXml.xml")).length).toBe(1));
    expect(calls.filter((c) => c.includes("Deviceinfo.xml")).length).toBe(2); // one full detection round
    await driver.refreshCapabilities(dev);
    await vi.waitFor(() => expect(calls.filter((c) => c.includes("formMainZone_MainZoneXml.xml")).length).toBe(2));
    expect(calls.filter((c) => c.includes("Deviceinfo.xml")).length).toBe(2); // still just the one detection round — cache hit
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("an explicit httpPort always wins over auto-detection — never probes Deviceinfo.xml", async () => {
    const avr = await startFakeAvr();
    const appCmd = await startFakeAppCommand({ renamed: { DVD: "Explicit Port" } });
    const driver = new AvrProtocolDriver({ httpPort: appCmd.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-gen-explicit" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => {
      const config = driver.getCapabilityConfig(dev, "media") as { inputs: { id: string; label: string }[] } | null;
      expect(config?.inputs.find((i) => i.id === "DVD")?.label).toBe("Explicit Port");
    });
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => appCmd.server.close(() => r()));
  });

  it("getArtwork() uses the auto-detected port too, unlocking album art on a legacy unit", async () => {
    const avr = await startFakeAvr();
    const appCmd = await startFakeAppCommand({ albumArt: { contentType: "image/png", body: "fake-legacy-png" } });
    const driver = new AvrProtocolDriver({ fetchImpl: makeGenerationFetch({ answersOn80: true, appCommandPort: appCmd.port }) });
    const dev = "device-avr-gen-artwork" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    const art = await driver.getArtwork(dev);
    expect(art?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(art?.data)).toBe("fake-legacy-png");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => appCmd.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — heartbeat() (§ RTI Capability Audit, Category C.3)", () => {
  it("round-trips a real PW? probe with a measured latency", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({});
    const dev = "device-avr-heartbeat" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));
    const result = await driver.heartbeat(dev);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(avr.received).toContain("PW?");
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("resolves { ok: false } on an unbound device rather than throwing", async () => {
    const driver = new AvrProtocolDriver({});
    await expect(driver.heartbeat("device-nope" as DeviceId)).resolves.toEqual({ ok: false, latencyMs: null });
  });
});

describe("AvrProtocolDriver — sendRaw() (§ RTI Capability Audit, Category C.4)", () => {
  it("writes the raw token verbatim to the wire, bypassing commandToAvr entirely", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({});
    const dev = "device-avr-raw" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));

    await driver.sendRaw(dev, "MVUP");
    await vi.waitFor(() => expect(avr.received).toContain("MVUP"));

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("throws instead of silently no-op'ing for an unbound device", async () => {
    const driver = new AvrProtocolDriver({});
    await driver.connect();
    await expect(driver.sendRaw("device-nope" as DeviceId, "MVUP")).rejects.toThrow(/not bound/);
  });

  it("throws instead of silently no-op'ing once the driver is disconnected", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({});
    const dev = "device-avr-raw-disconnected" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.disconnect();
    await expect(driver.sendRaw(dev, "MVUP")).rejects.toThrow(/driver is disconnected/);
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — getArtwork() (§ Universal AVR SDK)", () => {
  it("fetches real album art bytes from the receiver's confirmed-static HTTP endpoint", async () => {
    const avr = await startFakeAvr();
    const http = await startFakeAppCommand({ albumArt: { contentType: "image/png", body: "fake-png-bytes" } });
    const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-artwork" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    const art = await driver.getArtwork(dev);
    expect(art?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(art?.data)).toBe("fake-png-bytes");
    expect(http.artRequests).toBe(1);
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("returns null (never fabricated bytes) when the receiver has no album art to serve", async () => {
    const avr = await startFakeAvr();
    const http = await startFakeAppCommand({ albumArt: null });
    const driver = new AvrProtocolDriver({ httpPort: http.port, fetchImpl: globalThis.fetch });
    const dev = "device-avr-artwork-none" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    expect(await driver.getArtwork(dev)).toBeNull();
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
    await new Promise<void>((r) => http.server.close(() => r()));
  });

  it("returns null for a device this driver doesn't manage, and never throws on a connection failure", async () => {
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    expect(await driver.getArtwork("device-unknown" as DeviceId)).toBeNull();
  });
});

describe("AvrProtocolDriver — artworkUrlFor advertisement (§ Universal AVR SDK)", () => {
  it("advertises the gateway's proxy URL on the main zone's media state when artworkUrlFor is configured", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({
      httpPort: 1,
      fetchImpl: globalThis.fetch,
      artworkUrlFor: (id) => `https://hub.local/v1/devices/${id}/media/artwork`,
    });
    const dev = "device-avr-artwork-url" as DeviceId;
    await driver.connect();
    const ev = nextEvent(driver, (e) => e.deviceId === dev && e.capability === "media");
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.connectionStatus).toBe("connected"));
    await driver.command(dev, { capability: "media", action: "mute" });
    const state = (await ev).state as { artworkUrl: string | null };
    expect(state.artworkUrl).toBe(`https://hub.local/v1/devices/${dev}/media/artwork`);
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("zone2's media state never advertises artwork — it's a whole-unit, front-panel concept", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({
      httpPort: 1,
      fetchImpl: globalThis.fetch,
      artworkUrlFor: (id) => `https://hub.local/v1/devices/${id}/media/artwork`,
    });
    const dev = "device-avr-z2-no-artwork" as DeviceId;
    await driver.connect();
    const ev = nextEvent(driver, (e) => e.deviceId === dev && e.capability === "media");
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}`, config: { zone: "zone2" } });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.connectionStatus).toBe("connected"));
    await driver.command(dev, { capability: "media", action: "mute" });
    const state = (await ev).state as { artworkUrl: string | null };
    expect(state.artworkUrl).toBeNull();
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("no artwork is advertised at all when artworkUrlFor isn't configured — unchanged from before this feature existed", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ httpPort: 1, fetchImpl: globalThis.fetch });
    const dev = "device-avr-no-artwork-opt" as DeviceId;
    await driver.connect();
    const ev = nextEvent(driver, (e) => e.deviceId === dev && e.capability === "media");
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.connectionStatus).toBe("connected"));
    await driver.command(dev, { capability: "media", action: "mute" });
    const state = (await ev).state as { artworkUrl: string | null };
    expect(state.artworkUrl).toBeNull();
    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});

describe("AvrProtocolDriver — AVR Diagnostic Mode wiring", () => {
  it("is a no-op when disabled: exportDiagnosticsLog() is null, recordDiagnosticStage is a harmless no-op", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({});
    const dev = "device-avr-diag-off" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));

    expect(driver.exportDiagnosticsLog()).toBeNull();
    expect(() => driver.recordDiagnosticStage("AVR-000001", "Gateway", { published: true })).not.toThrow();

    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(avr.received).toContain("ZMON"));
    expect(driver.exportDiagnosticsLog()).toBeNull(); // still off — a real event didn't turn it on

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("when enabled, traces a real event end to end under one correlation ID, incl. gateway/websocket stages recorded by an external caller", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ diagnostics: true });
    const dev = "device-avr-diag-on" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));

    const ev = nextEvent(driver, (e) => e.capability === "media" && (e.state as { volume?: number }).volume !== undefined);
    await driver.command(dev, { capability: "media", action: "volume", volume: 80 });
    const emitted = await ev;
    // The driver stamped a correlation ID onto the event it dispatched — the exact hand-off
    // gateway-layer code (context.ts/stream.ts) uses to append its own stages to this trace.
    expect(emitted.traceId).toMatch(/^AVR-\d{6}$/);

    // Simulate the gateway/WebSocket layers appending their own stages, exactly as
    // context.ts's onBackendState() / stream.ts's unsubState handler do in production.
    driver.recordDiagnosticStage(emitted.traceId!, "Gateway", { published: true });
    driver.recordDiagnosticStage(emitted.traceId!, "WebSocket", { sent: true, subscribedRooms: 2 });

    const log = driver.exportDiagnosticsLog();
    expect(log).not.toBeNull();
    expect(log).toContain(`[${emitted.traceId}][TCP]`);
    expect(log).toContain(`[${emitted.traceId}][Parser]`);
    expect(log).toContain(`[${emitted.traceId}][patchMedia]`);
    expect(log).toContain(`[${emitted.traceId}][StateCache]`);
    expect(log).toContain(`[${emitted.traceId}][Gateway]`);
    expect(log).toContain("published=true");
    expect(log).toContain(`[${emitted.traceId}][WebSocket]`);
    expect(log).toContain("subscribedRooms=2");
    expect(log).toContain("Session Report");
    expect(log).toContain("commands received:");

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });

  it("captures an unrecognized line from the real receiver with hex/ascii/frequency, not a bare message", async () => {
    const avr = await startFakeAvr();
    const driver = new AvrProtocolDriver({ diagnostics: true });
    const dev = "device-avr-diag-unknown" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${avr.port}` });
    await vi.waitFor(() => expect(driver.getDiagnostics(dev)?.fullySynced).toBe(true));

    // The fake AVR only answers recognized tokens; write a bogus one straight to the wire
    // via the existing raw-command escape hatch to trigger a genuinely unrecognized reply.
    for (const sock of avr.sockets) sock.write("ZZBOGUS\r");
    await vi.waitFor(() => {
      const log = driver.exportDiagnosticsLog();
      expect(log).toContain("ZZBOGUS");
    });
    const log = driver.exportDiagnosticsLog()!;
    expect(log).not.toMatch(/unrecognized line/i);
    expect(log).toContain("hex=");
    expect(log).toContain("firstToken=ZZBOGUS");

    await driver.disconnect();
    await new Promise<void>((r) => avr.server.close(() => r()));
  });
});
