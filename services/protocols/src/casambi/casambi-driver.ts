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
import { capabilitiesFromUnit, statesFromUnit, type CasambiUnit } from "./entity-mapper.js";
import {
  CasambiSessionExpiredError,
  HttpCasambiTransport,
  type CasambiCredentials,
  type CasambiGroup,
  type CasambiSession,
  type CasambiTransport,
  type CasambiWire,
} from "./cloud-transport.js";
import { createConnection, type CasambiConnectionMode } from "./connection-manager.js";
import type { CasambiLocalGatewayConfig, CasambiLocalTransport } from "./local-transport/index.js";
import {
  buildDiscoveredDevices,
  buildDiscoveredGroups,
  startLocalDiscovery,
  stopLocalDiscovery,
  type CasambiDiscoveredGroup,
} from "./discovery-engine.js";
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
import { buildTransportMonitorSnapshot, type CasambiPacketJourneyEntry, type CasambiTransportMonitorSnapshot } from "./transport-monitor.js";

const MAX_JOURNEY_ENTRIES = 20;
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

/** Result of {@link CasambiProtocolDriver.syncNamesFromCloud} — how many already-discovered Local
 * units were matched to a Cloud unit with a real name, out of how many the Cloud network reports
 * in total. `matched < total` is expected and honest (a unit not yet seen locally, e.g. one that
 * hasn't sent its first `NotifyControlValues` packet, simply can't be named yet). */
export interface CasambiNameSyncResult {
  matched: number;
  total: number;
  networkName: string | null;
}

/** Result of {@link CasambiProtocolDriver.discoverFromCloud} — how many previously-unknown Cloud
 * units were added as pending (`awaitingLocalSignal`) devices, out of how many the Cloud network
 * reports in total. `discovered < total` is expected when some units were already known locally. */
export interface CasambiCloudDiscoverResult {
  discovered: number;
  total: number;
  networkName: string | null;
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
  /** § Casambi Local Gateway — Cloud device discovery. Unit ids added to `units` by
   * {@link discoverFromCloud} that have NOT yet had a real local UDP signal applied — i.e. known
   * to exist (real id/name/controls from the Cloud account) but never actually heard from on this
   * LAN. `applyUnit` (the one path every genuine local signal flows through) clears an id from
   * this set the moment a real packet arrives, so it always reflects live truth, never a stale
   * guess. `discover()` reports this honestly via `raw.awaitingLocalSignal` — never fabricated as
   * "online" or given fake state before the hardware has actually said anything. */
  private readonly cloudOnlyUnitIds = new Set<number>();

  private session: CasambiSession | null = null;
  private wire: CasambiWire | null = null;
  private localUnsubscribePacket: (() => void) | null = null;
  private localUnsubscribeError: (() => void) | null = null;
  private localUnsubscribeRaw: (() => void) | null = null;
  private localUnsubscribeDecodeError: (() => void) | null = null;
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
  /** § LAN Transport Phase 2 — Transport Monitor's Driver-layer counters. Lifetime, additive
   * only — never reset except by constructing a new driver instance. */
  private discoveryEventsCount = 0;
  private commandsIssuedCount = 0;
  private feedbackEventsCount = 0;
  /** § Final Hardware Validation — Local mode only. A datagram that decoded successfully but
   * whose opcode `normalizeLocalPacket` doesn't map to any `CasambiSignal` (e.g. a real but
   * undocumented/unhandled opcode) reaches here as a REAL, observable event, not a silent drop —
   * exactly the "Discovery ignored packet — Opcode 0xXX not mapped" failure mode the Failure
   * Analysis report needs to be able to name. */
  private unmappedOpcodeCount = 0;
  private lastUnmappedOpcode: number | null = null;
  /** § Final Hardware Validation — Packet Trace (driver-level; see `CasambiPacketJourneyEntry`'s
   * doc comment for why this is separate from the engine's `recentTraces`). Bounded, same
   * convention as the engine's trace log. */
  private readonly packetJourney: CasambiPacketJourneyEntry[] = [];
  private pendingJourneyStart: { at: bigint; rinfo: { address: string; port: number }; raw: string } | null = null;

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
    this.commandsIssuedCount += 1;
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (this.session && this.units.size === 0) {
      // Late discovery before the first fetch — pull the model on demand.
      await this.loadNetwork();
    }
    return buildDiscoveredDevices(this.units, this.groups, this.cloudOnlyUnitIds);
  }

  /** § Casambi Group → Supreme Room — the group-level companion to {@link discover}. Group names
   * come from the Cloud account (Local UDP carries none), so in Local mode this is populated by
   * {@link discoverFromCloud}/{@link syncNamesFromCloud}, exactly like unit names are. */
  async discoverGroups(): Promise<CasambiDiscoveredGroup[]> {
    if (this.session && this.units.size === 0) await this.loadNetwork();
    return buildDiscoveredGroups(this.units, this.groups);
  }

  /**
   * § Casambi Local Gateway — one-time Cloud name sync. Local mode has no protocol-level path to
   * a fixture's real name — confirmed by checking every locally-reachable Lithernet interface
   * (UDP `NotifyControlValues`, the entire documented WebAPI, the web UI, `.ceg` export, the
   * Diagnostics console): none carry a name field. Names exist only in the Casambi Cloud account.
   *
   * This opens a REST-only session (`createSession` + `fetchNetwork`, no WebSocket, no
   * `openWire`), matches each Cloud unit to an already-discovered LOCAL unit by numeric id (the
   * same Casambi network addressing scheme both transports share), copies over `name` where
   * present, then discards the session entirely — nothing here becomes a live connection or an
   * ongoing dependency. Local UDP stays the only transport for discovery, commands, and live
   * state; this method touches naming metadata only, never a device's live state. Safe to call
   * repeatedly (e.g. an installer "Re-sync names" action) — idempotent, no side effects beyond
   * updating `unit.name` for units this call actually matched.
   *
   * Throws if called in Cloud mode (`connectionMode: "cloud"` already has real names from its own
   * live session — this method exists specifically for the Local-mode gap) or if the Cloud
   * request itself fails (invalid credentials, network unreachable) — never silently no-ops.
   */
  async syncNamesFromCloud(creds: CasambiCredentials, transport: CasambiTransport = new HttpCasambiTransport({ apiKey: creds.apiKey })): Promise<CasambiNameSyncResult> {
    if (this.mode !== "local") {
      throw new Error("casambi: syncNamesFromCloud is only meaningful in Local mode — Cloud mode already has real names from its own session");
    }
    const session = await transport.createSession(creds);
    const network = await transport.fetchNetwork(session);
    let matched = 0;
    for (const cloudUnit of network.units) {
      const local = this.units.get(cloudUnit.id);
      if (!local) continue;
      const name = cloudUnit.name?.trim();
      if (!name) continue;
      this.units.set(cloudUnit.id, { ...local, name });
      matched += 1;
    }
    return { matched, total: network.units.length, networkName: session.networkName ?? null };
  }

  /**
   * § Casambi Local Gateway — Cloud device discovery. Local UDP discovery is progressive and
   * requires physical action (a unit only appears once it sends its first `NotifyControlValues`
   * packet — e.g. someone toggles it), which makes commissioning a large fixture list slow and
   * error-prone. This opens the SAME kind of REST-only session `syncNamesFromCloud` does (no
   * WebSocket, no `openWire`, discarded immediately after the fetch) and adds a `units` entry for
   * every Cloud-reported fixture NOT already known locally, using the Cloud API's own `controls`
   * array (already sufficient for `capabilitiesFromUnit` — no local signal needed to know a unit
   * is a dimmer/CCT/RGB fixture, only to know it's genuinely present and reachable on this LAN).
   *
   * Never overwrites a unit already known from a real local signal (checked via `this.units.has`)
   * — Cloud data can lag or omit fields a live signal already reported correctly, so live-known
   * state always wins. Newly-added units are tracked in `cloudOnlyUnitIds` and reported via
   * `discover()`'s `raw.awaitingLocalSignal: true` — visible immediately with a real name, but
   * never claimed as commanded, live, or bound until an actual local UDP packet confirms it (see
   * `applyUnit`, the one place that clears an id from that set). Command/feedback for these
   * devices, once bound, still goes exclusively through Local UDP — this method only seeds
   * metadata, never becomes an ongoing dependency on the Cloud connection.
   *
   * Throws under the same conditions as `syncNamesFromCloud` (Cloud mode already discovers from
   * its own live session; a failed Cloud request is never a silent no-op).
   */
  async discoverFromCloud(
    creds: CasambiCredentials,
    transport: CasambiTransport = new HttpCasambiTransport({ apiKey: creds.apiKey }),
    wireBurstMs = 1500,
  ): Promise<CasambiCloudDiscoverResult> {
    if (this.mode !== "local") {
      throw new Error("casambi: discoverFromCloud is only meaningful in Local mode — Cloud mode already discovers units from its own live session");
    }
    const session = await transport.createSession(creds);
    const network = await transport.fetchNetwork(session);
    // Local UDP carries no group information at all, so this is the only source Local mode ever
    // has for room auto-mapping (buildDiscoveredDevices' `raw.room`) — seeded here as a side
    // effect of the same fetch, never a separate ongoing Cloud dependency.
    for (const group of network.groups) this.groups.set(group.id, group);
    // § live-confirmed fix — `GET /v1/networks/{id}` (fetchNetwork) only returns structural
    // fields (name/id/fixtureId/type) per Casambi's own docs; the `controls` array (Dimmer/CCT/
    // Color, i.e. the thing that actually determines "dimmable" vs "tunable white") only comes
    // from `GET /v1/networks/{id}/state` (fetchState) — the same call Cloud mode's own seedState()
    // already makes at connect. Without this, every unit discovered from Cloud in Local mode was
    // structurally correct but permanently capability-less beyond whatever Local UDP happened to
    // report on its own. Merge state's controls onto each cloud unit before recording it.
    const stateById = new Map((await transport.fetchState(session)).map((u) => [u.id, u]));
    // § live-confirmed fix — even `/state` can under-report a fixture's real control set (live-
    // confirmed on a real Lithernet/DALI-bridged CCT fixture: both REST endpoints reported only
    // "Dimmer", never "CCT", for the exact same unit Cloud mode's own live WebSocket correctly
    // reports "CCT" for). Cloud mode gets the fuller picture "for free" because its wire stays
    // open forever and receives each unit's own unitChanged burst; Local mode's one-time Cloud-
    // discovery step opens that SAME wire just long enough to catch it, then closes — never a
    // standing dependency, matching the "never opens a WebSocket wire" contract everywhere else
    // in this file (that guarantee is about Local mode's ONGOING operation, which stays UDP-only
    // unconditionally; this is a one-time enrichment pass, exactly like fetchNetwork/fetchState
    // above). Best-effort: any failure here still leaves the REST-derived data intact.
    await this.enrichFromCloudWireBurst(session, transport, wireBurstMs);
    let discovered = 0;
    for (let cloudUnit of network.units) {
      const state = stateById.get(cloudUnit.id);
      if (state?.controls) cloudUnit = { ...cloudUnit, controls: state.controls };
      const existing = this.units.get(cloudUnit.id);
      if (!existing) {
        this.units.set(cloudUnit.id, cloudUnit);
        this.cloudOnlyUnitIds.add(cloudUnit.id);
        discovered += 1;
        continue;
      }
      // § live-confirmed fix — a unit Local UDP already saw (even just one dimmer packet, before
      // its own colorTemperature/CCT NotifyControlValues arrived) was being left permanently
      // "dimmable" forever: `discoverFromCloud` used to skip it outright, so the Cloud REST
      // account's own `controls` (which DOES carry the full CCT/RGB set immediately) never
      // reached it. Never clobber real local state (dimLevel/on/existing control values) —
      // only add control TYPES local hasn't reported yet, so capability detection (`cct` etc.)
      // is correct right away without discarding live feedback already recorded.
      const knownTypes = new Set((existing.controls ?? []).map((c) => c.type));
      const missing = (cloudUnit.controls ?? []).filter((c) => !knownTypes.has(c.type));
      // § live-confirmed fix — merge the STRUCTURAL fields too, not just controls. Local UDP
      // reports none of these (`updateUnitFromControlValues` only ever sets id/dimLevel/on/
      // sensors/controls), and local discovery sees every unit before this runs, so a merge that
      // copied only `controls` left `groupId` undefined on literally every unit — which silently
      // emptied BOTH `buildDiscoveredGroups` (group membership is derived from `unit.groupId`)
      // and `buildDiscoveredDevices`' own `raw.room` hint. Only ever fills a gap: a real local
      // value, if one ever appears, is never overwritten by the Cloud's older copy.
      this.units.set(cloudUnit.id, {
        ...existing,
        ...(existing.groupId === undefined && cloudUnit.groupId !== undefined ? { groupId: cloudUnit.groupId } : {}),
        ...(existing.fixtureId === undefined && cloudUnit.fixtureId !== undefined ? { fixtureId: cloudUnit.fixtureId } : {}),
        ...(existing.type === undefined && cloudUnit.type !== undefined ? { type: cloudUnit.type } : {}),
        ...(existing.address === undefined && cloudUnit.address !== undefined ? { address: cloudUnit.address } : {}),
        ...(missing.length > 0 ? { controls: [...(existing.controls ?? []), ...missing] } : {}),
      });
    }
    return { discovered, total: network.units.length, networkName: session.networkName ?? null };
  }

  /** Opens a short-lived Cloud WebSocket wire — the same one Cloud mode keeps open forever — just
   * long enough to catch each unit's initial `unitChanged` burst, merges any richer control data
   * it reports via the normal {@link applyUnit} path, then closes. Best-effort: a connection
   * failure here is swallowed, leaving whatever REST already provided intact. See
   * {@link discoverFromCloud}'s own doc comment for why this is the one exception to Local mode
   * never opening a wire. */
  private async enrichFromCloudWireBurst(session: CasambiSession, transport: CasambiTransport, burstMs: number): Promise<void> {
    if (burstMs <= 0) return;
    try {
      const wire = await transport.openWire({
        onEvent: (event) => {
          const signal = normalizeCloudEvent(event);
          if (signal?.kind === "unit") this.applyUnit(signal.unit);
        },
        onClose: () => {},
        onError: () => {},
      });
      wire.open(session, WIRE_ID);
      await new Promise((resolve) => setTimeout(resolve, burstMs));
      wire.close();
    } catch {
      // Best-effort enrichment only — REST-derived controls still apply.
    }
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
            recentTraces: local.udp.recentTraces,
          }
        : null,
    });
  }

  /** § LAN Transport Phase 2 — Transport Monitor. Layered, developer-grade diagnostics
   * (Transport/Casambi Adapter/Driver — the Gateway route separately attaches the service-wide
   * "NATS"/`supreme-lan` layer via `queryLanHealth`, since only the Gateway holds the event bus).
   * Additive to {@link getCasambiDiagnostics} — does not change its existing shape. */
  getCasambiTransportMonitor(): CasambiTransportMonitorSnapshot {
    const local = this.mode === "local" ? this.localTransport : null;
    let entities = 0;
    for (const unit of this.units.values()) if (capabilitiesFromUnit(unit).length > 0) entities += 1;
    return buildTransportMonitorSnapshot({
      mode: this.mode,
      entities,
      discoveryEvents: this.discoveryEventsCount,
      commandsIssued: this.commandsIssuedCount,
      feedbackEvents: this.feedbackEventsCount,
      unmappedOpcodeEvents: this.unmappedOpcodeCount,
      lastUnmappedOpcode: this.lastUnmappedOpcode,
      recentJourney: this.packetJourney,
      local: local
        ? {
            listening: local.udp.listening,
            localAddress: local.udp.localAddress,
            localPort: local.udp.localPort,
            transportDiagnostics: local.udp.transportDiagnostics,
            packetsReceived: local.udp.packetsReceived,
            decoded: local.udp.decodedCount,
            decodeFailures: local.udp.decodeFailureCount,
            lastPacketAt: local.udp.lastPacketAt,
            lastDecodeError: local.udp.lastDecodeError,
            recentTraces: local.udp.recentTraces,
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
    // A real signal for this unit just arrived — it's no longer merely Cloud-known, it's been
    // genuinely confirmed on this LAN. See cloudOnlyUnitIds' own doc comment.
    this.cloudOnlyUnitIds.delete(unit.id);
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
    if (!prev) this.discoveryEventsCount += 1;
    // Events are complete for the state they carry; merge so static fields (name/type/fixture/group)
    // survive partial event payloads.
    const merged: CasambiUnit = { ...prev, ...unit };
    // § live-confirmed fix — a partial local update (e.g. only a dimmer-level packet, before the
    // fixture's own colorTemperature packet has arrived) used to fully REPLACE `controls` with
    // its own short list, silently dropping a CCT/color control `discoverFromCloud` had already
    // merged in — a unit could go back to "dimmable only" after every plain brightness change.
    // Union by control type instead: keep every previously-known type, let this update's own
    // entries (a real, fresher read) win for the types it actually reports.
    if (unit.controls) {
      const byType = new Map((prev?.controls ?? []).map((c) => [c.type, c]));
      for (const c of unit.controls) byType.set(c.type, c);
      merged.controls = [...byType.values()];
    } else if (prev?.controls) {
      merged.controls = prev.controls;
    }
    this.units.set(unit.id, merged);
    return merged;
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState, unitId: number): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.feedbackEventsCount += 1;
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
    // § UDP Receive Pipeline Audit, Step 1: log the instant a datagram is received, strictly
    // before any parsing — proves `socket.on("message")` is really firing, independent of
    // whether the payload later decodes. Real hardware evidence showed the OS receiving
    // broadcast packets the driver had no way to confirm without this.
    this.localUnsubscribeRaw = local.udp.onRawDatagram((raw, rinfo) => {
      this.tracer.event(`UDP datagram received from ${rinfo.address}:${rinfo.port} (${raw.length} bytes)`);
      // § Final Hardware Validation — Packet Trace: `onRawDatagram`/`onDecodeError`/`onPacket`
      // fire synchronously in sequence for the SAME datagram (the engine's `handleMessage` is
      // entirely synchronous), so stashing the start time + rinfo here and consuming it in
      // whichever of the other two fires next gives a real, measured `processingDurationMs`.
      this.pendingJourneyStart = { at: process.hrtime.bigint(), rinfo, raw };
    });
    this.localUnsubscribeDecodeError = local.udp.onDecodeError((raw, err) => {
      // § UDP Receive Pipeline Audit, Step 7: never a silent drop — the raw payload is always
      // available here and in `getCasambiDiagnostics().udp.recentTraces`.
      this.tracer.event(`UDP parse failed: ${err.message} — raw: ${raw.trim()}`);
      this.recordJourneyEntry(raw, { decoded: false, decodeError: err.message, opcode: null, handlerInvoked: null, outcome: "decode_failed" });
    });
    this.localUnsubscribePacket = local.udp.onPacket((pkt) => {
      this.lastEventAt = nowIso();
      const signal = normalizeLocalPacket(pkt.packet, (unitId) => this.units.get(unitId));
      if (signal) {
        this.applySignal(signal);
        this.recordJourneyEntry(pkt.raw, { decoded: true, decodeError: null, opcode: pkt.packet.opcode, handlerInvoked: signal.kind, outcome: "mapped" });
      } else {
        this.unmappedOpcodeCount += 1;
        this.lastUnmappedOpcode = pkt.packet.opcode;
        this.tracer.event(`opcode 0x${pkt.packet.opcode.toString(16)} decoded but not mapped to a driver signal — ignored`);
        this.recordJourneyEntry(pkt.raw, { decoded: true, decodeError: null, opcode: pkt.packet.opcode, handlerInvoked: null, outcome: "unmapped_opcode" });
      }
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

  /** § Final Hardware Validation — Packet Trace. Finalizes the journey entry started by the most
   * recent `onRawDatagram` call for THIS datagram (see the doc comment on `pendingJourneyStart`).
   * A no-op (never throws/fabricates) if called with no pending start — defensive only, since the
   * engine always fires raw-datagram before decode-error/packet for the same datagram. */
  private recordJourneyEntry(
    raw: string,
    outcome: Pick<CasambiPacketJourneyEntry, "decoded" | "decodeError" | "opcode" | "handlerInvoked" | "outcome">,
  ): void {
    const pending = this.pendingJourneyStart;
    this.pendingJourneyStart = null;
    if (!pending) return;
    const processingDurationMs = Number(process.hrtime.bigint() - pending.at) / 1_000_000;
    this.packetJourney.push({
      at: nowIso(),
      sourceAddress: pending.rinfo.address,
      sourcePort: pending.rinfo.port,
      rawAscii: raw,
      processingDurationMs,
      ...outcome,
    });
    if (this.packetJourney.length > MAX_JOURNEY_ENTRIES) this.packetJourney.shift();
  }

  private async disconnectLocal(): Promise<void> {
    const local = this.localTransport;
    this.localUnsubscribePacket?.();
    this.localUnsubscribePacket = null;
    this.localUnsubscribeError?.();
    this.localUnsubscribeError = null;
    this.localUnsubscribeRaw?.();
    this.localUnsubscribeRaw = null;
    this.localUnsubscribeDecodeError?.();
    this.localUnsubscribeDecodeError = null;
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
