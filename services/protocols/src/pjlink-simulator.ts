import net from "node:net";
import { pjlinkAuthDigest } from "./pjlink-codec.js";

/**
 * In-process PJLink projector simulator, for `pjlink-driver.test.ts`. Mirrors the
 * pattern `av-sdk/tcp-line-transport.test.ts` / `avr-driver.test.ts` already use for
 * their own fake TCP servers — a real `node:net` server, not a mock of the transport.
 *
 * Each simulated projector is its OWN `net.Server` on its own loopback port (matching
 * real PJLink deployments: one projector = one IP), so a test can spin up many
 * independent virtual projectors and verify the driver's per-device isolation for real,
 * not just in a shared in-memory fake.
 */
export interface PjlinkSimulatorOptions {
  /** `"1"` sends the unauthenticated greeting only if `password` is unset; `"2"`
   * additionally answers Class-2-only commands (INST/FREZ). Default `"2"`. */
  pjClass?: "1" | "2";
  /** When set, the greeting requires MD5 auth and the first command of each connection
   * must carry the correct digest prefix. */
  password?: string;
  /** Response delay per command, ms. Default 0. */
  responseDelayMs?: number;
  /** When true, the server refuses new connections (simulates the projector being
   * powered off / unreachable) until `goOnline()` is called. */
  startOffline?: boolean;
  manufacturer?: string;
  product?: string;
  productName?: string;
}

export interface SimulatedLamp {
  hours: number;
  on: boolean;
}

export class PjlinkSimulator {
  private server: net.Server | null = null;
  private port = 0;
  private online: boolean;
  readonly opts: Required<Pick<PjlinkSimulatorOptions, "pjClass" | "responseDelayMs">> & PjlinkSimulatorOptions;

  // Mutable device state, independent per simulator instance (i.e. per projector).
  power: "off" | "warming" | "on" | "cooling" = "off";
  input = { source: 1 as 1 | 2 | 3 | 4 | 5, number: 1 };
  availableInputs: { source: 1 | 2 | 3 | 4 | 5; number: number }[] = [
    { source: 1, number: 1 },
    { source: 2, number: 1 },
    { source: 3, number: 1 },
  ];
  videoMuted = false;
  audioMuted = false;
  frozen = false;
  errorStatus = { fan: 0, lamp: 0, temperature: 0, coverOpen: 0, filter: 0, other: 0 } as const;
  lamps: SimulatedLamp[] = [{ hours: 120, on: true }];
  /** When true, every reply from this point on is `ERR4` (simulates a hard failure). */
  failHard = false;

  constructor(opts: PjlinkSimulatorOptions = {}) {
    this.opts = { pjClass: opts.pjClass ?? "2", responseDelayMs: opts.responseDelayMs ?? 0, ...opts };
    this.online = opts.startOffline !== true;
  }

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  goOffline(): void {
    this.online = false;
  }
  goOnline(): void {
    this.online = true;
  }

  get address(): { host: string; port: number } {
    return { host: "127.0.0.1", port: this.port };
  }

  private handleConnection(socket: net.Socket): void {
    if (!this.online) {
      socket.destroy();
      return;
    }
    let authenticated = this.opts.password === undefined;
    let seed = "";
    let buffer = "";
    let firstCommand = true;

    if (this.opts.password !== undefined) {
      seed = Math.random().toString(16).slice(2, 10).padEnd(8, "0").slice(0, 8);
      socket.write(`PJLINK 1 ${seed}\r\n`);
    } else {
      socket.write("PJLINK 0\r\n");
    }

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        this.handleLine(socket, line, {
          checkAuth: () => {
            if (authenticated) return true;
            if (!firstCommand) return true; // auth only checked on the first command
            const expected = pjlinkAuthDigest(seed, this.opts.password ?? "");
            const ok = line.startsWith(expected);
            if (ok) authenticated = true;
            return ok;
          },
          stripAuthPrefix: (raw) => (firstCommand && this.opts.password !== undefined ? raw.slice(32) : raw),
        });
        firstCommand = false;
      }
    });
  }

  private handleLine(
    socket: net.Socket,
    rawLine: string,
    ctx: { checkAuth: () => boolean; stripAuthPrefix: (raw: string) => string },
  ): void {
    const authOk = ctx.checkAuth();
    const line = ctx.stripAuthPrefix(rawLine);
    if (!authOk) {
      this.reply(socket, this.commandFrom(line), "ERRA");
      return;
    }
    const m = /^%([12])([A-Z0-9]+) (.+)$/.exec(line.trim());
    if (!m) return;
    const [, pjClass, cmd, param] = m;
    if (!cmd || !param) return;
    if (pjClass === "2" && this.opts.pjClass === "1" && (cmd === "INST" || cmd === "FREZ")) {
      this.reply(socket, cmd, "ERR1");
      return;
    }
    this.respond(socket, cmd, param);
  }

  private commandFrom(line: string): string {
    const m = /^%[12]([A-Z0-9]+)/.exec(line.trim());
    return m?.[1] ?? "";
  }

  private respond(socket: net.Socket, cmd: string, param: string): void {
    const send = () => {
      if (socket.destroyed) return;
      if (this.failHard) {
        this.reply(socket, cmd, "ERR4");
        return;
      }
      this.dispatch(socket, cmd, param);
    };
    if (this.opts.responseDelayMs > 0) setTimeout(send, this.opts.responseDelayMs);
    else send();
  }

  private reply(socket: net.Socket, cmd: string, value: string): void {
    if (!socket.destroyed) socket.write(`%${this.opts.pjClass}${cmd}=${value}\r`);
  }

  private dispatch(socket: net.Socket, cmd: string, param: string): void {
    switch (cmd) {
      case "POWR":
        if (param === "?") {
          const map = { off: "0", on: "1", cooling: "2", warming: "3" } as const;
          this.reply(socket, cmd, map[this.power]);
        } else if (param === "1") {
          if (this.power === "on" || this.power === "warming") {
            this.reply(socket, cmd, "OK");
            return;
          }
          this.power = "warming";
          this.reply(socket, cmd, "OK");
          setTimeout(() => {
            this.power = "on";
          }, this.opts.responseDelayMs + 5);
        } else if (param === "0") {
          if (this.power === "off" || this.power === "cooling") {
            this.reply(socket, cmd, "OK");
            return;
          }
          this.power = "cooling";
          this.reply(socket, cmd, "OK");
          setTimeout(() => {
            this.power = "off";
          }, this.opts.responseDelayMs + 5);
        } else {
          this.reply(socket, cmd, "ERR2");
        }
        return;
      case "INPT":
        if (param === "?") {
          this.reply(socket, cmd, `${this.input.source}${this.input.number}`);
          return;
        }
        {
          const m = /^([1-5])([1-9])$/.exec(param);
          if (!m) {
            this.reply(socket, cmd, "ERR2");
            return;
          }
          const candidate = { source: Number(m[1]) as 1 | 2 | 3 | 4 | 5, number: Number(m[2]) };
          const known = this.availableInputs.some((i) => i.source === candidate.source && i.number === candidate.number);
          if (!known) {
            this.reply(socket, cmd, "ERR2");
            return;
          }
          if (this.power !== "on") {
            this.reply(socket, cmd, "ERR3");
            return;
          }
          this.input = candidate;
          this.reply(socket, cmd, "OK");
        }
        return;
      case "INST":
        this.reply(socket, cmd, this.availableInputs.map((i) => `${i.source}${i.number}`).join(" "));
        return;
      case "AVMT":
        if (param === "?") {
          if (this.videoMuted && this.audioMuted) this.reply(socket, cmd, "31");
          else if (this.videoMuted) this.reply(socket, cmd, "11");
          else if (this.audioMuted) this.reply(socket, cmd, "21");
          else this.reply(socket, cmd, "30");
          return;
        }
        if (param === "10") this.videoMuted = false;
        else if (param === "11") this.videoMuted = true;
        else if (param === "20") this.audioMuted = false;
        else if (param === "21") this.audioMuted = true;
        else if (param === "30") {
          this.videoMuted = false;
          this.audioMuted = false;
        } else if (param === "31") {
          this.videoMuted = true;
          this.audioMuted = true;
        } else {
          this.reply(socket, cmd, "ERR2");
          return;
        }
        this.reply(socket, cmd, "OK");
        return;
      case "ERST":
        this.reply(
          socket,
          cmd,
          `${this.errorStatus.fan}${this.errorStatus.lamp}${this.errorStatus.temperature}${this.errorStatus.coverOpen}${this.errorStatus.filter}${this.errorStatus.other}`,
        );
        return;
      case "LAMP":
        this.reply(socket, cmd, this.lamps.map((l) => `${l.hours} ${l.on ? "1" : "0"}`).join(" "));
        return;
      case "FREZ":
        if (param === "?") {
          this.reply(socket, cmd, this.frozen ? "1" : "0");
        } else if (param === "1" || param === "0") {
          this.frozen = param === "1";
          this.reply(socket, cmd, "OK");
        } else {
          this.reply(socket, cmd, "ERR2");
        }
        return;
      case "INF1":
        this.reply(socket, cmd, this.opts.manufacturer ?? "Supreme Simulated Optics");
        return;
      case "INF2":
        this.reply(socket, cmd, this.opts.product ?? "SIM-2000");
        return;
      case "INFO":
        this.reply(socket, cmd, this.opts.productName ?? "");
        return;
      case "NAME":
        this.reply(socket, cmd, this.opts.productName ?? "Simulated Projector");
        return;
      case "CLSS":
        this.reply(socket, cmd, this.opts.pjClass);
        return;
      default:
        this.reply(socket, cmd, "ERR1");
        return;
    }
  }
}

/** Convenience: spin up `count` independent simulated projectors on their own ports. */
export async function startPjlinkFarm(count: number, factory?: (i: number) => PjlinkSimulatorOptions): Promise<PjlinkSimulator[]> {
  const sims = Array.from({ length: count }, (_, i) => new PjlinkSimulator(factory ? factory(i) : {}));
  await Promise.all(sims.map((s) => s.start()));
  return sims;
}

export async function stopPjlinkFarm(sims: PjlinkSimulator[]): Promise<void> {
  await Promise.all(sims.map((s) => s.stop()));
}
