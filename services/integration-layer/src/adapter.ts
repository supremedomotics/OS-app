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
}
