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
  type MediaArtwork,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import {
  buildDevialetMediaState,
  hasPublishableDevialetMedia,
  reconcileDevialetCiSettings,
  type DevialetMediaCacheEntry,
  type DevialetCiSettingsReconciliation,
} from "./devialet-codec.js";
import {
  DevialetApiError,
  DevialetIpControlClient,
  type DevialetCurrentSource,
  type DevialetEndpoint,
} from "./devialet-ip-control-client.js";
import {
  DevialetCiSettingsClient,
  DevialetCiSettingsError,
  type DevialetCiSettingsEndpoint,
  type DevialetCiSettingsLeanState,
  type DevialetCiSettingsPowerState,
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
import {
  devialetCommandLevelFor,
  resolveDevialetCommandTarget,
  DevialetCommandRoutingError,
  DevialetOperationUnavailableError,
} from "./devialet-command-routing.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { createProtocolTracer, type ProtocolTracer } from "./av-sdk/protocol-tracer.js";
import { DriverDiagnosticsTracker, type DriverDiagnosticsSnapshot, type DriverTraceEntry } from "./driver-diagnostics.js";
import { bestEffortMacForIp } from "./arp-lookup.js";

/** Kept independent of `supreme-avr`'s own version counter — bumped when this driver's
 * own architecture/behavior changes materially. Surfaced in Diagnostics only. */
const DRIVER_VERSION = "11.0.0-fusion-d11";

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
  /**
   * § D11 — how often `poll()` opportunistically piggybacks a FULL `refreshTopology()`
   * sweep onto the existing media-poll timer (never a second `setInterval` — see
   * `poll()`'s own doc for the full cost/cadence justification). Default 60000 (60s):
   * a physical System/Group re-pair (Solo↔Stereo, a Group membership change) is a
   * rare, human-initiated action, not a per-second event like volume/track changes,
   * so a bounded ~1-minute worst-case detection latency is an acceptable trade
   * against request volume — 1/20th the rate of the default 3000ms media poll,
   * scaling linearly (one `/devices/current` per bound device, deduped
   * `/systems/current` per distinct systemId) with device count, never O(N²).
   */
  topologyRefreshMs?: number;
  /** § D8 — builds the gateway's own artwork-proxy URL for a device
   * (`/v1/devices/:id/media/artwork`), the SAME pattern `AvrProtocolDriver` already
   * uses. `MediaState.artworkUrl` only ever carries this proxy URL, never R1's raw
   * `coverArtUrl` directly. Absent (no artwork advertised) when the gateway has no
   * public base URL configured — matches AVR's own documented behavior exactly. */
  artworkUrlFor?: (deviceId: DeviceId) => string;
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
  /** § D7 patch — coalesces concurrent on-demand topology refreshes for the SAME
   * binding (see `ensureBindingTopology()`) onto one in-flight query. Instance-scoped
   * (a plain field, like every other piece of driver state) — never module-level. */
  private readonly inFlightTopologyRefresh = new Map<string, Promise<void>>();
  /** § D11 — coalesces concurrent FULL-sweep `refreshTopology()` calls (the periodic
   * piggyback below and any caller-invoked one landing at the same time) onto one
   * in-flight sweep, the same pattern `inFlightTopologyRefresh` already uses for a
   * single binding. Never module-level. */
  private inFlightFullTopologyRefresh: Promise<DevialetTopologyChangeResult> | null = null;
  /** § D11 — `Date.now()` of the last full topology sweep (periodic or manual),
   * driving the piggyback cadence in `poll()`. `0` means "never" — the first poll
   * always sweeps once bindings exist, establishing topology promptly at startup. */
  private lastTopologyRefreshAt = 0;
  /** § D8 — one physical device's last-known REAL media context, populated by
   * `poll()`'s media refresh. `coverArtUrl` is R1's own raw URL (never the gateway
   * proxy URL `MediaState.artworkUrl` advertises) — retained here specifically so
   * `getArtwork()` can fetch real bytes later without re-querying R1 on every call.
   * `groupId`/`sourceHostDeviceId` are kept for future phases (§23/§24 of the D8
   * brief) — not exposed through the generic domain model. Instance-scoped, cleared
   * per-device in `unbind()`, exactly like every other per-device map on this driver. */
  private readonly mediaProjections = new Map<
    DeviceId,
    { groupId: string; sourceHostDeviceId: string | null; coverArtUrl: string | null }
  >();
  /** § D8 final fix — persistent, per-device, INCREMENTAL media cache, mirroring
   * `AvrProtocolDriver`'s own `MediaCache`/`patchMedia()` precedent exactly (see
   * `devialet-codec.ts`'s module doc for the detailed rationale). System-level volume
   * and group-level playback/metadata are two independent R1 queries that can each
   * succeed or fail on any given `refreshMediaState()` tick; whichever half succeeds
   * patches this cache, and the merged result is published whenever
   * `hasPublishableDevialetMedia()` says enough real data exists — never gated on
   * BOTH halves succeeding in lockstep. Instance-scoped, cleared per-device in
   * `unbind()`, exactly like `mediaProjections`. */
  private readonly mediaCache = new Map<DeviceId, DevialetMediaCacheEntry>();
  /** § D8 — coalesces concurrent `getArtwork()` fetches for the SAME raw R1 URL
   * (§12/§13 of the brief: two physical devices sharing one Group's artwork must
   * never trigger two independent downloads). Keyed by the raw URL, not by device —
   * instance-scoped, not a second cache (no TTL/eviction; the gateway's own
   * `ArtworkCache` still owns per-device caching/TTL above this driver — see the D8
   * report for the documented boundary between the two). */
  private readonly artworkInFlight = new Map<string, Promise<MediaArtwork | null>>();
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DevialetDriverOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
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

  /** § D10 — idempotent: a repeat `connect()` (e.g. a caller reconnecting without an
   * intervening `disconnect()`) clears any existing poll timer FIRST rather than just
   * overwriting `this.timer`'s reference — otherwise the previous `setInterval` would
   * leak forever (never reachable to `clearInterval` again), producing duplicate
   * polling for as long as the process runs (§ D10 resource/concurrency safety). */
  async connect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // § D11 — baseline the periodic topology-piggyback clock at connect() time so the
    // very first poll() doesn't immediately re-sweep topology right after
    // `refreshMediaState()`'s own on-demand `ensureBindingTopology()` already
    // resolved it for a freshly-bound device (§ D8/AH's "exactly one on-demand
    // identity query" behavior stays exactly one) — the piggyback's job is
    // detecting DRIFT after topology is already known, not duplicating first
    // resolution.
    this.lastTopologyRefreshAt = Date.now();
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
    this.mediaProjections.delete(deviceId);
    this.mediaCache.delete(deviceId);
    // § D6 — a genuine unbind (this Supreme device is gone, not a transient query
    // failure) removes it from topology entirely, so it doesn't linger as a "last
    // known" system/group member forever. Distinct from a failed refreshTopology()
    // query, which deliberately KEEPS the last-known entry (see devialet-topology.ts).
    for (const b of removed) {
      if (b.devialetId) this.notifyTopologyChange(this.topology.remove(b.devialetId));
    }
  }

  /**
   * § D7 — Writes a command to the device via the real R1 client, topology-aware.
   * Deliberately does NOT write to `this.states`/call `recordCapabilityState()` —
   * confirmed state only ever flows through `poll()` (D9/D10 will formalize this as
   * real command confirmation). An accepted request here means "the device accepted
   * the request," never "the state is now this" — see
   * `DevialetIpControlClient.pause()`'s doc for the concrete reason this matters
   * (optical-input pause mutes instead of pausing).
   *
   * Every action is classified by `devialetCommandLevelFor()` into "system"
   * (volume) or "group" (playback/mute/source) per the R1 doc, and
   * `resolveDevialetCommandTarget()` confirms the REQUIRED level is actually known
   * in this device's current topology before anything is sent — throwing a
   * structured `DevialetCommandRoutingError` (never silently guessing) when it
   * isn't. The resolved `systemId`/`groupId` is used ONLY for tracing — every real
   * R1 request still addresses the literal `"current"` (see
   * `devialet-command-routing.ts`'s module doc for why: R1 accepts no other value
   * today, and always sends to `b.host`, the SAME device the command was invoked
   * against — there is no fan-out to other system/group members to begin with, so
   * no risk of duplicating a command across stereo members).
   */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error(`devialet: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`devialet: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media") throw new Error(`devialet: unsupported command for ${command.capability}`);
    this.tracer.event(`command requested ${deviceId} action=${command.action} devialetId=${b.devialetId ?? "unknown"}`);

    const level = devialetCommandLevelFor(command.action);
    if (level === "unsupported") {
      this.tracer.event(`command unsupported: ${command.action}`);
      throw new Error(`devialet: unsupported command for media (${command.action})`);
    }

    let topology = b.devialetId ? (this.topology.get().devices[b.devialetId] ?? null) : null;
    let routing = resolveDevialetCommandTarget(level, b.devialetId, topology);
    if (!routing.ok) {
      // § D7 patch — the real SupremeOS call path (gateway → SIL → adapter →
      // driver.command()) never invokes `refreshTopology()` automatically; nothing
      // outside this driver knows it exists (verified directly against
      // `installer-context.ts`/`native-adapter.ts`/`sil.ts` — see the D7 patch
      // report). Rather than requiring an external caller to remember to call it,
      // perform exactly ONE on-demand, single-binding topology resolution here —
      // never a retry loop, never more than one attempt — then re-resolve. This
      // mirrors `AvrProtocolDriver.bind()`'s own precedent of a driver performing
      // its own protocol readiness work rather than depending on an external
      // caller, adapted for Devialet's stronger requirement (routing, not just
      // display data, depends on it).
      this.tracer.event(`command target unknown, attempting one on-demand topology refresh: level=${level} reason=${routing.reason} devialetId=${b.devialetId ?? "unknown"}`);
      await this.ensureBindingTopology(b);
      topology = b.devialetId ? (this.topology.get().devices[b.devialetId] ?? null) : null;
      routing = resolveDevialetCommandTarget(level, b.devialetId, topology);
    }
    if (!routing.ok) {
      // Still unresolved after the one on-demand attempt (identity genuinely
      // unreachable, or R1 genuinely doesn't report the required system/group for
      // this device) — throw the same structured error D7 already defined. Never
      // fabricated: `resolveDevialetCommandTarget()` itself is untouched.
      this.tracer.event(`command target resolution failed: level=${level} reason=${routing.reason} devialetId=${b.devialetId ?? "unknown"}`);
      throw new DevialetCommandRoutingError(level, routing.reason, deviceId);
    }
    this.tracer.event(`command target resolved: level=${level} targetId=${routing.targetId} devialetId=${routing.devialetId} systemId=${topology?.systemId ?? "unknown"} groupId=${topology?.groupId ?? "unknown"}`);

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
        // pre-Fusion driver's own choice. Pause is documented as ALWAYS available
        // ("All sources support the 'Pause' command") — no availableOperations gate.
        await this.tracked(b.host, "R1 POST pause", () => this.client.pause(endpoint));
        return;
      case "next": {
        // § D7/§9 — "next"/"previous" are the only playback actions the R1 doc
        // documents as conditionally unavailable via `availableOperations`
        // (everything else either always works or fails with its own distinct
        // logical error — see `devialet-command-routing.ts`). Checked with a fresh
        // read rather than trusting a stale `poll()` snapshot.
        const current = await this.tracked(b.host, "R1 GET current source (for next)", () => this.client.getCurrentSource(endpoint));
        if (!current.availableOperations.includes("next")) {
          this.tracer.event(`command unsupported: next not in current availableOperations`);
          throw new DevialetOperationUnavailableError("next", deviceId);
        }
        await this.tracked(b.host, "R1 POST next", () => this.client.next(endpoint));
        return;
      }
      case "previous": {
        const current = await this.tracked(b.host, "R1 GET current source (for previous)", () => this.client.getCurrentSource(endpoint));
        if (!current.availableOperations.includes("previous")) {
          this.tracer.event(`command unsupported: previous not in current availableOperations`);
          throw new DevialetOperationUnavailableError("previous", deviceId);
        }
        await this.tracked(b.host, "R1 POST previous", () => this.client.previous(endpoint));
        return;
      }
      case "mute":
        // § D7/§10 — mute/unmute are documented as ALWAYS available and
        // deliberately excluded from availableOperations — never gated on it.
        await this.tracked(b.host, "R1 POST mute", () => this.client.mute(endpoint));
        return;
      case "unmute":
        await this.tracked(b.host, "R1 POST unmute", () => this.client.unmute(endpoint));
        return;
      case "volume":
        if (typeof command.volume !== "number") throw new Error(`devialet: volume command missing a numeric volume`);
        await this.tracked(b.host, "R1 POST volume", () => this.client.setVolume(endpoint, command.volume as number));
        return;
      case "source": {
        // § D7/§7 — source selection has no dedicated R1 endpoint; the doc's own
        // "play" semantics ARE source selection ("If the designated source is not
        // the current source of the group, it will be selected first"). Matches
        // `command.source` against the current GROUP's real source list by `type`
        // (the doc's own closed, documented vocabulary — "spotifyconnect",
        // "optical", …) — never a fabricated/guessed sourceId.
        if (typeof command.source !== "string") throw new Error(`devialet: source command missing a source identifier`);
        const sources = await this.tracked(b.host, "R1 GET group sources (for source select)", () => this.client.getGroupSources(endpoint));
        const match = sources.sources.find((s) => s.type === command.source);
        if (!match) throw new Error(`devialet: ${deviceId} — no current-group source matches "${command.source}"`);
        await this.tracked(b.host, "R1 POST play (source select)", () => this.client.play(endpoint, match.sourceId));
        return;
      }
      default:
        // Unreachable — devialetCommandLevelFor() already classified every other
        // action as "unsupported" above. Kept for exhaustiveness/type-safety only.
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
    // § D11 — coalesce concurrent full-sweep callers (the periodic `poll()` piggyback
    // and any caller-invoked refresh landing at the same time) onto ONE in-flight
    // sweep, exactly like `ensureBindingTopology()` already does for a single
    // binding — never two overlapping full sweeps issuing duplicate requests.
    if (this.inFlightFullTopologyRefresh) return this.inFlightFullTopologyRefresh;
    const promise = this.runTopologyRefresh().finally(() => {
      this.inFlightFullTopologyRefresh = null;
    });
    this.inFlightFullTopologyRefresh = promise;
    return promise;
  }

  private async runTopologyRefresh(): Promise<DevialetTopologyChangeResult> {
    this.tracer.event("topology: refresh started");
    const mediaBindings = this.bindings.filter((b) => b.capability === "media");
    const systemNames = new Map<string, string | null>();
    const fresh: DevialetFreshDeviceTopology[] = [];
    for (const b of mediaBindings) {
      const entry = await this.resolveDeviceTopology(b, systemNames);
      if (entry) fresh.push(entry);
    }
    const result = this.notifyTopologyChange(this.topology.merge(fresh));
    this.lastTopologyRefreshAt = Date.now();
    this.tracer.event(result.changed ? "topology: changed" : "topology: unchanged");
    return result;
  }

  /**
   * § D7 patch — the reusable per-binding query logic `refreshTopology()`'s loop and
   * `ensureBindingTopology()`'s on-demand single-device path both call, so there is
   * exactly ONE implementation of "ask R1 what this device's topology is" (§2/§3 of
   * the patch brief — no second topology implementation). Queries `GET /devices/
   * current` (establishing/confirming `devialetId`), then, for a not-yet-cached
   * `systemId`, one best-effort `GET /systems/current` for its display name (the
   * caller supplies/owns `systemNames` so a full `refreshTopology()` sweep still
   * dedupes across every binding sharing a system — unchanged from D6). Returns
   * `null` (never throws) on a failed device query — the caller decides what that
   * means: `refreshTopology()` simply omits it (last-known topology preserved by the
   * registry's own merge rule); `ensureBindingTopology()` treats it as "still
   * unresolved," which surfaces as the existing `DevialetCommandRoutingError`.
   */
  private async resolveDeviceTopology(b: DevialetBinding, systemNames: Map<string, string | null>): Promise<DevialetFreshDeviceTopology | null> {
    const endpoint = this.endpointFor(b);
    let info;
    try {
      info = await this.tracked(b.host, "R1 GET devices/current (topology)", () => this.client.getDevice(endpoint));
    } catch (err) {
      this.tracer.event(`topology: device query failed for ${b.deviceId} — ${err instanceof Error ? err.message : String(err)} (keeping last-known topology)`);
      return null;
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
    this.tracer.event(`topology: device ${info.deviceId} system=${systemId ?? "none"} group=${info.groupId ?? "none"} role=${info.role ?? "none"}`);
    return {
      deviceId: info.deviceId,
      supremeDeviceId: b.deviceId,
      host: b.host,
      systemId,
      groupId: info.groupId ?? null,
      role: info.role ?? null,
      systemName: systemId ? systemNames.get(systemId) : undefined,
    };
  }

  /**
   * § D7 patch — on-demand, single-binding topology resolution, used ONLY by
   * `command()` when routing target resolution fails (see `command()`'s doc). Merges
   * its one observation into the SAME `DevialetTopologyRegistry` `refreshTopology()`
   * uses — not a second topology mechanism. Concurrent calls for the SAME binding
   * (e.g. two commands issued back-to-back before either resolves) coalesce onto one
   * in-flight query via `inFlightTopologyRefresh`, keyed by `bindingKey()` — never a
   * second real R1 query for the same binding at the same time. If the device was
   * unbound while this refresh was in flight, its result is discarded rather than
   * resurrecting a topology entry for a device this driver no longer manages.
   */
  private async ensureBindingTopology(b: DevialetBinding): Promise<void> {
    const key = bindingKey(b.deviceId, b.capability);
    const existing = this.inFlightTopologyRefresh.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const entry = await this.resolveDeviceTopology(b, new Map());
      if (entry && this.bindings.includes(b)) {
        this.notifyTopologyChange(this.topology.merge([entry]));
      }
    })().finally(() => {
      this.inFlightTopologyRefresh.delete(key);
    });
    this.inFlightTopologyRefresh.set(key, promise);
    return promise;
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

  /**
   * § D9 — CISettings `powerstate`, kept STRICTLY diagnostic (see `devialet-codec.ts`'s
   * precedence matrix). R1 has no power/on-off endpoint at all, so there is nothing
   * for this to conflict with, but the 4-value semantics (`standby`/`starting`/
   * `running`/`stopping`) do not collapse losslessly onto SupremeOS's boolean `onoff`
   * capability, and the write-side `power` opcode has no confirmed read-back — so this
   * is deliberately NEVER written into `this.states` and NEVER bound to a capability.
   * Same posture as `getCiSettingsLean()`/`getCiSettingsInternalState()`: on-demand,
   * enrichment-only, propagates a real `DevialetCiSettingsError` for a managed device.
   */
  async getCiSettingsPowerState(deviceId: DeviceId): Promise<DevialetCiSettingsPowerState | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.tracked(b.host, "CISettings GET powerstate", () => this.ciSettings.getPowerState(this.ciSettingsEndpointFor(b)));
  }

  /**
   * § D9 — diagnostic-only comparison between R1's already-published media state and
   * CISettings' own independently-fetched volume/mute/source. NEVER writes to
   * `this.states`/`mediaCache` — R1 remains authoritative regardless of what this
   * returns (see the precedence matrix in `devialet-codec.ts`). Each CISettings field
   * is fetched independently (`Promise.allSettled`) so one field's transport/HTTP/
   * malformed failure never blocks reporting the others (§ D9-G failure isolation) —
   * a failed field simply reports `ciSettingsValue: null` for that row. Returns `null`
   * only for an unmanaged device, matching every other lookup method on this driver.
   */
  async getCiSettingsReconciliation(deviceId: DeviceId): Promise<DevialetCiSettingsReconciliation[] | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const endpoint = this.ciSettingsEndpointFor(b);
    const [volume, muted, source] = await Promise.allSettled([
      this.tracked(b.host, "CISettings GET volume", () => this.ciSettings.getVolume(endpoint)),
      this.tracked(b.host, "CISettings GET mutemode", () => this.ciSettings.getMuteMode(endpoint)),
      this.tracked(b.host, "CISettings GET source", () => this.ciSettings.getSource(endpoint)),
    ]);
    const cached = this.mediaCache.get(deviceId);
    return reconcileDevialetCiSettings(
      {
        volume: cached?.volume ?? null,
        muted: cached?.muted ?? null,
        source: cached?.source ?? null,
      },
      {
        volume: volume.status === "fulfilled" ? volume.value : null,
        muted: muted.status === "fulfilled" ? muted.value : null,
        source: source.status === "fulfilled" ? source.value : null,
      },
    );
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

  /**
   * Poll-only feedback (unchanged cadence/mechanism from D2 — whether R1 offers a
   * real push channel is unconfirmed by the doc). Delegates to `refreshMediaState()`
   * (§ D8) — kept as a separate method rather than inlined here per §21 of the D8
   * brief ("do not combine this with command execution"; also keeps `poll()` a
   * stable, minimal lifecycle hook `connect()`'s timer calls, unchanged in shape
   * since D2).
   *
   * § D11 — dynamic topology detection. Neither R1 request `refreshMediaState()`
   * already issues (`GET .../soundControl/volume`, `GET .../sources/current`) returns
   * a `systemId`/`groupId` field at all — only `GET /devices/current` and `GET
   * /systems/current` do (§ D3/D6 report), and `refreshMediaState()` only calls those
   * (via `ensureBindingTopology()`) when a binding's cached topology is UNKNOWN
   * (`null`), never merely possibly-stale. So a device that stays reachable while its
   * real System/Group membership changes (a Solo↔Stereo re-pair, a Group reshuffle)
   * would otherwise never have that change detected — confirmed by tracing the actual
   * call graph, not assumed (Option A from the D11 brief: reusing the existing R1
   * calls verbatim is NOT sufficient, since they carry no topology fields).
   *
   * Rather than a second `setInterval` (explicitly disallowed), this piggybacks a
   * full `refreshTopology()` sweep onto the SAME timer tick `connect()` already
   * drives, gated by `topologyRefreshMs` (default 60s) so it runs far less often than
   * the media half of every tick — see `DevialetDriverOptions.topologyRefreshMs`'s
   * doc for the cadence/cost justification. `refreshTopology()`'s own coalescing
   * (`inFlightFullTopologyRefresh`) means an overlapping manual caller never causes a
   * duplicate sweep.
   */
  async poll(): Promise<void> {
    await this.refreshMediaState();
    const period = this.opts.topologyRefreshMs ?? 60_000;
    if (this.bindings.length > 0 && Date.now() - this.lastTopologyRefreshAt >= period) {
      await this.refreshTopology();
    }
  }

  /**
   * § D8 final fix — Group-projected, INCREMENTALLY-merged media state refresh.
   * R1's current-source/media response is dispatcher-relative (§ D7's
   * `devialet-command-routing.ts` doc) — querying ANY member device's own host for
   * `/groups/current/sources/current` already returns that Group's real, shared
   * media state, so this method queries each DISTINCT `groupId` (and, for volume,
   * each DISTINCT `systemId`) at most ONCE per refresh pass and projects the single
   * result onto every bound device that currently belongs to it (§4/§22/§38) — never
   * N redundant identical requests for N devices sharing one Group/System. This
   * dedup logic is UNCHANGED from the original D8 pass.
   *
   * What changed: system-level volume and group-level playback/metadata are two
   * INDEPENDENT queries, and this method now treats them that way — whichever half
   * succeeds patches `mediaCache` (a persistent, per-device, incremental cache; see
   * `devialet-codec.ts`'s module doc for the full rationale and its direct
   * comparison to `AvrProtocolDriver`'s own `MediaCache`), and the merged result is
   * published whenever `hasPublishableDevialetMedia()` says enough REAL data exists
   * — never gated on both halves succeeding in the same tick. A failed half simply
   * leaves that half of the cache untouched; nothing is ever erased or fabricated.
   * If NEITHER half succeeds this tick, nothing changed, so nothing is re-published
   * (the existing `this.states` entry, if any, is left exactly as it was).
   *
   * A device whose System OR Group isn't yet known in the current topology snapshot
   * is skipped entirely for this tick (§17/§18: never fabricate group/system
   * membership) — this is a topology-availability gate, unrelated to the
   * volume/media independence described above.
   *
   * Retains each device's raw `coverArtUrl` in `mediaProjections` for `getArtwork()`
   * whenever the group half succeeds (independent of whether the tick as a whole
   * was publishable) — never published to `this.states` itself (`MediaState.
   * artworkUrl` only ever carries the gateway's proxy URL, built via
   * `artworkUrlFor`, never R1's raw URL). Artwork mechanics themselves are
   * completely unchanged from the original D8 pass.
   */
  private async refreshMediaState(): Promise<void> {
    this.tracer.event("media: refresh started");
    const mediaBindings = this.bindings.filter((b) => b.capability === "media");
    const volumeBySystem = new Map<string, Promise<{ volume: number } | null>>();
    // § D10 — "no source" is a REAL, confirmed R1 answer (the `NoCurrentSource`
    // logical error, per the R1 doc's own Error Handling section), distinct from a
    // transport/HTTP failure. The literal `"no-source"` sentinel lets the merge logic
    // below tell "the group genuinely has nothing playing right now" (clear the
    // cache to an honest idle state) apart from "this query failed, we don't know
    // anything new" (preserve whatever was cached before) — conflating the two would
    // either fabricate a real answer as a mere hiccup, or leave stale playback/title/
    // artwork behind indefinitely after the group's source was genuinely cleared.
    const mediaByGroup = new Map<string, Promise<DevialetCurrentSource | null | "no-source">>();

    for (const b of mediaBindings) {
      let topology = b.devialetId ? (this.topology.get().devices[b.devialetId] ?? null) : null;
      if (!topology?.systemId || !topology.groupId) {
        // § D8/AH — the real SupremeOS lifecycle never calls `refreshTopology()`
        // automatically (same gap the D7 patch closed for `command()`); `poll()`'s
        // timer fires on its own once `connect()` runs, so media would otherwise
        // never populate for a freshly-bound device. Reuses the SAME
        // `ensureBindingTopology()` on-demand helper `command()` already uses — one
        // attempt, coalesced, never a new mechanism/timer.
        await this.ensureBindingTopology(b);
        topology = b.devialetId ? (this.topology.get().devices[b.devialetId] ?? null) : null;
      }
      if (!topology?.systemId || !topology.groupId) {
        this.tracer.event(`media: topology unknown for ${b.deviceId} (system=${topology?.systemId ?? "unknown"} group=${topology?.groupId ?? "unknown"}) — media state unavailable`);
        continue;
      }
      const endpoint = this.endpointFor(b);
      const systemId = topology.systemId;
      const groupId = topology.groupId;

      if (!volumeBySystem.has(systemId)) {
        this.tracer.event(`media: querying volume once for system ${systemId}`);
        volumeBySystem.set(
          systemId,
          this.tracked(b.host, "R1 GET volume", () => this.client.getVolume(endpoint)).catch((err) => {
            this.tracer.event(`media: volume query failed for system ${systemId} — ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }),
        );
      }
      const vol = await volumeBySystem.get(systemId)!;

      if (!mediaByGroup.has(groupId)) {
        this.tracer.event(`media: querying group ${groupId} once`);
        mediaByGroup.set(
          groupId,
          this.tracked(b.host, "R1 GET current source", () => this.client.getCurrentSource(endpoint)).catch((err) => {
            if (err instanceof DevialetApiError && err.kind === "logical" && err.logical?.code === "NoCurrentSource") {
              this.tracer.event(`media: group ${groupId} reports NoCurrentSource — clearing to idle (real, confirmed answer, not a failure)`);
              return "no-source" as const;
            }
            this.tracer.event(`media: group query failed for group ${groupId} — ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }),
        );
      }
      const current = await mediaByGroup.get(groupId)!;

      if (vol === null && current === null) {
        // Nothing new this tick — the existing cache/published state (if any)
        // already reflects the last real data observed; no republish needed.
        continue;
      }

      const prior = this.mediaCache.get(b.deviceId) ?? {};
      const merged: DevialetMediaCacheEntry = { ...prior };
      if (vol !== null) {
        merged.volume = vol.volume;
      }
      if (current === "no-source") {
        // § D10 — a confirmed "nothing playing" answer, not stale/unknown data.
        // `muted` has no real R1 value to report here (no current source), and the
        // least-fabricating honest default is `false` — never carried over from
        // whatever the LAST active source happened to report.
        merged.muted = false;
        merged.playback = "idle";
        merged.title = null;
        merged.artist = null;
        merged.album = null;
        merged.source = null;
        merged.availableOperations = [];
        this.mediaProjections.delete(b.deviceId);
      } else if (current !== null) {
        merged.muted = current.muteState === "muted";
        merged.playback = current.playingState;
        merged.title = current.metadata?.title ?? null;
        merged.artist = current.metadata?.artist ?? null;
        merged.album = current.metadata?.album ?? null;
        merged.source = current.source?.type ?? null;
        merged.availableOperations = current.availableOperations;
        const coverArtUrl = current.metadata?.coverArtUrl ?? null;
        this.mediaProjections.set(b.deviceId, { groupId, sourceHostDeviceId: current.source?.deviceId ?? null, coverArtUrl });
      }
      this.mediaCache.set(b.deviceId, merged);

      if (!hasPublishableDevialetMedia(merged)) {
        // One half is real and cached, but the OTHER has never been observed even
        // once — volume/playback/muted have no honest "unknown" schema
        // representation, so there is genuinely nothing valid to publish yet. Real
        // data for this half is still saved above; the next successful tick for the
        // other half will complete it.
        this.tracer.event(`media: partial data cached for ${b.deviceId} — not yet publishable (volume=${merged.volume !== undefined} playback=${merged.playback !== undefined})`);
        continue;
      }

      const artworkUrl = this.opts.artworkUrlFor ? this.opts.artworkUrlFor(b.deviceId) : null;
      this.tracer.event(`media: state for ${b.deviceId} group=${groupId} playback=${merged.playback} mute=${merged.muted}${vol !== null ? " volume=fresh" : " volume=cached"}${current !== null ? " media=fresh" : " media=cached"}`);
      this.record(b.deviceId, "media", buildDevialetMediaState(merged, artworkUrl));
    }
  }

  /**
   * § D8 — real album art bytes, fetched from R1's own raw `coverArtUrl` (retained in
   * `mediaProjections` by `refreshMediaState()`), matching `AvrProtocolDriver.
   * getArtwork()`'s exact shape (`MediaArtwork | null`, never fabricated). `null`
   * when this device has no known media projection yet, or the current track/source
   * reports no `coverArtUrl` at all. Never fetched eagerly during `poll()` — only on
   * an actual caller request, per §13 of the D8 brief.
   */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    const url = this.mediaProjections.get(deviceId)?.coverArtUrl;
    if (!url) return null;
    return this.fetchArtwork(url);
  }

  /** § D8 — coalesces concurrent fetches of the SAME raw artwork URL (§12/§15: two
   * physical devices sharing one Group's `coverArtUrl` must trigger exactly one real
   * download, never two) via `artworkInFlight`, keyed by URL — not device. This is
   * NOT a second cache layer competing with the gateway's own device-keyed
   * `ArtworkCache` (`services/gateway/src/artwork-cache.ts`, untouched by D8 — see
   * the D8 report for why modifying it was out of scope): it only coalesces
   * concurrent in-flight requests within this driver instance, the same pattern
   * `HttpPollClient`/`DevialetIpControlClient`-adjacent code already uses elsewhere
   * in this fleet for request coalescing. */
  private async fetchArtwork(url: string): Promise<MediaArtwork | null> {
    const existing = this.artworkInFlight.get(url);
    if (existing) {
      this.tracer.event(`media: artwork request coalesced (already in flight) for ${url}`);
      return existing;
    }
    this.tracer.event(`media: artwork fetch started for ${url}`);
    const promise = (async (): Promise<MediaArtwork | null> => {
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) {
          this.tracer.event(`media: artwork fetch failed for ${url} — HTTP ${res.status}`);
          return null;
        }
        const contentType = res.headers.get("content-type") ?? "image/jpeg";
        const data = new Uint8Array(await res.arrayBuffer());
        this.tracer.event(`media: artwork fetch succeeded for ${url}`);
        return { contentType, data };
      } catch (err) {
        this.tracer.event(`media: artwork fetch failed for ${url} — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })().finally(() => {
      this.artworkInFlight.delete(url);
    });
    this.artworkInFlight.set(url, promise);
    return promise;
  }

  /** Records CONFIRMED state only — the one and only writer of `this.states`, reached
   * exclusively from `poll()`/`refreshMediaState()` (D3/D8) / a real feedback path
   * (D9/D10), never from `command()`. Delegates to the shared
   * `recordCapabilityState()` helper. */
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
// pre-Fusion module path) can still observe a real logical/HTTP/transport/routing
// failure without a second import — the driver itself never needs to catch/rethrow
// any of these types.
export { DevialetApiError, DevialetCiSettingsError, DevialetCommandRoutingError, DevialetOperationUnavailableError };
