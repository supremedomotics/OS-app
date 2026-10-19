/**
 * Factory for ONE native connection with ONE health attachment (§ Supreme KNX Health — ownership). The pair is created, replaced and disposed
 * together, which is the whole lifecycle contract:
 *   - the factory's CALLER owns the pair (the future production factory; nothing in bootstrap uses this yet);
 *   - the connection owns the tunnel, reconnects and the read budget; the attachment owns its bus subscription and the monitor;
 *   - one attachment per connection, never shared: a connection is single-use after disconnect(), so replacement = a NEW pair, and the
 *     predecessor's pair is disposed (compose with `createSingleSlotConnectionFactory`, whose `make` may return `.connection`);
 *   - `dispose()` is final and idempotent and bounded by the connection's own disconnect: connection first (its link-down runs the hook cleanup),
 *     then the attachment (covers a connection that never connected, i.e. a failed or cancelled start).
 * A caller-supplied `onLinkUp` is refused rather than silently replaced. Not wired into any production path; no secure mode involved.
 */
import { NativeKnxConnection, type NativeKnxConnectionOptions } from "../native/knx-connection.js";
import type { Clock } from "../native/transport.js";
import type { HealthConfig } from "./health-model.js";
import { NativeKnxHealthAttachment } from "./native-health-attachment.js";

export interface NativeConnectionWithHealthOptions extends Omit<NativeKnxConnectionOptions, "onLinkUp"> {
  clock: Clock;
  health?: Partial<HealthConfig>;
}

export interface NativeConnectionWithHealth {
  readonly connection: NativeKnxConnection;
  readonly health: NativeKnxHealthAttachment;
  dispose(): Promise<void>;
}

export function createNativeConnectionWithHealth(o: NativeConnectionWithHealthOptions): NativeConnectionWithHealth {
  if ((o as { onLinkUp?: unknown }).onLinkUp !== undefined) throw new Error("createNativeConnectionWithHealth owns the onLinkUp hook; pass a plain NativeKnxConnection to use your own");
  const { health: healthConfig, ...connectionOptions } = o;
  const health = new NativeKnxHealthAttachment({ clock: o.clock, ...(healthConfig ? { health: healthConfig } : {}) });
  const connection = new NativeKnxConnection({ ...connectionOptions, onLinkUp: health.onLinkUp });
  let disposing: Promise<void> | null = null;
  return {
    connection, health,
    dispose: () => (disposing ??= (async () => { try { await connection.disconnect(); } finally { health.dispose(); } })()),
  };
}
