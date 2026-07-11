/**
 * @supreme/sdk — the generated/derived TypeScript client (§6). Web clients bind to
 * this; it is the only sanctioned way to talk to the hub, guaranteeing they never
 * couple to a backend (HA today, Supreme-native tomorrow).
 */
export {
  SupremeClient,
  MemoryTokenStore,
  type SupremeClientOptions,
  type TokenStore,
  type ClimateScheduleEvent,
  type ClimateScheduleEventInput,
  type ClimateScheduleResponse,
} from "./client.js";
export {
  SupremeStream,
  type StreamHandlers,
  type WebSocketCtor,
  type WebSocketLike,
} from "./stream-client.js";
