import { HttpCasambiTransport, type CasambiCredentials, type CasambiTransport } from "./cloud-transport.js";
import { CasambiLocalTransport, type CasambiLocalGatewayConfig } from "./local-transport/index.js";

/**
 * Casambi Connection Manager (§ Casambi Driver Refactor — Foundation). The ONE place that decides
 * Cloud vs Local Gateway and builds the matching connection. Everything above this seam (Entity
 * Mapper, Discovery Engine, Feedback Engine, Event Engine, Diagnostics, Health Monitor) is written
 * against the SAME unified entity model regardless of which branch fires here — exactly the "single
 * unified entity model, multiple connection methods" goal of this refactor.
 *
 * Cloud is the default and existing, fully-working path — unchanged behavior, unchanged wire
 * shapes. Local is architecture-only in this release: selecting it produces a real
 * {@link CasambiLocalTransport} (REST Client + UDP Engine already wired together), but every
 * operation on it honestly rejects until PR-2/PR-3 implement the protocol — never a fabricated
 * connection.
 */
export type CasambiConnectionMode = "cloud" | "local";

export interface CasambiCloudConnectionOptions {
  connectionMode?: "cloud";
  credentials: CasambiCredentials;
  /** Injectable transport (tests pass a fake). Only meaningful for Cloud. */
  transport?: CasambiTransport;
}

export interface CasambiLocalConnectionOptions {
  connectionMode: "local";
  local: CasambiLocalGatewayConfig;
}

export type CasambiConnectionOptions = CasambiCloudConnectionOptions | CasambiLocalConnectionOptions;

export interface CasambiConnection {
  readonly mode: CasambiConnectionMode;
  /** Present only in Cloud mode — the real, working REST+WebSocket transport. */
  readonly cloudTransport: CasambiTransport | null;
  /** Present only in Local mode — REST Client + UDP Engine, both architecture-only. */
  readonly localTransport: CasambiLocalTransport | null;
}

/** Build the connection for the mode a driver instance was configured with. Pure/synchronous —
 * no I/O happens here, only the choice of which transport to construct. */
export function createConnection(opts: CasambiConnectionOptions): CasambiConnection {
  if (opts.connectionMode === "local") {
    return { mode: "local", cloudTransport: null, localTransport: new CasambiLocalTransport(opts.local) };
  }
  const cloudTransport = opts.transport ?? new HttpCasambiTransport({ apiKey: opts.credentials.apiKey });
  return { mode: "cloud", cloudTransport, localTransport: null };
}
