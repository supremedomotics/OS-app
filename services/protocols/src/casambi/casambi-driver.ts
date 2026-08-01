import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { createProtocolTracer, type ProtocolTracer } from "../av-sdk/protocol-tracer.js";
import { statesFromUnit, type CasambiUnit } from "./entity-mapper.js";
import {
  CasambiSessionExpiredError,
  type CasambiCredentials,
  type CasambiGroup,
  type CasambiSession,
  type CasambiTransport,
  type CasambiWire,
} from "./cloud-transport.js";
import { createConnection, type CasambiConnectionMode } from "./connection-manager.js";
import type { CasambiLocalGatewayConfig, CasambiLocalTransport } from "./local-transport/index.js";
import { buildDiscoveredDevices, startLocalDiscovery, stopLocalDiscovery } from "./discovery-engine.js";
import { CasambiFeedbackEngine, WIRE_ID } from "./feedback-engine.js";
import { CloudCommandEngine, LocalCommandEngine, type CasambiCommandEngine } from "./command-engine.js";
import {
  CasambiEventBus,
  disableLocalButtonEvents,
  enableLocalButtonEvents,
  normalizeCloudEvent,
  normalizeLocalPacket,
  type CasambiEventListener,
  type CasambiSignal,
} from "./event-engine.js";
import { buildDiagnosticsSnapshot, type CasambiDiagnosticsSnapshot } from "./diagnostics.js";
import { removeDeviceBindings, removeDeviceStates } from "../binding-cleanup.js";

/**
 * Real Casambi protocol driver (§3, §7; § Casambi Driver Refactor — Foundation + PR-2 Local
 * Gateway Foundation + § Architecture Validation) — Casambi is a Bluetooth-mesh luminaire
 * ecosystem reachable two ways: Casambi Cloud (REST + WebSocket, the existing, fully-working
 * implementation below) or a local Lithernet Gateway (real UDP Casambi Command protocol —
 * `local-transport/udp-engine.ts` + `udp-codec.ts` — plus the one documented REST write endpoint,
 * `local-transport/rest-client.ts`). The Connection Manager (`connection-manager.ts`) is the ONLY
 * place that picks between them; everything below is written against ONE unified entity model
 * regardless of which mode is active.
 *
 * This orchestrator holds exactly one `CasambiCommandEngine` (`command-engine.ts`, picked once in
 * the constructor) and exactly one event-normalization path (`event-engine.ts`'s
 * `normalizeCloudEvent`/`normalizeLocalPacket` → this class's own `applySignal`) — `command()` and
 * incoming-event handling never branch on connection mode themselves. This shape is the direct
 * result of `docs/architecture/Casambi-Architecture-Audit.md`'s mandatory pre-implementation audit,
 * which found the Command Engine and Event Engine layers did not exist as real, distinct entities
 * before it — read that document before changing this file's command/event dispatch shape again.
 * Cloud behavior is byte-for-byte unchanged from before that refactor: same REST/WebSocket calls,
 * same reconnect/heartbeat timing, same capability mapping, verified by the full pre-existing
 * `casambi-driver.test.ts` Cloud suite passing unmodified.
 *
 * Reliability (Cloud): the wire is heartbeated (PING within the 5-minute keep-alive window) and
 * auto-reconnected with capped exponential backoff. A dropped socket or an expired session triggers
 * a full re-auth + re-fetch + re-open so no state is lost. Capabilities are derived dynamically from
 * each unit's advertised controls — never hard-coded per fixture model.
 *
 * Local mode has no equivalent reconnect loop yet (UDP is connectionless — see the "Local Gateway
 * lifecycle" section near the bottom of this class for why, and TODO.md for the honest follow-up).
 * Local discovery is also honestly progressive rather than instant: it has no REST device-listing
 * endpoint to enumerate from, so units appear as their first NotifyControlValues packet arrives
 * (`local-discovery.ts`).
 *
 * Secrets: the API key, e-mail, password and session id live only inside the injected transport and
 * this instance; they are never written to logs or embedded in thrown errors.
 */

export interface CasambiCommonDriverOptions {
  /** Keep-alive ping period (ms). Default 240_000 (4 min; server closes idle wires after 5). */
  pingIntervalMs?: number;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000. Cloud mode only — Local
   * has no reconnect loop yet (nothing to reconnect to). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** § Driver Settings → Advanced → Logging: lifecycle events surfaced into the Driver
   * Manager's per-driver log, same pipeline every other native driver already uses. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** § Driver Settings → Advanced → Packet Capture. Off by default; when on (and `onLog` is
   * set) records a lightweight, log-line trace of wire traffic via the same shared tracer
   * AVR/HEOS/Yamaha use. This is a text trace, not the binary `PacketRecorder` framework
   * (`core/packet-recorder.ts`) — wiring the real UDP engine's raw datagrams into that recorder
   * is a documented follow-up, not yet done (see TODO.md). */
  trace?: boolean;
}

export type CasambiDriverOptions =
  | (CasambiCommonDriverOptions & {
      connectionMode?: "cloud";
      credentials: CasambiCredentials;
      /** Injectable transport (tests pass a fake; prod builds a real HTTP/WS transport from the key). */
      transport?: CasambiTransport;
    })
  | (CasambiCommonDriverOptions & {
      connectionMode: "local";
      local: CasambiLocalGatewayConfig;
    });

interface CasambiBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  unitId: number;
}

/** Live health snapshot for monitoring/telemetry (no secrets). */
export interface CasambiHealth {
  connectionType: CasambiConnectionMode;
  connected: boolean;
  sessionActive: boolean;
  reconnects: number;
  units: number;
  lastEventAt: string | null;
  lastError: string | null;
}

export class CasambiProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "casambi";
  private readonly mode: CasambiConnectionMode;
  private readonly credentials: CasambiCredentials | null;
  private transport: CasambiTransport | null;
  private readonly localTransport: CasambiLocalTransport | null;
  private readonly feedback: CasambiFeedbackEngine;
  private readonly commandEngine: CasambiCommandEngine;
  private readonly events = new CasambiEventBus();
  private readonly tracer: ProtocolTracer;
  private readonly pingIntervalMs?: number;
  private readonly reconnectBaseMs?: number;
  private readonly reconnectMaxMs?: number;
  private readonly bindings: CasambiBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  /** Latest known unit per unit id (from REST + unitChanged events). */
  private readonly units = new Map<number, CasambiUnit>();
  /** Group id → group (for auto room mapping from group names). */
  private readonly groups = new Map<number, CasambiGroup>();

  private session: CasambiSession | null = null;
  private wire: CasambiWire | null = null;
  private localUnsubscribePacket: (() => void) | null = null;
  private localUnsubscribeError: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private reconnects = 0;
  /** True once the wire has opened successfully at least once (§ Health Monitor — distinguishes
   * "never connected yet" from "was connected, dropped" for an honest verdict). */
  private everConnected = false;
  private lastPingAt: number | null = null;
  private latencyMs: number | null = null;
  private lastEventAt: string | null = null;
  private lastError: string | null = null;

  constructor(opts: CasambiDriverOptions) {
    this.mode = opts.connectionMode ?? "cloud";
    const connection =
      opts.connectionMode === "local"
        ? createConnection({ connectionMode: "local", local: opts.local })
        : createConnection({ connectionMode: "cloud", credentials: opts.credentials, transport: opts.transport });
    this.transport = connection.cloudTransport;
    this.localTransport = connection.localTransport;
    this.credentials = opts.connectionMode === "local" ? null : opts.credentials;
    this.feedback = new CasambiFeedbackEngine(() => this.wire);
    this.commandEngine =
      this.mode === "local" && this.localTransport
        ? new LocalCommandEngine(this.localTransport.udp, this.localTransport.config.netId ?? 0)
        : new CloudCommandEngine(this.feedback);
    this.tracer = createProtocolTracer("casambi", opts.trace === true, opts.onLog);
    this.pingIntervalMs = opts.pingIntervalMs;
    this.reconnectBaseMs = opts.reconnectBaseMs;
    this.reconnectMaxMs = opts.reconnectMaxMs;
  }

  async connect(): Promise<void> {
    this.closing = false;
    if (this.mode === "local") {
      await this.connectLocal();
      return;
    }
    await this.establish();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    if (this.mode === "local") {
      await this.disconnectLocal();
      return;
    }
    this.wire?.close();
    this.wire = null;
    this.session = null;
  }

  isConnected(): boolean {
    if (this.mode === "local") return this.localTransport?.udp.listening ?? false;
    return this.session !== null && (this.wire?.connected ?? false);
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const unitId = this.unitIdFromBinding(binding);
    if (!Number.isFinite(unitId)) throw new Error(`casambi: binding ${binding.deviceId} has no numeric unit id`);
    // Idempotent: replace any existing binding for the same device+capability.
    const existing = this.bindings.findIndex(
      (b) => b.deviceId === binding.deviceId && b.capability === binding.capability,
    );
    const entry: CasambiBinding = { deviceId: binding.deviceId, capability: binding.capability, unitId };
    if (existing >= 0) this.bindings[existing] = entry;
    else this.bindings.push(entry);
    this.devices.add(binding.deviceId);
    // If we already know this unit's live state, surface it to the newly bound capability at once.
    const unit = this.units.get(unitId);
    if (unit) this.applyUnit(unit);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's bindings/cached state
   * without touching the shared session/wire (still needed by other bound units).
   * Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
  }

  /** § Command Engine — the ONE call site for every outgoing command, regardless of connection
   * mode. `this.commandEngine` was picked once, in the constructor; this method never branches
   * on `this.mode` itself (see `command-engine.ts` for why that matters). */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`casambi: ${deviceId} not bound for ${command.capability}`);
    if (!this.isConnected()) throw new Error("casambi: not connected");
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    this.tracer.send(`controlUnit ${b.unitId}`);
    await this.commandEngine.send(b.unitId, command, prev);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (this.session && this.units.size === 0) {
      // Late discovery before the first fetch — pull the model on demand.
      await this.loadNetwork();
    }
    return buildDiscoveredDevices(this.units, this.groups);
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** § Event Bus — subscribe to the transport-independent event taxonomy (DeviceEvent/
   * ButtonEvent/SceneEvent/SensorEvent/NetworkEvent/DiagnosticEvent), additive to {@link onState}. */
  onDriverEvent(listener: CasambiEventListener): () => void {
    return this.events.on(listener);
  }

  /** Health snapshot for monitoring — carries no secrets. */
  getHealth(): CasambiHealth {
    return {
      connectionType: this.mode,
      connected: this.isConnected(),
      sessionActive: this.session !== null,
      reconnects: this.reconnects,
      units: this.units.size,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  /** § Diagnostics — the dedicated Casambi diagnostics page's full snapshot (Connection Type,
   * Gateway, Latency, Entities, Online/Offline Devices, Reconnect Count, Last Event, REST/UDP
   * Status, Health). Driver-level (not per-device), unlike `INativeProtocolDriver.getDiagnostics`. */
  getCasambiDiagnostics(): CasambiDiagnosticsSnapshot {
    const local = this.mode === "local" ? this.localTransport : null;
    return buildDiagnosticsSnapshot({
      mode: this.mode,
      gateway: this.gatewayLabel(),
      connected: this.isConnected(),
      hasConnectedBefore: this.everConnected,
      latencyMs: this.latencyMs,
      units: this.units,
      reconnects: this.reconnects,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      udp: local
        ? {
            socketState: local.udp.socketState,
            localAddress: local.udp.localAddress,
            localPort: local.udp.localPort,
            remoteAddress: local.config.gatewayIp,
            remotePort: local.config.udpPort,
            packetsSent: local.udp.packetsSent,
            packetsReceived: local.udp.packetsReceived,
            lastPacketAt: local.udp.lastPacketAt,
            averageLatencyMs: local.udp.averageLatencyMs,
            lastSendError: local.udp.lastSendError,
            lastDecodeError: local.udp.lastDecodeError,
          }
        : null,
    });
  }

  private gatewayLabel(): string | null {
    if (this.mode === "local") {
      const cfg = this.localTransport?.config;
      return cfg ? `${cfg.gatewayIp}:${cfg.restPort}` : null;
    }
    return this.session?.networkName ?? null;
  }

  // --- connection lifecycle -------------------------------------------------

  private async establish(): Promise<void> {
    if (!this.transport || !this.credentials) return; // unreachable in Cloud mode; guards Local's typed-but-inert path
    this.session = await this.transport.createSession(this.credentials);
    this.tracer.event("session created");
    await this.loadNetwork();
    await this.seedState();
    await this.openWire();
  }

  private async loadNetwork(): Promise<void> {
    if (!this.session || !this.transport) return;
    const network = await this.transport.fetchNetwork(this.session);
    this.groups.clear();
    for (const g of network.groups) this.groups.set(g.id, g);
    for (const unit of network.units) this.mergeUnit(unit);
  }

  private async seedState(): Promise<void> {
    if (!this.session || !this.transport) return;
    try {
      const units = await this.transport.fetchState(this.session);
      for (const unit of units) this.applyUnit(unit);
    } catch (err) {
      // Non-fatal: live state also arrives on the wire immediately after OPEN.
      if (err instanceof CasambiSessionExpiredError) throw err;
    }
  }

  private async openWire(): Promise<void> {
    if (!this.session || !this.transport) return;
    const wire = await this.transport.openWire({
      onEvent: (event) => {
        this.lastEventAt = nowIso();
        const signal = normalizeCloudEvent(event);
        if (signal) this.applySignal(signal);
      },
      onClose: () => this.onDisconnected("socket closed"),
      onError: (error) => this.onDisconnected(sanitizeError(error)),
    });
    this.wire = wire;
    wire.open(this.session, WIRE_ID);
    this.everConnected = true;
    this.reconnects = 0;
    this.lastError = null;
    this.tracer.event("wire opened");
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const period = this.pingIntervalMs ?? 240_000;
    this.pingTimer = setInterval(() => {
      if (this.wire?.connected) {
        this.lastPingAt = Date.now();
        this.wire.ping(WIRE_ID);
      }
    }, period);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onDisconnected(reason: string): void {
    this.lastError = reason;
    this.wire = null;
    this.stopHeartbeat();
    this.events.publish({ type: "network", kind: "disconnected", detail: reason, ts: nowIso() });
    if (this.closing || this.reconnectTimer) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = this.reconnectBaseMs ?? 2_000;
    const max = this.reconnectMaxMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnects, 10));
    this.reconnects += 1;
    this.events.publish({ type: "diagnostic", kind: "reconnect_scheduled", detail: `in ${delay}ms`, ts: nowIso() });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closing) return;
    try {
      // Full re-auth + re-fetch + re-open; a fresh session recovers from HTTP 410.
      await this.establish();
      this.events.publish({ type: "diagnostic", kind: "reconnect_succeeded", ts: nowIso() });
    } catch (err) {
      this.lastError = sanitizeError(err);
      this.events.publish({ type: "diagnostic", kind: "error", detail: this.lastError, ts: nowIso() });
      if (!this.closing) this.scheduleReconnect();
    }
  }

  // --- event handling -------------------------------------------------------

  /** § Event Engine — the ONE reaction point for every normalized `CasambiSignal`, regardless of
   * which transport produced it. `normalizeCloudEvent`/`normalizeLocalPacket` (in
   * `event-engine.ts`) are the only two places that still know a Cloud `CasambiEvent` looks
   * different from a Local `CasambiPacket`; everything past that point — merging a unit,
   * publishing a driver event, triggering a reconnect — happens exactly once, here. */
  private applySignal(signal: CasambiSignal): void {
    switch (signal.kind) {
      case "pong":
        if (this.lastPingAt !== null) {
          this.latencyMs = Date.now() - this.lastPingAt;
          this.lastPingAt = null;
        }
        break;
      case "wireStatus":
        this.onWireStatus(signal.status);
        break;
      case "unit":
        this.applyUnit(signal.unit);
        break;
      case "networkUpdated":
        // Cloud-only signal: configuration changed — refresh the model and re-open the wire.
        this.events.publish({ type: "network", kind: "networkUpdated", ts: nowIso() });
        void this.refreshNetwork();
        break;
      case "unitRemoved":
        this.units.delete(signal.unitId);
        this.events.publish({
          type: "network",
          kind: "networkUpdated",
          detail: `unit ${signal.unitId} removed`,
          ts: nowIso(),
        });
        break;
      case "button":
        this.events.publish({ type: "button", unitId: signal.unitId, action: signal.action, ts: nowIso() });
        break;
      case "sceneRaw":
        // No unitId/sceneId to publish as a typed event yet — see event-engine.ts's doc comment.
        this.tracer.event(`scene called (bits=${signal.bits.join(",")})`);
        break;
    }
  }

  private onWireStatus(status: string): void {
    if (status === "openWireSucceed") {
      this.lastError = null;
      return;
    }
    // Any failure status (keyAuthenticateFailed, invalidSession, tooManyWires, …) → recover.
    this.lastError = `wire: ${status}`;
    this.events.publish({ type: "network", kind: "wireStatus", detail: status, ts: nowIso() });
    if (status === "invalidSession") this.session = null;
    this.onDisconnected(`wire: ${status}`);
  }

  private async refreshNetwork(): Promise<void> {
    try {
      await this.loadNetwork();
      if (this.session && this.wire?.connected) this.wire.open(this.session, WIRE_ID);
    } catch (err) {
      this.onDisconnected(sanitizeError(err));
    }
  }

  /** Merge a unit into the cache (keeping previously-known fields) and emit any state changes. */
  private applyUnit(unit: CasambiUnit): void {
    const prevUnit = this.units.get(unit.id);
    const merged = this.mergeUnit(unit);
    if (typeof merged.activeSceneId === "number" && merged.activeSceneId !== prevUnit?.activeSceneId) {
      this.events.publish({ type: "scene", unitId: merged.id, sceneId: merged.activeSceneId, ts: nowIso() });
    }
    const states = statesFromUnit(merged);
    const targets = this.bindings.filter((b) => b.unitId === merged.id);
    for (const b of targets) {
      const entry = states.find((s) => s.capability === b.capability);
      if (entry) this.record(b.deviceId, b.capability, entry.state, b.unitId);
    }
  }

  private mergeUnit(unit: CasambiUnit): CasambiUnit {
    const prev = this.units.get(unit.id);
    // Events are complete for the state they carry; merge so static fields (name/type/fixture/group)
    // survive partial event payloads.
    const merged: CasambiUnit = { ...prev, ...unit };
    if (!unit.controls && prev?.controls) merged.controls = prev.controls;
    this.units.set(unit.id, merged);
    return merged;
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState, unitId: number): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    const ts = nowIso();
    for (const l of this.listeners) l({ deviceId, capability, state, ts });
    this.events.publish({ type: "device", unitId, deviceId, capability, state, ts });
    if (state.kind === "sensor") {
      this.events.publish({ type: "sensor", unitId, deviceId, measure: state.measure, value: state.value, unit: state.unit, ts });
    }
  }

  private unitIdFromBinding(binding: ProtocolBinding): number {
    const cfg = binding.config ?? {};
    if (typeof cfg.unitId === "number") return cfg.unitId;
    // `address` is the canonical binding target; accept "casambi:45" or a bare "45".
    const raw = binding.address.replace(/^casambi:/, "");
    return Number(raw);
  }

  // --- Local Gateway lifecycle (§ Casambi Driver Refactor — PR-2, Local Gateway Foundation) ----
  // UDP is connectionless by design (no session/wire handshake like Cloud's WebSocket) — "connected"
  // here means the local UDP socket is bound and this driver is listening, not that a specific
  // gateway/network has acknowledged anything. There is no reconnect loop yet: a lost UDP socket
  // has no natural "reconnect" the way a dropped WebSocket does, and the gateway is on the same
  // LAN rather than across the internet — see TODO.md for the honest follow-up on detecting and
  // recovering from a socket error mid-session.

  private async connectLocal(): Promise<void> {
    const local = this.localTransport;
    if (!local) return; // unreachable — createConnection always builds one in local mode
    await local.udp.start();
    this.localUnsubscribePacket = local.udp.onPacket((pkt) => {
      this.lastEventAt = nowIso();
      const signal = normalizeLocalPacket(pkt.packet, (unitId) => this.units.get(unitId));
      if (signal) this.applySignal(signal);
    });
    this.localUnsubscribeError = local.udp.onError((err) => {
      this.lastError = sanitizeError(err);
      this.events.publish({ type: "diagnostic", kind: "error", detail: this.lastError, ts: nowIso() });
    });
    this.everConnected = true;
    this.lastError = null;
    this.events.publish({ type: "network", kind: "connected", ts: nowIso() });
    this.tracer.event("local UDP engine started");

    // Best-effort realtime subscription. Subscribe/NotifyButtonEvent are documented as requiring
    // Evolution firmware >= 37.90 / 39.50 respectively (p.314, p.316); on older firmware the
    // gateway simply never emits these opcodes back — an honest, silent no-op this driver cannot
    // distinguish from "not subscribed yet" without real hardware to verify against (see TODO.md).
    const netId = local.config.netId ?? 0;
    try {
      await startLocalDiscovery(local.udp, netId);
      await enableLocalButtonEvents(local.udp, netId);
    } catch (err) {
      this.lastError = sanitizeError(err);
      this.events.publish({ type: "diagnostic", kind: "error", detail: this.lastError, ts: nowIso() });
    }
  }

  private async disconnectLocal(): Promise<void> {
    const local = this.localTransport;
    this.localUnsubscribePacket?.();
    this.localUnsubscribePacket = null;
    this.localUnsubscribeError?.();
    this.localUnsubscribeError = null;
    if (!local) return;
    const netId = local.config.netId ?? 0;
    try {
      await disableLocalButtonEvents(local.udp, netId);
      await stopLocalDiscovery(local.udp, netId);
    } catch {
      // Best-effort teardown — the socket is closing regardless.
    }
    await local.udp.stop();
  }
}

/** Reduce any thrown value to a short, credential-free message. */
function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function nowIso(): string {
  return new Date().toISOString();
}
