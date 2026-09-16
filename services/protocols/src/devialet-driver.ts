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
import { mediaStateFromDevialet } from "./devialet-codec.js";
import {
  DevialetApiError,
  DevialetIpControlClient,
  type DevialetEndpoint,
} from "./devialet-ip-control-client.js";
import {
  DevialetCiSettingsClient,
  DevialetCiSettingsError,
  type DevialetCiSettingsEndpoint,
  type DevialetCiSettingsLeanState,
} from "./devialet-cisettings-client.js";
import { mdnsBrowse, type MdnsService } from "./mdns.js";
import { DEVIALET_MDNS_SERVICE, parseDevialetCandidate, transportHostFor, type DevialetDiscoveryCandidate } from "./devialet-discovery.js";
import {
  DevialetTopologyRegistry,
  type DevialetFreshDeviceTopology,
  type DevialetDeviceTopology,
  type DevialetTopologySnapshot,
  type DevialetTopologyChangeResult,
} from "./devialet-topology.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { createProtocolTracer, type ProtocolTracer } from "./av-sdk/protocol-tracer.js";
import { DriverDiagnosticsTracker, type DriverDiagnosticsSnapshot, type DriverTraceEntry } from "./driver-diagnostics.js";
import { bestEffortMacForIp } from "./arp-lookup.js";

/** Kept independent of `supreme-avr`'s own version counter — bumped when this driver's
 * own architecture/behavior changes materially. Surfaced in Diagnostics only. */
const DRIVER_VERSION = "6.0.0-fusion-d6";

/**
 * § D3 — the literal example path from the R1 doc's own "The global prefix" section
 * (`http://192.168.1.20/ipcontrol/v1/...`). Used ONLY as this driver's interim default
 * when no real discovered path is available yet (no `binding.config.path`, no
 * `opts.ipControlPath`) — NEVER hardcoded inside `DevialetIpControlClient` itself
 * (which requires an explicit `path` on every call, per the R1 doc's explicit warning
 * that this prefix "can change in the future"). D5 replaces every use of this default
 * with the real mDNS TXT `path` value.
 */
const INTERIM_DEFAULT_PATH = "/ipcontrol/v1";

export interface DevialetDriverOptions {
  /** Poll period for volume/current-source (ms). Whether R1 offers a real push/event
   * channel (vs. this poll-only fallback) is unconfirmed by the doc — see the D3
   * report. Unchanged from D2. */
  pollMs?: number;
  /** Injectable fetch (tests point at an in-process HTTP server); defaults to the
   * real global fetch. Passed straight through to `DevialetIpControlClient`. */
  fetchImpl?: typeof fetch;
  /** Injectable mDNS browser (tests); defaults to a real Bonjour browse. */
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
  /** Surfaces connection/discovery lifecycle events to the Extension Center's driver
   * log — same convention/shape as `AvrDriverOptions.onLog`. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** § Universal AV SDK — when true (and `onLog` is set), every request written and
   * every response/event worth recording is traced in sequence via `onLog`, prefixed
   * `[trace:devialet]`. Off by default, same posture as AVR's `trace` option. */
  trace?: boolean;
  /** § D3 interim wiring — driver-level default IP Control path, used only when a
   * binding doesn't supply its own `config.path`. See `INTERIM_DEFAULT_PATH`'s doc;
   * D5 removes the need for this entirely. */
  ipControlPath?: string;
  /** Per-request timeout (ms), forwarded to `DevialetIpControlClient`. See that
   * class's own doc for why the default (1000ms) is cited from the R1 spec itself. */
  timeoutMs?: number;
}

/**
 * One physical Devialet device's binding (§ D1 Devialet Identity).
 *
 * `host` is TRANSPORT information only. `path` is the IP Control API path this
 * specific binding was told to use (§ D3 — from `binding.config.path`, else the
 * driver's interim default; D5 threads the real discovered value through
 * `discover()`'s results). `devialetId`/`systemId`/`groupId` are `null` until
 * `refreshTopology()` (§ D6) successfully queries this device at least once — bind()
 * itself never populates them (§3 of the D6 brief: topology is discovered AFTER
 * physical binding, never required BY it). Once populated, `systemId`/`groupId`
 * mirror `this.topology.get().devices[devialetId]`'s own values purely as a
 * convenience — `this.topology` remains the single source of truth for anything
 * beyond this one device (system/group membership, other devices' topology).
 */
interface DevialetBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  path: string;
  devialetId: string | null;
  systemId: string | null;
  groupId: string | null;
}

/**
 * Devialet Fusion Driver (§ D1/D2/D3). Same public identity (`protocol = "devialet"`,
 * same `bootstrap.ts`/`config.devialetEnabled` registration, same exported class name)
 * — the ONE Devialet implementation in the fleet.
 *
 * § D3 — real IP Control R1 client: `poll()`/`command()` now compose
 * `DevialetIpControlClient` (a clean, typed, protocol-only HTTP client verified
 * directly against the R1 documentation) instead of the D2 skeleton's temporary raw
 * `/ipcontrol/v1` calls. This driver remains the ONE place that owns lifecycle,
 * binding, diagnostics, and tracing — the client has no knowledge of any of those.
 *
 * § D2's `HttpPollClient`-based coalescing-safety seam is RETIRED in this phase: the
 * client makes one real, independent HTTP request per method call (no shared in-flight
 * promise cache), so the "a command must never coalesce with an in-flight poll"
 * problem D2 had to solve around `HttpPollClient`'s per-key dedup simply does not
 * exist anymore — removing it is a simplification, not a lost safeguard.
 * `DriverDiagnosticsTracker` (per-`host`, in `trackerFor()`) is unchanged from D2 and
 * is still the sole source `getDiagnostics()`/`getTrace()` read from, now updated by
 * `tracked()` wrapping each individual real client call (never once per logical
 * command that might issue >1 real request — see `command()`'s `play` case).
 */
export class DevialetProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "devialet";
  private connected = false;
  private readonly opts: DevialetDriverOptions;
  private readonly bindings: DevialetBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly tracer: ProtocolTracer;
  /** § D3 — the real, typed R1 protocol client. Protocol-only; knows nothing about
   * diagnostics/tracing (see `tracked()` below, which wraps every call this driver
   * makes into it). */
  private readonly client: DevialetIpControlClient;
  /** § D4 — the real, typed CISettings protocol client (secondary/legacy layer).
   * Same protocol-only posture as `client` above: no diagnostics/tracing/state
   * knowledge of its own. Neither client imports the other (§19) — this driver is
   * the only place that knows both exist. */
  private readonly ciSettings: DevialetCiSettingsClient;
  /** § D2 — this driver's own per-transport-endpoint diagnostics identity, keyed by
   * `host`, using the SAME shared `DriverDiagnosticsTracker` class every driver in
   * this fleet uses. Shared across BOTH protocol clients — a single device's R1 and
   * CISettings traffic land in the same tracker, distinguished only by the `tracked()`
   * label prefix ("R1 " vs "CISettings "), matching §18's "one tracker, distinguishable
   * traces" requirement rather than a second diagnostics system. */
  private readonly diagnostics = new Map<string, DriverDiagnosticsTracker>();
  /** § D6 — this driver instance's own Device→System→Group topology state. One
   * registry per driver instance (a plain instance field, exactly like `bindings`/
   * `states`) — never a module-level singleton (§16 of the D6 brief). */
  private readonly topology = new DevialetTopologyRegistry();
  private readonly topologyListeners = new Set<(result: DevialetTopologyChangeResult) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DevialetDriverOptions = {}) {
    this.opts = opts;
    this.tracer = createProtocolTracer("devialet", opts.trace === true, opts.onLog);
    this.client = new DevialetIpControlClient({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
    this.ciSettings = new DevialetCiSettingsClient({ fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  }

  private trackerFor(host: string): DriverDiagnosticsTracker {
    let t = this.diagnostics.get(host);
    if (!t) {
      t = new DriverDiagnosticsTracker();
      this.diagnostics.set(host, t);
    }
    return t;
  }

  /** § D3 — wraps exactly ONE real `DevialetIpControlClient` call in real
   * send/receive/error diagnostics + tracing, using this device's stable
   * `trackerFor(host)`. Used at every individual client call site (never once per
   * logical `command()` invocation) so a command that genuinely issues two real HTTP
   * requests (`play`'s current-source lookup + the play POST) is counted as two real
   * requests, and a command that issues one is counted as one — never double-counted,
   * never under-counted. */
  private async tracked<T>(host: string, label: string, fn: () => Promise<T>): Promise<T> {
    const tracker = this.trackerFor(host);
    tracker.recordSend(label);
    this.tracer.send(label);
    try {
      const result = await fn();
      tracker.recordReceive(label);
      this.tracer.receive(label);
      return result;
    } catch (err) {
      tracker.recordError(err instanceof Error ? err.message : String(err));
      this.tracer.event(`request failed ${label} — ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private endpointFor(b: DevialetBinding): DevialetEndpoint {
    return { host: b.host, path: b.path };
  }

  /** § D4 — CISettings has a fixed `/cisettings/<opcode>` path (no discovered-path
   * concept at all, unlike R1) — so this is simply the binding's transport host,
   * never `b.path` (which is R1-specific). */
  private ciSettingsEndpointFor(b: DevialetBinding): DevialetCiSettingsEndpoint {
    return { host: b.host };
  }

  async connect(): Promise<void> {
    // Devialet's control surface is stateless HTTP — there is no persistent link to
    // lazily open per binding, so "readiness" is just: start polling.
    this.connected = true;
    const period = this.opts.pollMs ?? 3000;
    this.timer = setInterval(() => void this.poll(), period);
    (this.timer as { unref?: () => void }).unref?.();
    this.opts.onLog?.("info", "devialet: driver connected, polling started");
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Mirrors AvrProtocolDriver.disconnect(): `bindings`/`states`/`listeners`/
    // `diagnostics` all survive a disconnect/reconnect cycle — only the poll timer is
    // torn down here.
    this.connected = false;
    this.opts.onLog?.("info", "devialet: driver disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Idempotent, mirroring `AvrProtocolDriver.bind()`: a repeat bind for the same
   * device+capability replaces the existing entry rather than duplicating it.
   * `path` comes from `binding.config.path` (a real, discovered value from D5's
   * `discover()`) or the driver's interim default (§ `INTERIM_DEFAULT_PATH`).
   * `devialetId`/`systemId`/`groupId` stay `null` until `refreshTopology()` (§ D6)
   * runs at least once for this device. */
  async bind(binding: ProtocolBinding): Promise<void> {
    const existingIdx = this.bindings.findIndex((b) => b.deviceId === binding.deviceId && b.capability === binding.capability);
    const configPath = typeof binding.config?.path === "string" ? binding.config.path : undefined;
    const nextEntry: DevialetBinding = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      host: binding.address,
      path: configPath ?? this.opts.ipControlPath ?? INTERIM_DEFAULT_PATH,
      devialetId: existingIdx >= 0 ? this.bindings[existingIdx]!.devialetId : null,
      systemId: existingIdx >= 0 ? this.bindings[existingIdx]!.systemId : null,
      groupId: existingIdx >= 0 ? this.bindings[existingIdx]!.groupId : null,
    };
    if (existingIdx >= 0) this.bindings[existingIdx] = nextEntry;
    else this.bindings.push(nextEntry);
    this.devices.add(binding.deviceId);
    this.tracer.event(`bind ${binding.deviceId} ${binding.capability} -> ${binding.address}${nextEntry.path}`);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's bindings/cached state,
   * and releases the shared per-`host` diagnostics tracker once no other bound device
   * still references that `host` (ref-counted, mirroring `AvrProtocolDriver.unbind()`).
   * Idempotent; never throws for an unmanaged device. */
  async unbind(deviceId: DeviceId): Promise<void> {
    const removed = this.bindings.filter((b) => b.deviceId === deviceId);
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
    for (const host of new Set(removed.map((b) => b.host))) {
      if (this.bindings.some((b) => b.host === host)) continue;
      this.diagnostics.delete(host);
    }
    // § D6 — a genuine unbind (this Supreme device is gone, not a transient query
    // failure) removes it from topology entirely, so it doesn't linger as a "last
    // known" system/group member forever. Distinct from a failed refreshTopology()
    // query, which deliberately KEEPS the last-known entry (see devialet-topology.ts).
    for (const b of removed) {
      if (b.devialetId) this.notifyTopologyChange(this.topology.remove(b.devialetId));
    }
  }

  /**
   * Writes a command to the device via the real R1 client. Deliberately does NOT
   * write to `this.states`/call `recordCapabilityState()` — confirmed state only ever
   * flows through `poll()` (D9/D10 will formalize this as real command confirmation).
   * An accepted request here means "the device accepted the request," never "the
   * state is now this" — see `DevialetIpControlClient.pause()`'s doc for the concrete
   * reason this matters (optical-input pause mutes instead of pausing).
   */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error(`devialet: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`devialet: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media") throw new Error(`devialet: unsupported command for ${command.capability}`);
    const endpoint = this.endpointFor(b);
    switch (command.action) {
      case "play": {
        // § R1 doc — "play" addresses a specific sourceId, not "current." Resolving
        // "resume whatever is playing" therefore requires reading the real current
        // source first — a genuine second HTTP request, not an invented shortcut.
        const current = await this.tracked(b.host, "R1 GET current source (for play)", () => this.client.getCurrentSource(endpoint));
        if (!current.source) throw new Error(`devialet: ${deviceId} has no current source to resume playback on`);
        await this.tracked(b.host, "R1 POST play", () => this.client.play(endpoint, current.source!.sourceId));
        return;
      }
      case "pause":
      case "stop":
        // "stop" has no distinct R1 equivalent — mapped to pause, same as the
        // pre-Fusion driver's own choice.
        await this.tracked(b.host, "R1 POST pause", () => this.client.pause(endpoint));
        return;
      case "next":
        await this.tracked(b.host, "R1 POST next", () => this.client.next(endpoint));
        return;
      case "previous":
        await this.tracked(b.host, "R1 POST previous", () => this.client.previous(endpoint));
        return;
      case "mute":
        await this.tracked(b.host, "R1 POST mute", () => this.client.mute(endpoint));
        return;
      case "unmute":
        await this.tracked(b.host, "R1 POST unmute", () => this.client.unmute(endpoint));
        return;
      case "volume":
        if (typeof command.volume !== "number") throw new Error(`devialet: volume command missing a numeric volume`);
        await this.tracked(b.host, "R1 POST volume", () => this.client.setVolume(endpoint, command.volume as number));
        return;
      default:
        throw new Error(`devialet: unsupported command for media (${command.action})`);
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  /** § D3/D4/D6 — still an honest no-op for CAPABILITY detection specifically
   * (CISettings-derived feature detection isn't implemented until a later phase).
   * Topology refresh is a SEPARATE, real operation — see `refreshTopology()` — not
   * folded into this method, since `refreshCapabilities()`'s documented contract
   * (§ `INativeProtocolDriver`) is about re-querying a device's CAPABILITIES, not its
   * System/Group relationships. */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    if (!this.manages(deviceId)) return;
    this.tracer.event(`refreshCapabilities ${deviceId} — no-op (capability detection lands in a later phase)`);
  }

  private notifyTopologyChange(result: DevialetTopologyChangeResult): DevialetTopologyChangeResult {
    if (result.changed) {
      for (const listener of this.topologyListeners) listener(result);
    }
    return result;
  }

  /** Subscribe to real topology changes (§14 of the D6 brief) — same shape as
   * `onState()`: a `Set`-backed listener registry with an unsubscribe closure, no new
   * event bus. Only fires for an ACTUAL change (`result.changed`), mirroring
   * `onState()`'s own dedupe-before-dispatch discipline via `recordCapabilityState()`. */
  onTopologyChange(listener: (result: DevialetTopologyChangeResult) => void): () => void {
    this.topologyListeners.add(listener);
    return () => this.topologyListeners.delete(listener);
  }

  /** The current topology snapshot, read-only — no network call. */
  getTopologySnapshot(): DevialetTopologySnapshot {
    return this.topology.get();
  }

  /** This SupremeOS device's current Devialet topology, or `null` if unmanaged or if
   * `refreshTopology()` has never successfully resolved this device's identity yet
   * (never a fabricated placeholder). */
  getDeviceTopology(deviceId: DeviceId): DevialetDeviceTopology | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b || !b.devialetId) return null;
    return this.topology.get().devices[b.devialetId] ?? null;
  }

  /**
   * § D6 — the real Device→System→Group reconciliation pass. For every currently
   * media-bound device: queries `GET /devices/current` (establishing/confirming this
   * device's real `deviceId` — the one place this driver finally populates
   * `DevialetBinding.devialetId`, deliberately deferred since D1), and, for each
   * DISTINCT `systemId` encountered, one best-effort `GET /systems/current` call for
   * its display name (deduped — never once per device sharing that system). Every
   * per-device query result feeds `DevialetTopologyRegistry.merge()`, which performs
   * the actual reconciliation (see `devialet-topology.ts` for the merge/idempotency
   * rules). A device whose query fails this round is simply skipped — its last-known
   * topology (if any) is preserved untouched by the registry's own merge rule, never
   * treated as "left the system." `onTopologyChange()` listeners fire only if the
   * resulting snapshot actually differs from the previous one.
   *
   * No timer here — an explicit, caller-invoked operation, per §13 of the D6 brief
   * ("Do NOT introduce an aggressive timer yet... a later phase will decide how
   * frequently topology should be refreshed").
   */
  async refreshTopology(): Promise<DevialetTopologyChangeResult> {
    this.tracer.event("topology: refresh started");
    const mediaBindings = this.bindings.filter((b) => b.capability === "media");
    const systemNames = new Map<string, string | null>();
    const fresh: DevialetFreshDeviceTopology[] = [];
    for (const b of mediaBindings) {
      const endpoint = this.endpointFor(b);
      let info;
      try {
        info = await this.tracked(b.host, "R1 GET devices/current (topology)", () => this.client.getDevice(endpoint));
      } catch (err) {
        this.tracer.event(`topology: device query failed for ${b.deviceId} — ${err instanceof Error ? err.message : String(err)} (keeping last-known topology)`);
        continue;
      }
      b.devialetId = info.deviceId;
      b.systemId = info.systemId ?? null;
      b.groupId = info.groupId ?? null;
      const systemId = info.systemId ?? null;
      if (systemId && !systemNames.has(systemId)) {
        try {
          const system = await this.tracked(b.host, "R1 GET systems/current (topology)", () => this.client.getSystem(endpoint));
          systemNames.set(systemId, system.systemName);
        } catch (err) {
          this.tracer.event(`topology: system name query failed for ${systemId} — ${err instanceof Error ? err.message : String(err)} (device/system membership unaffected)`);
          systemNames.set(systemId, null);
        }
      }
      fresh.push({
        deviceId: info.deviceId,
        supremeDeviceId: b.deviceId,
        host: b.host,
        systemId,
        groupId: info.groupId ?? null,
        role: info.role ?? null,
        systemName: systemId ? systemNames.get(systemId) : undefined,
      });
      this.tracer.event(`topology: device ${info.deviceId} system=${systemId ?? "none"} group=${info.groupId ?? "none"} role=${info.role ?? "none"}`);
    }
    const result = this.notifyTopologyChange(this.topology.merge(fresh));
    this.tracer.event(result.changed ? "topology: changed" : "topology: unchanged");
    return result;
  }

  /**
   * § D4 — CISettings enrichment seam. Deliberately NOT part of `poll()`/`command()`'s
   * confirmed-state path (`this.states`) — R1 remains authoritative there; this is a
   * separate, explicit read for a caller that wants CISettings' own view (legacy
   * compatibility, additional feedback) alongside R1's. State fusion — which
   * protocol's value SupremeOS actually trusts for a given field — is D9's job, not
   * this method's. Returns `null` for an unmanaged device, matching every other
   * optional-lookup method on this driver; propagates a real `DevialetCiSettingsError`
   * (e.g. `kind: "http"` on an older unit with no CISettings server at all) for a
   * managed one, rather than silently swallowing it into `null`.
   */
  async getCiSettingsLean(deviceId: DeviceId): Promise<DevialetCiSettingsLeanState | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.tracked(b.host, "CISettings GET getlean", () => this.ciSettings.getLean(this.ciSettingsEndpointFor(b)));
  }

  /** § D4 — CISettings' own `internalstate` ("OK" / "NOK <code>") — real hardware
   * self-diagnostic data no R1 endpoint exposes. Same posture as
   * `getCiSettingsLean()`: enrichment only, never written into `this.states`. */
  async getCiSettingsInternalState(deviceId: DeviceId): Promise<string | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.tracked(b.host, "CISettings GET internalstate", () => this.ciSettings.getInternalState(this.ciSettingsEndpointFor(b)));
  }

  /** Real, per-endpoint connection/traffic diagnostics — unchanged shape from D2.
   * `firmware`/`model` stay honestly `null` (querying `/devices/current` for these is
   * real and possible via the client, but wiring it into `getDiagnostics()` itself is
   * left for a later pass rather than issuing a speculative extra network call on
   * every diagnostics read); `serial` reports `devialetId`, still `null` until D5. */
  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const tracker = this.trackerFor(b.host);
    const ip = hostOnly(b.host);
    return tracker.snapshot(this.connected ? "connected" : "disconnected", {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: null,
      firmware: null,
      serial: b.devialetId,
      ip,
      mac: bestEffortMacForIp(ip),
    });
  }

  /** Real recent-trace ring buffer, same underlying tracker as `getDiagnostics()`. */
  getTrace(deviceId: DeviceId): DriverTraceEntry[] | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.trackerFor(b.host).recentTrace();
  }

  /**
   * § D5 — real, production-grade discovery. Browses the correct `_http._tcp`
   * service type (§ `devialet-discovery.ts` — `_devialet-http._tcp`, this driver's
   * value before D5, appears nowhere in the R1 doc), filters candidates via
   * `parseDevialetCandidate()` (manufacturer/ipControlVersion/path/port, all pure —
   * no I/O), then confirms EACH surviving candidate's real, stable Devialet
   * `deviceId` via a genuine `GET /devices/current` — the one step that turns a
   * "discovered transport" into an "identified Devialet device" (§8/§9).
   *
   * `backendId` is the real Devialet `deviceId`, never an IP/host — so the SAME
   * physical unit produces the SAME `backendId` across repeated `discover()` calls
   * regardless of which IP it currently answers on (§6/§8), and the R1 doc's own
   * documented case of one physical device announcing multiple mDNS instances
   * (IPv4 + IPv6 duplicates of its "-ipcontrol" service, per the doc's own
   * `avahi-browse` example) collapses to ONE entry per real `deviceId` (§7) — the
   * FIRST successfully-identified instance wins; later duplicates for the same
   * `deviceId` are silently dropped, not double-reported.
   *
   * A candidate whose `/devices/current` query fails (device rebooting,
   * transiently unreachable, …) is simply OMITTED from this call's results — never
   * assigned a fabricated `backendId` — per §9's explicit prohibition. One
   * candidate's failure never affects any other candidate (`Promise.allSettled`).
   */
  async discover(): Promise<DiscoveredDevice[]> {
    const browse = this.opts.mdns ?? mdnsBrowse;
    this.tracer.event(`discover: mDNS browse ${DEVIALET_MDNS_SERVICE}`);
    const services = await browse(DEVIALET_MDNS_SERVICE);
    const candidates = services
      .map((s) => parseDevialetCandidate(s))
      .filter((c): c is DevialetDiscoveryCandidate => c !== null);
    this.tracer.event(`discover: ${services.length} mDNS record(s), ${candidates.length} Devialet R1 candidate(s) after TXT filtering`);

    const results = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const host = transportHostFor(candidate);
        const endpoint: DevialetEndpoint = { host, path: candidate.path };
        const device = await this.tracked(host, "R1 GET devices/current (discovery)", () => this.client.getDevice(endpoint));
        return { candidate, host, device };
      }),
    );

    const byDeviceId = new Map<string, DiscoveredDevice>();
    for (const result of results) {
      if (result.status === "rejected") {
        this.tracer.event(`discover: identity query failed for a candidate — ${result.reason instanceof Error ? result.reason.message : String(result.reason)} (omitted, not fabricated)`);
        continue;
      }
      const { candidate, host, device } = result.value;
      if (byDeviceId.has(device.deviceId)) {
        this.tracer.event(`discover: duplicate mDNS instance for already-identified deviceId ${device.deviceId} (${candidate.mdnsName}) — suppressed`);
        continue;
      }
      byDeviceId.set(device.deviceId, {
        backendId: device.deviceId,
        suggestedName: device.deviceName || instanceName(candidate.mdnsName) || `Devialet ${host}`,
        capabilities: ["media"] as DiscoveredDevice["capabilities"],
        raw: {
          host,
          port: candidate.port,
          path: candidate.path,
          ipControlVersion: candidate.ipControlVersion,
          model: device.model,
          serial: device.serial,
          softwareVersion: device.release.version,
          role: device.role ?? null,
          // § Commissioning integration note — mirrors AVR's `raw.bindConfig`
          // pattern: the eventual `ProtocolBinding` for this device should use
          // `address: host` and `config: { path }` (this driver's `bind()` already
          // reads `binding.config.path`, see D3). Not wired further here — no
          // commissioning-flow code exists in `services/protocols`.
          bindConfig: { path: candidate.path },
        },
      });
    }
    this.tracer.event(`discover: ${byDeviceId.size} identified Devialet device(s)`);
    return [...byDeviceId.values()];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Poll-only feedback (unchanged cadence/mechanism from D2 — whether R1 offers a
   * real push channel is unconfirmed by the doc). Reads real system volume + real
   * group current-source state via the R1 client and projects them into Supreme
   * `media` state via `mediaStateFromDevialet()`. A `NoCurrentSource` logical error
   * (or any other failure) is tolerated silently per tick — real per-request
   * diagnostics still capture it (`tracked()`), matching D2's tolerance posture. */
  async poll(): Promise<void> {
    for (const b of this.bindings) {
      if (b.capability !== "media") continue;
      const endpoint = this.endpointFor(b);
      try {
        const [vol, current] = await Promise.all([
          this.tracked(b.host, "R1 GET volume", () => this.client.getVolume(endpoint)),
          this.tracked(b.host, "R1 GET current source", () => this.client.getCurrentSource(endpoint)),
        ]);
        this.record(b.deviceId, "media", mediaStateFromDevialet(current, vol.volume));
      } catch {
        // Tolerate transient errors (including a real, documented "NoCurrentSource"
        // logical error) — `tracked()` already recorded the failure into this
        // endpoint's own diagnostics tracker, so it remains visible to
        // getDiagnostics()/getTrace() even though poll() itself stays silent.
      }
    }
  }

  /** Records CONFIRMED state only — the one and only writer of `this.states`, reached
   * exclusively from `poll()` (D3) / a real feedback path (D9/D10), never from
   * `command()`. Delegates to the shared `recordCapabilityState()` helper. */
  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    recordCapabilityState(this.states, this.listeners, deviceId, capability, state);
  }
}

/** A best-effort fallback display name from the Bonjour instance name (the label
 * before the service type) — used ONLY when `device.deviceName` (the real,
 * installer-set name from `/devices/current`) is unavailable. Per the R1 doc's own
 * "Discovery" section: "the client application should not use the mDNS service name
 * for display purposes" long-term — this is a same-tick fallback only, never
 * persisted as if it were `deviceName`. Also strips the doc-documented `"-ipcontrol"`
 * suffix some firmware appends to the real service instance's own name. */
function instanceName(mdnsName: string): string | null {
  const label = mdnsName.split(`.${DEVIALET_MDNS_SERVICE.replace(/^\./, "")}`)[0];
  if (!label || label === mdnsName) return null;
  return label.replace(/\\032/g, " ").replace(/-ipcontrol$/, "");
}

/** Strips a `http(s)://` scheme and any port, for diagnostics `ip`/MAC lookup only —
 * never used for the actual HTTP transport (the client's own `baseUrl()` handles
 * that). Best-effort: falls back to the raw string on anything that doesn't parse as
 * a URL. */
function hostOnly(raw: string): string {
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      return new URL(raw).hostname;
    } catch {
      return raw;
    }
  }
  return raw.split(":")[0] ?? raw;
}

// Re-exported so callers/tests that only import from `devialet-driver.js` (the
// pre-Fusion module path) can still observe a real logical/HTTP/transport failure
// without a second import — the driver itself never needs to catch/rethrow either type.
export { DevialetApiError, DevialetCiSettingsError };
