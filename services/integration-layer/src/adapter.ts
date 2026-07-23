import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";

/**
 * The backend adapter contract — the migration guarantee (blueprint §7).
 *
 * Everything above the SIL speaks Supreme. The SIL holds the ONLY knowledge of a
 * concrete backend, and that knowledge is confined behind this interface. Phase 1
 * ships `HaAdapter`; the native migration introduces `SupremeNativeAdapter`
 * per-domain behind feature flags — same interface, drop-in replacement, zero
 * change above the SIL.
 */

/** A normalized state change emitted by the backend, in Supreme terms. */
export interface BackendStateEvent {
  deviceId: DeviceId;
  capability: CapabilityKind;
  state: CapabilityState;
  /** Backend event timestamp (ISO-8601). */
  ts: string;
}

/** What the backend reports about a discovered device (pre-Supreme-mapping). */
export interface DiscoveredDevice {
  /** Backend-native id (e.g. HA entity id). Never leaves the SIL. */
  backendId: string;
  suggestedName: string;
  capabilities: CapabilityKind[];
  /** Structural, driver-normalized per-capability config (§ ADR 0017 — Capability
   * Normalization), e.g. `{ color: { colorModes: { rgb: true, cct: false } } }` — known from the
   * driver's own protocol model at discovery time, never inferred from live state. Optional: a
   * driver that hasn't adopted structural capability metadata yet simply omits it, and the UI's
   * existing state-inference fallback keeps working unmodified (backward compatible). */
  capabilityConfig?: Partial<Record<CapabilityKind, Record<string, unknown>>>;
  /** Opaque backend metadata used by the capability mapper. */
  raw: Record<string, unknown>;
}

export type StateListener = (event: BackendStateEvent) => void;

/** Raw media artwork bytes for a device (e.g. an Apple TV now-playing cover), fetched
 * out-of-band of state so the (large) image never rides on every state delta. */
export interface MediaArtwork {
  contentType: string;
  data: Uint8Array;
}

/** One entry in a media device's play queue (protocols that genuinely expose one,
 * e.g. HEOS's `get_queue` — not fabricated for protocols that don't, like classic
 * Denon Telnet or Yamaha's Basic YXC surface). */
export interface MediaQueueItem {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
}

export type DriverConnectionStatus = "connected" | "connecting" | "disconnected";

/** Real-time connection/traffic health for one device's owning driver link (§ Diagnostics
 * Console, Universal AV Driver SDK). Every field is either a genuine counter/timestamp or
 * `null` when the owning protocol truly doesn't expose it (e.g. no AVR protocol in this
 * fleet reports firmware on the wire) — never a fabricated placeholder. See
 * `services/protocols/src/driver-diagnostics.ts` for the shared tracker that produces this. */
export interface DriverDiagnosticsSnapshot {
  connectionStatus: DriverConnectionStatus;
  protocol: string;
  driverVersion: string;
  model: string | null;
  firmware: string | null;
  /** § Production Bugfix Sprint — a real UPnP device-description serial number, when
   * the owning driver's discovery step fetched one (see `parseUpnpDescription()` in
   * `@supreme/protocols`). `null` when unsupported/not fetched — never fabricated. */
  serial: string | null;
  ip: string | null;
  mac: string | null;
  lastCommand: string | null;
  lastCommandAt: string | null;
  lastResponse: string | null;
  lastResponseAt: string | null;
  responseTimeMs: number | null;
  /** § Universal AVR SDK — rolling average of recent round-trip times, distinct from
   * `responseTimeMs` (the single most-recent sample). `null` until at least one
   * real round-trip has been measured. */
  averageLatencyMs: number | null;
  packetsSent: number;
  packetsReceived: number;
  reconnectCount: number;
  lastError: string | null;
}

/** One recorded protocol-trace line (§ Universal AVR SDK — "capture and log the raw
 * protocol responses for every discovery, capability, command, and event operation").
 * Fed by a driver's `ProtocolTracer` into a bounded ring buffer — see
 * `services/protocols/src/driver-diagnostics.ts`'s `recordTrace`/`recentTrace`. */
export interface DriverTraceEntry {
  at: string;
  line: string;
}

export interface IBackendAdapter {
  /** Stable identifier for the adapter implementation (e.g. "ha", "supreme-native"). */
  readonly kind: string;

  /** Establish the backend connection and begin streaming state. Idempotent. */
  connect(): Promise<void>;

  /** Tear down the connection cleanly. */
  disconnect(): Promise<void>;

  /** True when the adapter currently has a healthy backend connection. */
  isConnected(): boolean;

  /** Issue a Supreme capability command against a device. */
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;

  /** Read the current normalized state for a device capability. */
  getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null>;

  /** Discover devices the backend currently exposes. */
  discover(): Promise<DiscoveredDevice[]>;

  /** Subscribe to normalized state changes. Returns an unsubscribe fn. */
  onState(listener: StateListener): () => void;

  /** Optional: fetch a device's current media artwork bytes (null if none/unsupported). */
  getArtwork?(deviceId: DeviceId): Promise<MediaArtwork | null>;

  /** Optional: fetch a media device's current play queue (null if none/unsupported). */
  getQueue?(deviceId: DeviceId): Promise<MediaQueueItem[] | null>;

  /** Optional: fetch a device+capability's real AudioCapabilityConfig, if the owning
   * driver reports one (null if none/unsupported). */
  getCapabilityConfig?(deviceId: DeviceId, capability: CapabilityKind): Promise<Record<string, unknown> | null>;

  /** Optional: fetch a device's real connection/traffic diagnostics from its owning
   * driver (null if none/unsupported — e.g. this device isn't bound to a native driver
   * that tracks this). */
  getDiagnostics?(deviceId: DeviceId): Promise<DriverDiagnosticsSnapshot | null>;

  /** Optional: fetch a device's owning driver's recent raw protocol trace (null if
   * unsupported, or if trace logging isn't enabled for that driver instance — see
   * each protocol's `trace` config option, off by default). */
  getTrace?(deviceId: DeviceId): Promise<DriverTraceEntry[] | null>;

  /** Optional: release the owning driver's per-device resources (§ Driver Lifecycle
   * Completion) — called when a Supreme device is deleted. A no-op for backends with
   * no per-device driver-level state to release (e.g. HA — HA owns its own connection
   * lifecycle independently of Supreme device deletion). */
  unbindDevice?(deviceId: DeviceId): Promise<void>;

  /** Optional: ask the owning driver to re-query whatever real capability data it can
   * genuinely re-discover over the wire, in place (§ Capability Refresh) — never
   * recreates the device. A no-op for backends/drivers with nothing to re-query. */
  refreshCapabilities?(deviceId: DeviceId): Promise<void>;
}
