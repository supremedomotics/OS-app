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
} from "./adapter.js";
import { applyCommand } from "./apply.js";

/**
 * In-memory backend adapter for Phase-0 verification and tests.
 *
 * It implements the exact same {@link IBackendAdapter} contract as `HaAdapter`,
 * which lets the full Supreme stack — gateway → device service → SIL → adapter —
 * be exercised end-to-end (the Phase-0 exit criteria, §16/§19) without a live HA
 * or any hardware. Swapping this for `HaAdapter` changes nothing above the SIL.
 */
export class MockAdapter implements IBackendAdapter {
  readonly kind = "mock";
  private connected = false;
  private readonly listeners = new Set<StateListener>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly seedDevices: DiscoveredDevice[];

  constructor(seed?: DiscoveredDevice[]) {
    this.seedDevices = seed ?? [];
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return this.seedDevices;
  }

  async getState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    return this.states.get(`${deviceId}:${capability}`) ?? null;
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.connected) throw new Error("mock adapter not connected");
    const next = this.apply(deviceId, command);
    if (next) {
      this.states.set(`${deviceId}:${command.capability}`, next);
      const event: BackendStateEvent = {
        deviceId,
        capability: command.capability,
        state: next,
        ts: new Date().toISOString(),
      };
      for (const l of this.listeners) l(event);
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Compute the resulting state of applying a command (the "device" responds). */
  private apply(deviceId: DeviceId, command: CapabilityCommand): CapabilityState | null {
    return applyCommand(this.states.get(`${deviceId}:${command.capability}`), command);
  }

  /** Test/seed helper: set an initial state without emitting a command. */
  seedState(deviceId: DeviceId, state: CapabilityState): void {
    this.states.set(`${deviceId}:${state.kind}`, state);
  }
}
