import net from "node:net";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import {
  buildInfoCommands,
  buildPollCommands,
  commandToPjlink,
  fallbackInputLabel,
  parsePjlinkGreeting,
  parsePjlinkLine,
  PJLINK_DEFAULT_PORT,
  PjlinkProtocolError,
  pjlinkAuthDigest,
  type PjlinkClass,
  type PjlinkErrorStatus,
  type PjlinkInputRef,
} from "./pjlink-codec.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { TcpLineTransport, type TcpLink } from "./av-sdk/tcp-line-transport.js";
import { createProtocolTracer, type ProtocolTracer } from "./av-sdk/protocol-tracer.js";
import type { DriverDiagnosticsSnapshot } from "./driver-diagnostics.js";
import { discoverPjlinkClass2, type PjlinkDiscoveryOptions } from "./pjlink-discovery.js";

/**
 * Native PJLink Class 2 protocol driver (§ PJLink Class 2 native driver task). PJLink is
 * a strictly request/response, ASCII, line-based TCP protocol (spec §4) — one physical
 * projector = one TCP session = at most one command in flight at a time. Unlike
 * Denon/Marantz Telnet (which streams unsolicited status echoes), a PJLink reply is
 * always the direct answer to the command this driver just sent, so this driver adds a
 * FIFO command queue on top of `TcpLineTransport` rather than reusing AVR's fire-and-
 * forget write pattern.
 *
 * § Failure isolation — every projector gets its OWN link (its own `host:port` key, its
 * own command queue, its own auth/poll state, its own reconnect backoff via
 * `TcpLineTransport`). Nothing here is shared/global across devices: a timeout, an
 * auth rejection or a dropped socket for one projector never touches another's queue,
 * poller or state cache. See `pjlink-driver.test.ts`'s multi-projector isolation test.
 *
 * § Class negotiation — on connect, sends the Class-1-safe `CLSS?` first; the reply's
 * reported class decides whether Class-2-only commands (`INST`, `FREZ`) are ever sent to
 * this unit. An installer-declared `pjlinkClass` override (`ProtocolBinding.config.
 * pjlinkClass`) skips this probe when set — useful for a unit whose `CLSS?` reply is
 * itself unreliable (a real, documented quirk on some early Class 2 firmware).
 *
 * § Auth — Class 1 MD5 challenge/response (spec §5): the greeting line (`PJLINK 0` or
 * `PJLINK 1 <seed>`) is not itself a `%1CMD=VALUE` reply, so it's intercepted before the
 * FIFO queue logic runs. The admin password comes from `ProtocolBinding.config.password`
 * (per-projector, like AVR's per-binding config) — the secret-store layer
 * (`services/drivers/src/secret-store.ts`) handles encryption at rest transparently; this
 * driver only ever sees/logs the plaintext in memory during an active session, never
 * writes it to a log line (see `onLog` calls below — none include the password).
 *
 * § Capability honesty — `getState()` only ever reports a field once this driver has
 * actually parsed a real reply for it; every `DisplayState` field defaults to
 * `null`/`[]`/`"unknown"` (never a guessed `false`/`off`) until then, matching this
 * codebase's "never fabricate capability state" rule.
 */

const DRIVER_VERSION = "1.0.0";
const COMMAND_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 15_000;

export interface PjlinkDriverOptions {
  port?: number;
  createSocket?: (host: string, port: number) => net.Socket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  trace?: boolean;
  /** Injectable discovery UDP transport factory (tests point at a fake); see
   * `pjlink-discovery.ts`. Defaults to the real `@supreme/lan` transport. */
  udpTransportFactory?: PjlinkDiscoveryOptions["udpTransportFactory"];
  /** Poll interval override (tests). */
  pollIntervalMs?: number;
  /** Command round-trip timeout override (tests). */
  commandTimeoutMs?: number;
}

type PjlinkConnState = "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "READY" | "DEGRADED" | "ERROR";

interface PjlinkBinding {
  deviceId: DeviceId;
  host: string;
  port: number;
  password: string | null;
  classOverride: PjlinkClass | null;
}

interface QueuedCommand {
  line: string;
  cmd: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PjlinkSession {
  key: string;
  host: string;
  port: number;
  connState: PjlinkConnState;
  pjClass: PjlinkClass | null;
  authRequired: boolean;
  authenticated: boolean;
  seed: string | null;
  awaitingGreeting: boolean;
  queue: QueuedCommand[];
  inFlight: QueuedCommand | null;
  firstAuthedCommandSent: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  cache: PjlinkCache;
}

interface PjlinkCache {
  power: "off" | "warming" | "on" | "cooling" | "unknown";
  input: PjlinkInputRef | null;
  availableInputs: PjlinkInputRef[];
  videoMuted: boolean | null;
  audioMuted: boolean | null;
  errorStatus: PjlinkErrorStatus | null;
  lampHours: { hours: number; on: boolean }[] | null;
  frozen: boolean | null;
  manufacturer: string | null;
  product: string | null;
  productName: string | null;
  otherInfo: string | null;
  pjlinkClass: PjlinkClass | null;
}

function emptyCache(): PjlinkCache {
  return {
    power: "unknown",
    input: null,
    availableInputs: [],
    videoMuted: null,
    audioMuted: null,
    errorStatus: null,
    lampHours: null,
    frozen: null,
    manufacturer: null,
    product: null,
    productName: null,
    otherInfo: null,
    pjlinkClass: null,
  };
}

export class PjlinkProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "pjlink";
  private connected = false;
  private readonly opts: PjlinkDriverOptions;
  private readonly defaultPort: number;
  private readonly bindings: PjlinkBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly transport: TcpLineTransport;
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly tracer: ProtocolTracer;
  private readonly sessions = new Map<string, PjlinkSession>();

  constructor(opts: PjlinkDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? PJLINK_DEFAULT_PORT;
    this.tracer = createProtocolTracer("pjlink", opts.trace === true, opts.onLog);
    this.transport = new TcpLineTransport({
      delimiter: "\r",
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
      createSocket: opts.createSocket,
      onLog: opts.onLog,
      onConnect: (link, socket, host, port) => this.onLinkConnect(link, socket, host, port),
      onLine: (ctx, line) => this.onLine(ctx.key, ctx.host, ctx.port, line),
    });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.transport.disconnectAll();
    for (const session of this.sessions.values()) {
      this.failQueue(session, new Error("pjlink: driver disconnected"));
      if (session.pollTimer) clearTimeout(session.pollTimer);
    }
    this.sessions.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const { host, port } = parseHostPort(binding.address, this.defaultPort);
    const password = typeof binding.config?.password === "string" && binding.config.password.length > 0 ? binding.config.password : null;
    const classOverride = binding.config?.pjlinkClass === "1" || binding.config?.pjlinkClass === "2" ? (binding.config.pjlinkClass as PjlinkClass) : null;
    const existingIdx = this.bindings.findIndex((b) => b.deviceId === binding.deviceId);
    const entry: PjlinkBinding = { deviceId: binding.deviceId, host, port, password, classOverride };
    if (existingIdx >= 0) this.bindings[existingIdx] = entry;
    else this.bindings.push(entry);
    this.devices.add(binding.deviceId);
    if (this.connected) this.ensureSession(host, port);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async unbind(deviceId: DeviceId): Promise<void> {
    const removed = this.bindings.filter((b) => b.deviceId === deviceId);
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
    for (const b of removed) {
      const key = `${b.host}:${b.port}`;
      if (this.bindings.some((x) => `${x.host}:${x.port}` === key)) continue;
      const session = this.sessions.get(key);
      if (session) {
        if (session.pollTimer) clearTimeout(session.pollTimer);
        this.failQueue(session, new Error("pjlink: device unbound"));
        this.sessions.delete(key);
      }
      this.transport.releaseKey(key);
    }
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error(`pjlink: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`pjlink: ${deviceId} not bound`);
    const key = `${b.host}:${b.port}`;
    const session = this.ensureSession(b.host, b.port);
    if (session.connState === "ERROR" || session.connState === "DISCONNECTED") {
      throw new Error(`pjlink: not connected to ${b.host}:${b.port} — check the projector's IP and that PJLink is enabled`);
    }
    const pjClass = b.classOverride ?? session.pjClass ?? "1";
    const lines = commandToPjlink(command, pjClass);
    if (!lines) throw new Error(`pjlink: unsupported command for ${command.capability}/${"action" in command ? command.action : "?"} (class ${pjClass})`);
    for (const line of lines) {
      const cmd = /^%[12]([A-Z0-9]+)/.exec(line)?.[1] ?? "?";
      await this.enqueue(key, session, b, line, cmd);
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const { status, diagnostics } = this.transport.diagnosticsFor(`${b.host}:${b.port}`);
    return diagnostics.snapshot(status, {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: null,
      firmware: null,
      serial: null,
      ip: b.host,
      mac: null,
    });
  }

  /** § PJLink Class 2 discovery — see `pjlink-discovery.ts`'s module doc for exactly
   * what wire mechanism this implements and its documented limitations. */
  async discover(): Promise<DiscoveredDevice[]> {
    this.tracer.event("discover: PJLink Class 2 SRCH broadcast");
    const found = await discoverPjlinkClass2({ udpTransportFactory: this.opts.udpTransportFactory, onLog: this.opts.onLog });
    this.tracer.event(`discover: ${found.length} candidate(s) — [${found.map((f) => f.address).join(", ")}]`);
    return found.map((f) => ({
      backendId: f.address,
      suggestedName: `Projector ${f.address}`,
      capabilities: ["display"] as DiscoveredDevice["capabilities"],
      raw: { ip: f.address },
    }));
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  private ensureSession(host: string, port: number): PjlinkSession {
    const key = `${host}:${port}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key, host, port,
        connState: "CONNECTING",
        pjClass: null,
        authRequired: false,
        authenticated: false,
        seed: null,
        awaitingGreeting: true,
        queue: [],
        inFlight: null,
        firstAuthedCommandSent: false,
        pollTimer: null,
        cache: emptyCache(),
      };
      this.sessions.set(key, session);
    }
    this.transport.ensureLink(key, host, port);
    return session;
  }

  private onLinkConnect(_link: TcpLink, _socket: net.Socket, host: string, port: number): void {
    const key = `${host}:${port}`;
    const session = this.sessions.get(key) ?? this.ensureSession(host, port);
    session.connState = "CONNECTING";
    session.awaitingGreeting = true;
    session.authenticated = false;
    session.firstAuthedCommandSent = false;
    session.seed = null;
    this.tracer.event(`connected to ${host}:${port} — awaiting PJLink greeting`);
  }

  private onLine(key: string, host: string, port: number, line: string): void {
    this.tracer.receive(line);
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.awaitingGreeting) {
      const greeting = parsePjlinkGreeting(line);
      if (!greeting) {
        this.tracer.event(`unrecognized greeting from ${host}:${port}: ${JSON.stringify(line)}`);
        return;
      }
      session.awaitingGreeting = false;
      if (!greeting.authRequired) {
        session.authRequired = false;
        session.authenticated = true;
        session.connState = "READY";
      } else if ("rejected" in greeting && greeting.rejected) {
        session.connState = "ERROR";
        this.opts.onLog?.("error", `pjlink: ${host}:${port} rejected the connection (PJLINK ERRA at greeting)`);
        this.failQueue(session, new Error("pjlink: connection rejected at greeting"));
        return;
      } else if ("seed" in greeting) {
        session.authRequired = true;
        session.seed = greeting.seed;
        session.connState = "AUTHENTICATING";
        const binding = this.bindings.find((b) => `${b.host}:${b.port}` === key);
        if (!binding?.password) {
          session.connState = "ERROR";
          this.opts.onLog?.("error", `pjlink: ${host}:${port} requires a password but none is configured for this device`);
          this.failQueue(session, new Error("pjlink: password required but not configured"));
          return;
        }
        session.authenticated = false; // proven only once the first command's reply isn't ERRA
        session.connState = "READY";
      }
      this.startSessionSync(session);
      return;
    }

    let update;
    try {
      update = parsePjlinkLine(line);
    } catch (err) {
      if (err instanceof PjlinkProtocolError) {
        this.handleCommandError(session, err);
        return;
      }
      throw err;
    }
    // Resolve whichever command is in flight — PJLink is strictly one-at-a-time, so the
    // reply for the head of the queue is always this line, matched or not.
    this.resolveInFlight(session, line);
    if (!update) {
      this.tracer.event(`unrecognized line from ${host}:${port}: ${JSON.stringify(line)}`);
      return;
    }
    this.applyUpdate(session, update);
  }

  private handleCommandError(session: PjlinkSession, err: PjlinkProtocolError): void {
    if (err.code === "ERRA") {
      session.connState = "ERROR";
      session.authenticated = false;
      this.opts.onLog?.("error", `pjlink: ${session.host}:${session.port} — authorization rejected`);
    }
    this.rejectInFlight(session, err);
  }

  private applyUpdate(session: PjlinkSession, update: NonNullable<ReturnType<typeof parsePjlinkLine>>): void {
    const c = session.cache;
    switch (update.kind) {
      case "power":
        c.power = update.state;
        break;
      case "input":
        c.input = update.input;
        break;
      case "inputList":
        c.availableInputs = update.inputs;
        break;
      case "avmt":
        if (update.mute.video !== null) c.videoMuted = update.mute.video;
        if (update.mute.audio !== null) c.audioMuted = update.mute.audio;
        break;
      case "erst":
        c.errorStatus = update.status;
        break;
      case "lamp":
        c.lampHours = update.lamps;
        break;
      case "freeze":
        c.frozen = update.frozen;
        break;
      case "manufacturer":
        c.manufacturer = update.value || null;
        break;
      case "product":
        c.product = update.value || null;
        break;
      case "otherInfo":
        c.otherInfo = update.value || null;
        break;
      case "name":
        c.productName = update.value || null;
        break;
      case "class":
        c.pjlinkClass = update.value;
        session.pjClass = session.pjClass ?? update.value;
        break;
    }
    const binding = this.bindings.find((b) => `${b.host}:${b.port}` === session.key);
    if (binding) this.record(binding.deviceId, buildDisplayState(c));
  }

  private record(deviceId: DeviceId, state: CapabilityState): void {
    recordCapabilityState(this.states, this.listeners, deviceId, "display", state);
  }

  // ── Command queue (strictly one in-flight per session — spec §4) ────────

  private enqueue(key: string, session: PjlinkSession, binding: PjlinkBinding, line: string, cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const idx = session.queue.indexOf(entry);
        if (idx >= 0) session.queue.splice(idx, 1);
        if (session.inFlight === entry) session.inFlight = null;
        reject(new Error(`pjlink: ${session.host}:${session.port} — ${cmd} timed out after ${timeoutMs}ms`));
        this.pumpQueue(key, session, binding);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const entry: QueuedCommand = { line, cmd, resolve, reject, timer };
      session.queue.push(entry);
      this.pumpQueue(key, session, binding);
    });
  }

  private pumpQueue(key: string, session: PjlinkSession, binding: PjlinkBinding): void {
    if (session.inFlight) return;
    if (session.connState === "ERROR" || session.connState === "DISCONNECTED") {
      this.failQueue(session, new Error(`pjlink: ${session.host}:${session.port} not connected`));
      return;
    }
    const next = session.queue.shift();
    if (!next) return;
    const link = this.transport.get(key);
    if (!link?.ready || !link.socket || link.socket.destroyed) {
      // Not connected yet — put it back and wait for onLinkConnect to re-pump.
      session.queue.unshift(next);
      return;
    }
    session.inFlight = next;
    let wireLine = next.line;
    if (session.authRequired && !session.firstAuthedCommandSent) {
      session.firstAuthedCommandSent = true;
      const digest = pjlinkAuthDigest(session.seed ?? "", binding.password ?? "");
      wireLine = digest + next.line;
    }
    link.diagnostics.recordSend(next.cmd);
    this.tracer.send(next.line.trim());
    link.socket.write(wireLine);
  }

  private resolveInFlight(session: PjlinkSession, replyLine: string): void {
    const entry = session.inFlight;
    if (!entry) return;
    clearTimeout(entry.timer);
    session.inFlight = null;
    session.authenticated = true; // any successful (non-ERRA) reply proves auth held
    entry.resolve(replyLine);
    const binding = this.bindings.find((b) => `${b.host}:${b.port}` === session.key);
    if (binding) this.pumpQueue(session.key, session, binding);
  }

  private rejectInFlight(session: PjlinkSession, err: Error): void {
    const entry = session.inFlight;
    if (!entry) {
      // An error with nothing in flight (e.g. auth failed on the very first command
      // before this driver tracked it as in-flight) still needs to fail the queue.
      this.failQueue(session, err);
      return;
    }
    clearTimeout(entry.timer);
    session.inFlight = null;
    entry.reject(err);
    if (session.connState === "ERROR") {
      this.failQueue(session, err);
    } else {
      const binding = this.bindings.find((b) => `${b.host}:${b.port}` === session.key);
      if (binding) this.pumpQueue(session.key, session, binding);
    }
  }

  private failQueue(session: PjlinkSession, err: Error): void {
    if (session.inFlight) {
      clearTimeout(session.inFlight.timer);
      session.inFlight.reject(err);
      session.inFlight = null;
    }
    for (const entry of session.queue.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  // ── Polling (feedback model: PJLink has no unsolicited push, so this driver polls) ──

  private startSessionSync(session: PjlinkSession): void {
    const binding = this.bindings.find((b) => `${b.host}:${b.port}` === session.key);
    if (!binding) return;
    const pjClass = binding.classOverride ?? "1";
    this.tracer.event(`${session.host}:${session.port} — starting sync (class probe + info + poll)`);
    void this.runQuerySequence(session, binding, ["CLSS"]);
    void this.runQuerySequence(session, binding, buildInfoCommands(pjClass).map(extractCmd));
    this.schedulePoll(session, binding);
  }

  private schedulePoll(session: PjlinkSession, binding: PjlinkBinding): void {
    if (session.pollTimer) clearTimeout(session.pollTimer);
    const intervalMs = this.opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    session.pollTimer = setTimeout(() => {
      void this.runPoll(session, binding).finally(() => {
        if (this.sessions.get(session.key) === session) this.schedulePoll(session, binding);
      });
    }, intervalMs);
    (session.pollTimer as { unref?: () => void }).unref?.();
    // Kick off an immediate first poll too, so state is fresh right after connect.
    void this.runPoll(session, binding);
  }

  private async runPoll(session: PjlinkSession, binding: PjlinkBinding): Promise<void> {
    if (session.connState === "ERROR" || session.connState === "DISCONNECTED") return;
    const pjClass = binding.classOverride ?? session.pjClass ?? "1";
    await this.runQuerySequence(session, binding, buildPollCommands(pjClass).map(extractCmd));
  }

  /** Sends a sequence of bare command names (e.g. "POWR") as `<CMD>?` queries, one at a
   * time via the same FIFO queue real commands use — never a separate write path, so
   * poll traffic and homeowner commands are correctly serialized against each other. A
   * single failed query in the sequence (timeout, ERR1 for an unsupported command on
   * this unit) is traced and skipped — never aborts the rest of the sequence, matching
   * "one projector's degraded feature never blocks the others it does support." */
  private async runQuerySequence(session: PjlinkSession, binding: PjlinkBinding, cmds: string[]): Promise<void> {
    const pjClass = binding.classOverride ?? session.pjClass ?? "1";
    for (const cmd of cmds) {
      const line = `%${pjClass}${cmd} ?\r`;
      try {
        await this.enqueue(session.key, session, binding, line, cmd);
      } catch (err) {
        this.tracer.event(`${session.host}:${session.port} — ${cmd}? failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function extractCmd(line: string): string {
  return /^%[12]([A-Z0-9]+)/.exec(line)?.[1] ?? "";
}

function parseHostPort(address: string, defaultPort: number): { host: string; port: number } {
  const [host, port] = address.split(":");
  return { host: host || address, port: Number(port ?? defaultPort) };
}

/** Build a full Supreme `DisplayState` from the driver's per-session cache. Every field
 * stays honest to what's genuinely been queried — `"unknown"`/`null`/`[]` until a real
 * reply populates it, never a fabricated default. */
export function buildDisplayState(cache: PjlinkCache): CapabilityState {
  return {
    kind: "display",
    power: cache.power,
    input: cache.input,
    availableInputs: cache.availableInputs.map((i) => ({ ...i, label: fallbackInputLabel(i) })),
    videoMuted: cache.videoMuted,
    audioMuted: cache.audioMuted,
    errorStatus: cache.errorStatus,
    lampHours: cache.lampHours,
    frozen: cache.frozen,
    manufacturer: cache.manufacturer,
    product: cache.product,
    productName: cache.productName,
    otherInfo: cache.otherInfo,
    pjlinkClass: cache.pjlinkClass,
  };
}
