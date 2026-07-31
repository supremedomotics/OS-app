/**
 * Casambi Local Gateway — UDP Engine (architecture only, § PR-3: UDP engine and realtime feedback).
 *
 * The Lithernet Gateway streams realtime unit/scene/button feedback over UDP — the Local
 * equivalent of the Cloud transport's WebSocket wire. This PR ships the seam only: every
 * method honestly rejects with {@link CasambiUdpNotImplementedError} rather than fabricating a
 * live feed. PR-3 fills the bodies in (socket bind, packet decode, reconnect) without changing
 * this shape.
 */

export interface CasambiUdpEngineOptions {
  gatewayIp: string;
  udpPort: number;
}

export class CasambiUdpNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `casambi: Local Gateway UDP ${operation} is not implemented yet — architecture-only in this release (see PR-3: UDP engine and real-time feedback).`,
    );
    this.name = "CasambiUdpNotImplementedError";
  }
}

/** A raw UDP feedback packet, pre-decode. Real shape lands with PR-3. */
export interface CasambiUdpPacket {
  readonly data: Uint8Array;
}

/** Placeholder realtime UDP engine for the Lithernet Gateway. */
export class CasambiUdpEngine {
  constructor(private readonly opts: CasambiUdpEngineOptions) {}

  get gatewayIp(): string {
    return this.opts.gatewayIp;
  }

  get udpPort(): number {
    return this.opts.udpPort;
  }

  /** True once a real UDP socket is bound and receiving — always false in this release. */
  get listening(): boolean {
    return false;
  }

  async start(): Promise<never> {
    throw new CasambiUdpNotImplementedError("start");
  }

  /** Idempotent no-op: nothing was ever started, so there is nothing to tear down. */
  async stop(): Promise<void> {
    // Intentional no-op — see class doc comment.
  }

  onPacket(_listener: (packet: CasambiUdpPacket) => void): () => void {
    throw new CasambiUdpNotImplementedError("onPacket");
  }
}
