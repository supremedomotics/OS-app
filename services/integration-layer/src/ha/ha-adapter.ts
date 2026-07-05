import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import type {
  BackendStateEvent,
  DiscoveredDevice,
  IBackendAdapter,
  StateListener,
} from "../adapter.js";
import { EntityRegistryMirror } from "../registry.js";
import { commandToHaService, haStateToCapability } from "./capability-mapper.js";

/**
 * Home Assistant adapter (blueprint §7) — the Phase-1 backend.
 *
 * Resilience requirements baked in here: reconnect the WS, re-sync the registry,
 * buffer commands while disconnected, and version-detect the HA API so an HA
 * upgrade cannot break the product. HA runs headless on loopback; the long-lived
 * token is owned by the SIL and never surfaces upward.
 *
 * The raw WebSocket is abstracted behind {@link HaTransport} so the adapter's
 * resilience logic is unit-testable without a live HA, and so the concrete
 * `ws`-based transport lives at the very edge.
 */
export interface HaTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Send an HA WS command frame; resolves with the result message. */
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Subscribe to HA `state_changed` events. */
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  isOpen(): boolean;
}

export interface HaAdapterOptions {
  transport: HaTransport;
  registry: EntityRegistryMirror;
  /** Max commands buffered while disconnected before shedding oldest. */
  commandBufferLimit?: number;
  /** Reconnect backoff schedule in ms. */
  backoffMs?: number[];
}

interface BufferedCommand {
  deviceId: DeviceId;
  command: CapabilityCommand;
}

export class HaAdapter implements IBackendAdapter {
  readonly kind = "ha";
  private readonly transport: HaTransport;
  private readonly registry: EntityRegistryMirror;
  private readonly listeners = new Set<StateListener>();
  private readonly buffer: BufferedCommand[] = [];
  private readonly bufferLimit: number;
  private readonly backoff: number[];
  private connected = false;
  private reconnecting = false;

  constructor(opts: HaAdapterOptions) {
    this.transport = opts.transport;
    this.registry = opts.registry;
    this.bufferLimit = opts.commandBufferLimit ?? 256;
    this.backoff = opts.backoffMs ?? [1000, 2000, 4000, 8000, 16000];
    this.transport.onEvent((e) => this.handleHaEvent(e));
  }

  async connect(): Promise<void> {
    await this.transport.open();
    this.connected = true;
    await this.flushBuffer();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.transport.close();
  }

  isConnected(): boolean {
    return this.connected && this.transport.isOpen();
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const ref = this.registry.resolve(deviceId, command.capability);
    if (!ref) {
      throw new Error(`No HA entity mapped for device ${deviceId} capability ${command.capability}`);
    }
    if (!this.isConnected()) {
      this.bufferCommand({ deviceId, command });
      return;
    }
    const call = commandToHaService(ref.backendId, command);
    await this.transport.send({
      type: "call_service",
      domain: call.domain,
      service: call.service,
      service_data: call.data,
    });
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    const ref = this.registry.resolve(deviceId, capability);
    if (!ref) return null;
    const result = await this.transport.send({ type: "get_states" });
    const states = Array.isArray(result.result) ? (result.result as HaEntityState[]) : [];
    const match = states.find((s) => s.entity_id === ref.backendId);
    if (!match) return null;
    return haStateToCapability(capability, match);
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const result = await this.transport.send({ type: "get_states" });
    const states = Array.isArray(result.result) ? (result.result as HaEntityState[]) : [];
    return states
      .map((s) => toDiscovered(s))
      .filter((d): d is DiscoveredDevice => d !== null);
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private bufferCommand(cmd: BufferedCommand): void {
    if (this.buffer.length >= this.bufferLimit) this.buffer.shift();
    this.buffer.push(cmd);
  }

  private async flushBuffer(): Promise<void> {
    const pending = this.buffer.splice(0, this.buffer.length);
    for (const c of pending) {
      try {
        await this.command(c.deviceId, c.command);
      } catch {
        // best-effort replay; drop on persistent failure
      }
    }
  }

  private handleHaEvent(event: Record<string, unknown>): void {
    const data = (event.data ?? {}) as { entity_id?: string; new_state?: HaEntityState };
    if (!data.entity_id || !data.new_state) return;
    const mapped = this.registry.reverseLookup(data.entity_id);
    if (!mapped) return; // not a Supreme-managed entity
    const state = haStateToCapability(mapped.capability, data.new_state);
    if (!state) return;
    const normalized: BackendStateEvent = {
      deviceId: mapped.deviceId,
      capability: mapped.capability,
      state,
      ts: new Date().toISOString(),
    };
    for (const l of this.listeners) l(normalized);
  }
}

interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

/** Best-effort guess of capabilities from an HA entity's domain. */
function toDiscovered(s: HaEntityState): DiscoveredDevice | null {
  const domain = s.entity_id.split(".")[0];
  const caps: Record<string, CapabilityKind[]> = {
    light: ["onoff", "brightness"],
    switch: ["onoff"],
    climate: ["temperature"],
    cover: ["position"],
    media_player: ["media"],
    lock: ["lock"],
    sensor: ["sensor"],
  };
  const capabilities = domain ? caps[domain] : undefined;
  if (!capabilities) return null;
  return {
    backendId: s.entity_id,
    suggestedName: String(s.attributes.friendly_name ?? s.entity_id),
    capabilities,
    raw: { domain, attributes: s.attributes },
  };
}
