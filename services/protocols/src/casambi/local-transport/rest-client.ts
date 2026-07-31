/**
 * Casambi Local Gateway — REST Client (architecture only, § PR-2: Local REST implementation).
 *
 * The Lithernet Gateway exposes a local WebAPI (device model + control, reachable without
 * Casambi Cloud) that this class will speak once implemented. This PR ships the seam only:
 * every method honestly rejects with {@link CasambiLocalRestNotImplementedError} rather than
 * faking a response, exactly like an unbacked capability renders as an honest gated placeholder
 * instead of fabricated data. Real callers (the Connection Manager, health checks, the "Test
 * Connection" wizard action) are already wired against this shape — PR-2 fills the bodies in,
 * no seam changes required.
 */

export interface CasambiLocalRestClientOptions {
  gatewayIp: string;
  restPort: number;
  gatewayName?: string;
}

export class CasambiLocalRestNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `casambi: Local Gateway REST ${operation} is not implemented yet — architecture-only in this release (see PR-2: Local REST implementation).`,
    );
    this.name = "CasambiLocalRestNotImplementedError";
  }
}

/** Placeholder REST client for the Lithernet Gateway WebAPI. */
export class CasambiLocalRestClient {
  constructor(private readonly opts: CasambiLocalRestClientOptions) {}

  get gatewayIp(): string {
    return this.opts.gatewayIp;
  }

  get restPort(): number {
    return this.opts.restPort;
  }

  /** Reachability probe for the setup wizard's "Test Connection" action. */
  async testConnection(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("testConnection");
  }

  /** Persistent network model (units + groups) — the Local equivalent of the Cloud
   * transport's `fetchNetwork`. */
  async fetchNetwork(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("fetchNetwork");
  }

  /** Current state of every unit on the gateway. */
  async fetchState(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("fetchState");
  }

  /** Write a control command to a unit over REST (UDP carries realtime feedback instead;
   * see {@link import("./udp-engine.js").CasambiUdpEngine}). */
  async sendCommand(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("sendCommand");
  }
}
