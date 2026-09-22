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
import { mdnsBrowse, type MdnsService } from "./mdns.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
// § Phase 3 — reuses the TV SDK's ALREADY-GENERIC app-registry/foreground-app shapes
// (built for Android TV/Google TV/Fire OS) rather than inventing a parallel Apple-TV-
// specific application model. `packageName` is TvAppRegistryEntry's field name for
// "the platform's stable app identifier" — for Apple TV that's the bundle identifier;
// the field is reused as-is, not renamed, so a future cross-platform app-registry
// consumer doesn't need to branch on which kind of device it's looking at.
import type { TvAppRegistryEntry, TvForegroundApp } from "./tv-sdk/tv-types.js";

/**
 * Apple TV driver — Phase 1 rebuild (multi-instance core: registration, discovery,
 * stable identity, connection lifecycle, media capability). See the accompanying
 * architecture note in this file's own history for the full spec; this Phase 1 slice
 * deliberately does NOT yet implement: persistent pairing-credential storage (the
 * `connect()` seam receives an address only, same as before — a real pairing-aware
 * client is injected by a later phase), application discovery/launch, keyboard input,
 * or deep links. None of those exist in the Supreme capability vocabulary yet either
 * (§ "never fabricate a capability" — CLAUDE.md) — adding them is explicitly deferred
 * to a follow-up phase that also touches the domain model, not silently invented here.
 *
 * MULTI-INSTANCE BY CONSTRUCTION: exactly the same shape every other driver in this
 * codebase uses (KNX, CoolMaster, Matter, AVR, …) — `bindings: Array` + `devices: Set`,
 * one entry per physical device, never a singleton. `bind()`/`unbind()`/`command()` all
 * take a `deviceId` and only ever touch that one binding's own state/client/timer — a
 * failure or reconnect loop on one Apple TV can never observably affect another (see the
 * isolation tests in apple-tv-driver.test.ts).
 *
 * ROOM/SPACE ASSIGNMENT: intentionally NOT modeled here at all. `Device.roomId`
 * (`services/home/src/home-service.ts`) is a plain field on the generic Device record
 * with no uniqueness constraint — multiple devices (including multiple Apple TVs) can
 * already legitimately share one room today, and this driver never needs to know which
 * room a device is in. This is the existing, protocol-agnostic mechanism; no
 * Apple-TV-specific room database was created.
 *
 * STABLE IDENTITY / IP-CHANGE RECONCILIATION: `discover()`'s `backendId` is the mDNS
 * service INSTANCE NAME (stable across a DHCP renewal — the address, not the name,
 * changes), never the raw host/IP. This is honestly a "persistent discovery identifier"
 * (tier 3 of the spec's preferred-identity order), not a real Apple TV hardware
 * identifier (tier 1) — no canonical, verified source for extracting one from this
 * service's TXT records was available this phase, so nothing was fabricated. Because
 * `backendId` is stable, the EXISTING, already-tested, protocol-agnostic reconciliation
 * primitives already in this codebase — `SupremeIntegrationLayerRegistry.isKnownBackendId()`
 * (rediscovery of an already-configured device is recognized, never duplicated) and
 * `DriverBindingEngine.rebind()` (re-binds a known device onto a new address while
 * keeping its deviceId/name/room/automations untouched) — are sufficient; this driver
 * does not need, and does not implement, a second reconciliation mechanism.
 *
 * CONNECTION LIFECYCLE: each binding independently tracks one of the six states the
 * spec requires (`AppleTvConnectionState`) and reconnects with exponential backoff,
 * capped, on its own timer — never a shared/global timer, never a singleton client.
 */
const APPLE_TV_SERVICE = "_mediaremotetv._tcp.local";

/** The six connection states every Apple TV driver instance independently tracks. */
export type AppleTvConnectionState =
  | "disconnected"
  | "connecting"
  | "pairing_required"
  | "connected"
  | "reconnecting"
  | "error";

/** A client throws this (instead of a generic Error) when the Apple TV requires MRP/
 * Companion pairing before it will accept a connection — the driver recognizes this
 * specifically and moves the binding to `"pairing_required"` rather than endlessly
 * retrying a connection that can never succeed without user action. */
export class AppleTvPairingRequiredError extends Error {
  constructor(message = "Apple TV requires pairing") {
    super(message);
    this.name = "AppleTvPairingRequiredError";
  }
}

/** A snapshot of what the Apple TV is doing, as reported by the MRP/Companion client. */
export interface AppleTvNowPlaying {
  /** Transport state of the focused app. */
  state: "playing" | "paused" | "stopped" | "idle";
  /** Foreground app's display name, e.g. "Netflix" / "Apple TV" / "Music"; null if unknown. */
  app: string | null;
  /** Title of the current content (movie / show+episode / track); null when nothing plays. */
  title: string | null;
  /** Secondary line — artist for music, or show/series name for video; null if N/A. */
  artist: string | null;
  /** Artwork URL the clients can render (must be a URL or null — raw bytes aren't passed up). */
  artworkUrl: string | null;
  /** Output volume 0..100; null when this Apple TV does not own audio output (e.g. audio
   * is routed through an AVR/TV via HDMI-CEC/ARC — § "do not falsely report Apple TV as
   * the volume owner", never fabricated as 0 or 100 in that case). */
  volume: number | null;
  /** Whether output is muted; null under the same "not the volume owner" condition. */
  muted: boolean | null;
  /** Track duration/elapsed position in seconds; null when the source doesn't report
   * them (live content) or the device hasn't reported them yet — mirrors
   * `MediaState.durationSec`/`positionSec` exactly, never a device-specific field. */
  durationSec?: number | null;
  positionSec?: number | null;
  /** True when the device has cover art available (fetched out-of-band via getArtwork). */
  hasArtwork?: boolean;
}

/** The 8 directional/menu buttons the generic `remote` capability commands
 * (`packages/domain-model/src/capabilities.ts`). */
export type AppleTvRemoteButton = "up" | "down" | "left" | "right" | "select" | "back" | "menu" | "home";

/** Control + state seam for one Apple TV. A real implementation wraps a pyatv-backed
 * (or equivalent) MRP/Companion client carrying that device's own stored pairing
 * credentials — never a shared/global client across instances. */
export interface AppleTvClient {
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Set output volume (0..100). Only called when this Apple TV genuinely owns audio
   * output — callers must not invoke this for a device whose `nowPlaying().volume` is
   * `null`. */
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** Press one directional/menu button (§ Phase 2C `remote` capability). Rejects with a
   * descriptive error for a button this client's protocol/device genuinely cannot send
   * — never silently no-ops a button that looks supported but isn't wired. */
  pressButton(button: AppleTvRemoteButton): Promise<void>;
  /** Current foreground app + content + transport. */
  nowPlaying(): Promise<AppleTvNowPlaying>;
  /** Optional: current cover-art bytes (null if none). */
  getArtwork?(): Promise<MediaArtwork | null>;
  /** § Phase 3 — current foreground app, from real MRP `playerPath.client` feedback
   * (never inferred from the last command sent). `null` when the Apple TV hasn't
   * reported one yet. Available on every MRP-paired client — no Companion needed. */
  getCurrentApplication?(): Promise<TvForegroundApp | null>;
  /** § Phase 3 — installed/launchable app list. Optional: only present when this
   * client also has a paired Companion session (MRP alone cannot enumerate apps —
   * verified against pyatv: `Apps` is implemented only by `CompanionApps`, MRP has no
   * app-list message at all). Absent (not just empty) when Companion isn't paired —
   * callers must distinguish "no Companion" from "Companion says zero apps". */
  getApplications?(): Promise<TvAppRegistryEntry[]>;
  /** § Phase 3 — launch by stable bundle identifier (verified Companion `_launchApp`
   * with `_bundleID`). Resolves once the COMMAND was accepted by the protocol — this is
   * NOT a guarantee the app finished starting; real "it's running" confirmation is
   * `getCurrentApplication()`/the next `playerPath.client` event, never inferred here. */
  launchApplication?(bundleIdentifier: string): Promise<void>;
  /** § Phase 3 — launch a URL/URL-scheme deep link (verified Companion `_launchApp`
   * with `_urlS` — the SAME command as `launchApplication`, just a URL instead of a
   * bundle id; tvOS itself decides whether that URL/scheme is meaningful; this method
   * only reports whether the COMMAND was accepted, never fabricates content-level
   * success). */
  launchDeepLink?(urlOrScheme: string): Promise<void>;
  /** Optional: release whatever the real MRP/pairing stack holds for this Apple TV
   * (sockets, timers) — § Driver Lifecycle Completion. A test fake with nothing to
   * release simply omits this. */
  close?(): Promise<void>;
}

/** § Phase 2B — widened from `(address: string)` to also carry `deviceId`: a real
 * connect implementation needs to load/save THIS device's own pairing credentials
 * (never another device's), which requires knowing which device it's connecting for.
 * Every binding still owns its own client — this is not a shared/global lookup. */
export interface AppleTvConnectContext {
  address: string;
  deviceId: DeviceId;
}

/** Resolve a client for an Apple TV, using that device's own stored pairing
 * credentials. Throws {@link AppleTvPairingRequiredError} if pairing is needed. */
export type AppleTvConnect = (ctx: AppleTvConnectContext) => Promise<AppleTvClient>;

export interface AppleTvDriverOptions {
  /** Poll period in ms for now-playing while connected (default 4000). */
  pollMs?: number;
  /** Injectable client factory (tests inject a fake; prod wraps a real MRP/pairing client). */
  connect?: AppleTvConnect;
  /** Injectable mDNS browser (tests); defaults to a real multicast browse. */
  mdns?: (serviceType: string) => Promise<MdnsService[]>;
  /** Build the client-reachable artwork URL for a device (the gateway proxy path).
   * When set and the device has art, it's emitted as the media state's artworkUrl. */
  artworkUrlFor?: (deviceId: DeviceId) => string;
  /** Base reconnect delay in ms (default 1000) — doubles per attempt, capped at
   * `reconnectMaxMs`. Each binding has its OWN backoff counter; one device's repeated
   * failures never affect another's schedule. */
  reconnectBaseMs?: number;
  /** Reconnect delay cap in ms (default 60000). */
  reconnectMaxMs?: number;
}

interface AppleTvBinding {
  deviceId: DeviceId;
  /** § Phase 2C — a device can bind BOTH `media` and `remote` against the SAME
   * underlying MRP connection (one physical Apple TV, one client, two capabilities) —
   * never two separate connections for one device. */
  capabilities: Set<CapabilityKind>;
  address: string;
  client: AppleTvClient | null;
  connectionState: AppleTvConnectionState;
  lastError: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Map an Apple TV now-playing snapshot onto the Supreme `media` capability state. App →
 * `source` (with an "Apple TV" fallback so the source is never empty for a live device).
 * `MediaState.volume`/`muted` (`packages/domain-model/src/capabilities.ts`) are non-nullable
 * by the frozen universal schema, so when this Apple TV doesn't own audio output
 * (`np.volume`/`np.muted` are `null`) this maps to the honest "no output" values (0,
 * unmuted) rather than a fabricated guess — the real distinction ("does this device own
 * audio output at all") belongs in `advanced`/a future capability-config field, not in
 * inventing a nullable variant of an already-frozen universal field.
 */
export function mediaStateFromNowPlaying(
  np: AppleTvNowPlaying,
  artworkUrl: string | null = np.artworkUrl ?? null,
): CapabilityState {
  return {
    kind: "media",
    playback: np.state,
    volume: np.volume === null ? 0 : Math.max(0, Math.min(100, Math.round(np.volume))),
    muted: np.muted ?? false,
    title: np.title,
    artist: np.artist,
    source: np.app ?? "Apple TV",
    artworkUrl,
    durationSec: np.durationSec ?? null,
    positionSec: np.positionSec ?? null,
  };
}

export class AppleTvProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "appletv";
  private connected = false;
  private readonly opts: AppleTvDriverOptions;
  private readonly bindings: AppleTvBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AppleTvDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    const period = this.opts.pollMs ?? 4000;
    this.pollTimer = setInterval(() => void this.poll(), period);
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    // § Driver Lifecycle Completion — every binding's own reconnect timer and MRP/
    // pairing client must be released too, never left running after teardown.
    for (const b of this.bindings) {
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      await b.client?.close?.();
    }
    this.bindings.length = 0;
    this.devices.clear();
    this.states.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    if (binding.capability !== "media" && binding.capability !== "remote") {
      throw new Error(`appletv: capability ${binding.capability} not supported (media, remote)`);
    }
    const existing = this.bindings.find((x) => x.deviceId === binding.deviceId);
    if (existing) {
      // Same physical Apple TV, a second capability (media <-> remote) — reuse the
      // existing connection/client rather than opening a second one.
      existing.capabilities.add(binding.capability);
      return;
    }
    const b: AppleTvBinding = {
      deviceId: binding.deviceId,
      capabilities: new Set([binding.capability]),
      address: binding.address,
      client: null,
      connectionState: "disconnected",
      lastError: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    this.bindings.push(b);
    this.devices.add(binding.deviceId);
    await this.connectBinding(b);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's reconnect timer + real
   * MRP client (if the injected implementation supports closing one), plus its bindings/
   * cached state, without touching any other device's timer/client/state or the shared
   * poll timer. Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    for (const b of this.bindings) {
      if (b.deviceId !== deviceId) continue;
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      await b.client?.close?.();
    }
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capabilities.has(command.capability));
    if (!b) throw new Error(`appletv: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "media" && command.capability !== "remote") {
      throw new Error(`appletv: unsupported capability ${command.capability}`);
    }
    if (!b.client || b.connectionState !== "connected") {
      throw new Error(`appletv: ${deviceId} is not connected (state: ${b.connectionState})`);
    }
    if (command.capability === "remote") {
      await b.client.pressButton(command.action);
      this.record(deviceId, "remote", { kind: "remote", lastButton: command.action });
      return;
    }
    switch (command.action) {
      case "play":
        await b.client.play();
        break;
      case "pause":
        await b.client.pause();
        break;
      case "stop":
        await b.client.stop();
        break;
      case "next":
        await b.client.next();
        break;
      case "previous":
        await b.client.previous();
        break;
      case "volume":
        if (typeof command.volume === "number") await b.client.setVolume(command.volume);
        break;
      case "mute":
        await b.client.setMuted(true);
        break;
      case "unmute":
        await b.client.setMuted(false);
        break;
    }
    await this.refresh(b);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  /** Diagnostics/UI surface (§ DeviceSheet Diagnostics section) — this device's own
   * connection lifecycle state, last error (if any), and reconnect attempt count. Never
   * exposes the pairing client/credentials themselves. */
  getConnectionDiagnostics(deviceId: DeviceId): { state: AppleTvConnectionState; lastError: string | null; reconnectAttempts: number } | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return { state: b.connectionState, lastError: b.lastError, reconnectAttempts: b.reconnectAttempts };
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Real mDNS discovery: Apple TVs advertise the Media Remote service. `backendId` is
    // the STABLE service instance name (survives a DHCP IP change) — never the raw
    // host/address, so re-discovery of an already-configured device is recognized by
    // the existing SupremeIntegrationLayerRegistry.isKnownBackendId() check rather than
    // creating a duplicate (§ "if an already-configured Apple TV is discovered again:
    // Already configured, not a duplicate" — this driver relies on that EXISTING,
    // protocol-agnostic mechanism; it does not re-implement its own).
    const browse = this.opts.mdns ?? mdnsBrowse;
    const services = await browse(APPLE_TV_SERVICE);
    return services.map((s) => {
      const instanceName = s.name.split(`.${APPLE_TV_SERVICE.replace(/^\./, "")}`)[0] ?? s.name;
      return {
        backendId: instanceName,
        suggestedName:
          instanceName.replace(/\\032/g, " ") || (typeof s.txt?.Name === "string" ? s.txt.Name : `Apple TV ${s.host}`),
        capabilities: ["media", "remote"] as DiscoveredDevice["capabilities"],
        raw: { host: s.host, port: s.port, address: s.addresses[0] ?? s.host, txt: s.txt },
      };
    });
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async poll(): Promise<void> {
    for (const b of this.bindings) {
      if (b.connectionState !== "connected") continue;
      try {
        await this.refresh(b);
      } catch {
        // A poll failure on one connected device must not stop the others; treat it as
        // a lost connection and let this binding's own reconnect loop take over.
        this.scheduleReconnect(b, "poll failed");
      }
    }
  }

  /** Attempts to (re)connect one binding's client — isolated to that binding only.
   * Never touches any other binding's state/timer. */
  private async connectBinding(b: AppleTvBinding): Promise<void> {
    b.connectionState = "connecting";
    const connectFn = this.opts.connect ?? defaultAppleTvConnect;
    try {
      const client = await connectFn({ address: b.address, deviceId: b.deviceId });
      b.client = client;
      b.connectionState = "connected";
      b.reconnectAttempts = 0;
      b.lastError = null;
      await this.refresh(b);
    } catch (err) {
      if (err instanceof AppleTvPairingRequiredError) {
        // Pairing is a user action, not a transient fault — do not enter the reconnect
        // loop; a future explicit re-bind (after pairing completes) is what resumes this.
        b.connectionState = "pairing_required";
        b.lastError = err.message;
        return;
      }
      this.scheduleReconnect(b, err instanceof Error ? err.message : String(err));
    }
  }

  /** Schedules this binding's own next reconnect attempt with exponential backoff,
   * capped — a fresh `setTimeout` per binding, never a shared timer. Idempotent: if a
   * reconnect is already scheduled for this binding, does nothing (never stacks
   * multiple pending attempts for the same device). */
  private scheduleReconnect(b: AppleTvBinding, reason: string): void {
    b.client = null;
    b.lastError = reason;
    b.connectionState = b.reconnectAttempts === 0 ? "error" : "reconnecting";
    if (b.reconnectTimer) return;
    const base = this.opts.reconnectBaseMs ?? 1000;
    const max = this.opts.reconnectMaxMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** b.reconnectAttempts);
    b.reconnectAttempts += 1;
    b.reconnectTimer = setTimeout(() => {
      b.reconnectTimer = null;
      void this.connectBinding(b);
    }, delay);
    (b.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private async refresh(b: AppleTvBinding): Promise<void> {
    if (!b.client) return;
    const np = await b.client.nowPlaying();
    // Cover art is fetched out-of-band (getArtwork); advertise the gateway proxy URL
    // only when art exists and a URL builder is configured, else null.
    const artworkUrl =
      np.hasArtwork && this.opts.artworkUrlFor ? this.opts.artworkUrlFor(b.deviceId) : np.artworkUrl ?? null;
    this.record(b.deviceId, "media", mediaStateFromNowPlaying(np, artworkUrl));
  }

  /** Fetch the bound device's current cover art (delegates to that device's own client
   * only — never another device's). */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b?.client?.getArtwork) return null;
    return b.client.getArtwork();
  }

  /** § Phase 3 — current foreground app for this ONE device (real MRP feedback, never
   * inferred from a prior command). `null` when unknown or not connected. */
  async getCurrentApplication(deviceId: DeviceId): Promise<TvForegroundApp | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b?.client?.getCurrentApplication) return null;
    return b.client.getCurrentApplication();
  }

  /** § Phase 3 — this device's installed/launchable apps. Throws (never returns an
   * empty array as a stand-in) when this device has no Companion session — "no apps
   * known" and "Companion not paired" are different facts and must not be conflated. */
  async getApplications(deviceId: DeviceId): Promise<TvAppRegistryEntry[]> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`appletv: ${deviceId} not bound`);
    if (!b.client?.getApplications) throw new Error(`appletv: ${deviceId} has no Companion session for app discovery`);
    return b.client.getApplications();
  }

  /** § Phase 3 — launch by stable bundle identifier, routed to this ONE device's own
   * client only. */
  async launchApplication(deviceId: DeviceId, bundleIdentifier: string): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`appletv: ${deviceId} not bound`);
    if (!b.client?.launchApplication) throw new Error(`appletv: ${deviceId} has no Companion session for app launch`);
    await b.client.launchApplication(bundleIdentifier);
  }

  /** § Phase 3 — launch a URL/URL-scheme deep link, routed to this ONE device's own
   * client only. */
  async launchDeepLink(deviceId: DeviceId, urlOrScheme: string): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) throw new Error(`appletv: ${deviceId} not bound`);
    if (!b.client?.launchDeepLink) throw new Error(`appletv: ${deviceId} has no Companion session for deep links`);
    await b.client.launchDeepLink(urlOrScheme);
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

async function defaultAppleTvConnect(_ctx: AppleTvConnectContext): Promise<AppleTvClient> {
  throw new Error(
    "appletv: no client configured — provide connect() (a real MRP/Companion pairing-aware client)",
  );
}
