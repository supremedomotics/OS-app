import net from "node:net";
import { ASCII_COMMAND_TERMINATOR, ASCII_PROMPT } from "./coolmaster-constants.js";
import { CoolMasterConnectionError, CoolMasterTimeoutError } from "./coolmaster-errors.js";
import type { CoolMasterScopedLogger } from "./coolmaster-logger.js";

/**
 * Raw ASCII_IF TCP transport (docs/coolmaster/CoolMaster_Core_Reference_v1.0.txt §6). One
 * command is sent per line (CR-terminated); the gateway replies with one or more lines
 * followed by its interactive prompt (">"), which marks "response complete, ready for the
 * next command". Since a single TCP connection carries all traffic and the wire protocol
 * has no per-command correlation id, commands MUST be serialized one-at-a-time — this
 * transport enforces that with an internal FIFO so callers can safely fire concurrent
 * `execute()` calls without corrupting response framing.
 */

interface PendingRequest {
  command: string;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CoolMasterAsciiTransportOptions {
  host: string;
  port: number;
  timeoutMs: number;
  createSocket?: (host: string, port: number) => net.Socket;
  logger?: CoolMasterScopedLogger;
}

export class CoolMasterAsciiTransport {
  private socket: net.Socket | null = null;
  private buffer = "";
  private readonly queue: PendingRequest[] = [];
  private inFlight: PendingRequest | null = null;
  private greeted = false;
  /** Set only while connect() is waiting for the gateway's first prompt. */
  private pendingGreeting: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: CoolMasterAsciiTransportOptions) {}

  isConnected(): boolean {
    return this.socket !== null;
  }

  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = this.opts.createSocket
        ? this.opts.createSocket(this.opts.host, this.opts.port)
        : net.connect(this.opts.port, this.opts.host);
      const onConnectError = (err: Error) => {
        socket.destroy();
        reject(new CoolMasterConnectionError(`coolmaster: ASCII_IF connect failed: ${err.message}`, "ascii", err));
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.removeListener("error", onConnectError);
        socket.setEncoding("utf8");
        this.socket = socket;
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("close", () => this.onClose());
        socket.on("error", (err) => this.opts.logger?.debug("socket error (post-connect)", { message: err.message }));
        // The gateway greets with a banner then its prompt; wait for the first prompt
        // (handled in onData below) before considering the connection ready.
        this.pendingGreeting = {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.pendingGreeting = null;
            reject(new CoolMasterTimeoutError("coolmaster: ASCII_IF greeting timed out", "ascii"));
          }, this.opts.timeoutMs),
        };
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.greeted = false;
    this.buffer = "";
    this.failAll(new CoolMasterConnectionError("coolmaster: disconnected", "ascii"));
  }

  /** Send one ASCII_IF command and resolve with its response lines (prompt stripped). */
  execute(command: string): Promise<string[]> {
    if (!this.socket) return Promise.reject(new CoolMasterConnectionError("coolmaster: ASCII_IF not connected", "ascii"));
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        command,
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => this.onTimeout(pending), this.opts.timeoutMs),
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0 || !this.socket) return;
    const next = this.queue.shift()!;
    this.inFlight = next;
    this.opts.logger?.debug("send", { command: next.command });
    this.socket.write(`${next.command}${ASCII_COMMAND_TERMINATOR}`);
  }

  private onTimeout(pending: PendingRequest): void {
    if (this.inFlight === pending) this.inFlight = null;
    const idx = this.queue.indexOf(pending);
    if (idx >= 0) this.queue.splice(idx, 1);
    pending.reject(new CoolMasterTimeoutError(`coolmaster: ASCII_IF command "${pending.command}" timed out`, "ascii"));
    this.pump();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.pendingGreeting) {
      if (!this.buffer.includes(ASCII_PROMPT)) return;
      const greeting = this.pendingGreeting;
      this.pendingGreeting = null;
      this.greeted = true;
      // Discard everything up to and including the greeting's prompt — banner text
      // (firmware/model strings some units print on connect) is not a command response.
      this.buffer = this.buffer.slice(this.buffer.indexOf(ASCII_PROMPT) + 1);
      clearTimeout(greeting.timer);
      greeting.resolve();
      return;
    }
    // A response is complete when the trailing prompt appears. The prompt has no
    // guaranteed line terminator of its own, so scan for it directly rather than
    // relying on line-splitting alone.
    if (!this.buffer.includes(ASCII_PROMPT)) return;
    const promptIdx = this.buffer.indexOf(ASCII_PROMPT);
    const block = this.buffer.slice(0, promptIdx);
    this.buffer = this.buffer.slice(promptIdx + 1);
    const lines = block
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!this.inFlight) {
      // Unsolicited output (e.g. a stray banner) — log and drop.
      if (lines.length > 0) this.opts.logger?.debug("unsolicited", { lines });
      return;
    }
    clearTimeout(this.inFlight.timer);
    const done = this.inFlight;
    this.inFlight = null;
    this.opts.logger?.debug("recv", { command: done.command, lines });
    done.resolve(lines);
    this.pump();
  }

  private onClose(): void {
    this.socket = null;
    this.greeted = false;
    this.failAll(new CoolMasterConnectionError("coolmaster: ASCII_IF connection closed", "ascii"));
  }

  private failAll(err: Error): void {
    if (this.pendingGreeting) {
      clearTimeout(this.pendingGreeting.timer);
      this.pendingGreeting.reject(err);
      this.pendingGreeting = null;
    }
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    while (this.queue.length > 0) {
      const p = this.queue.shift()!;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
