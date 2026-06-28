import type { BackendStateEvent } from "@supreme/integration-layer";

/**
 * Hub-side publisher for proactive voice state reporting (ADR 0010). When a device changes locally
 * the hub posts the delta to the cloud Voice service's /v1/state ingest, which fans it out to every
 * linked assistant (Alexa ChangeReport / Google ReportState). Outbound-only and NON-FATAL — local
 * control is unaffected if the cloud is unreachable (the cloud is never on the critical path).
 *
 * Changes are debounced per (device, capability): a flurry of intermediate values (e.g. a dimmer
 * sweeping) collapses to the latest value, so we don't spam the assistant clouds.
 */
export interface VoiceStatePublisherOptions {
  /** Cloud Voice base URL, e.g. "https://voice.supremedomotics.in". */
  baseUrl: string;
  /** Per-hub key the Voice service maps to this home. */
  hubKey: string;
  /** Coalescing window (ms) per device/capability. */
  debounceMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class VoiceStatePublisher {
  private readonly debounceMs: number;
  private readonly pending = new Map<string, { state: unknown; capability: string; deviceId: string; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;

  constructor(private readonly opts: VoiceStatePublisherOptions) {
    this.debounceMs = opts.debounceMs ?? 750;
  }

  /** Queue a state change for debounced delivery to the cloud Voice service. */
  publish(event: Pick<BackendStateEvent, "deviceId" | "capability" | "state">): void {
    if (this.stopped) return;
    const key = `${event.deviceId}:${event.capability}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.send(event.deviceId, event.capability, event.state);
    }, this.debounceMs);
    timer.unref?.();
    this.pending.set(key, { state: event.state, capability: event.capability, deviceId: event.deviceId, timer });
  }

  /** Cancel all pending timers (shutdown). */
  stop(): void {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private async send(deviceId: string, capability: string, state: unknown): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(`${this.opts.baseUrl}/v1/state`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.hubKey}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId, capability, state }),
      });
      if (!res.ok) this.opts.log?.("voice state publish rejected", { status: res.status });
    } catch (err) {
      this.opts.log?.("voice state publish failed (local control unaffected)", { error: (err as Error).message });
    }
  }
}
