import { CASAMBI_TARGET_TYPE, type CasambiTargetType } from "./udp-codec.js";

/**
 * Casambi Local Gateway — REST Client (§ Casambi Driver Refactor — PR-2, Local Gateway
 * Foundation). Implements exactly what `Lithernet_WebAPI.pdf` §5.14 documents: a single
 * unauthenticated GET endpoint, `/set/target_value`, that writes one value to one target. That
 * document explicitly states "The endpoints are only available if the gateway is running in the
 * corresponding operating mode" (p.357) — this client assumes the Local Gateway is configured
 * for "WebAPI" mode; the gateway silently ignores the call otherwise, which surfaces here as an
 * `"error"` response rather than a thrown exception (the endpoint itself has no distinct
 * "wrong mode" status).
 *
 * No REST endpoint for network/device discovery, group/scene listing, or state read-back is
 * documented anywhere in the supplied Lithernet reference set — `fetchNetwork`/`fetchState`
 * honestly reject with {@link CasambiLocalRestNotImplementedError} rather than fabricating a
 * response. Local-mode discovery instead happens over UDP via NotifyControlValues subscription
 * (see `discovery-engine.ts` and `core/capability-engine.ts`'s doc comment on why).
 */

export interface CasambiLocalRestClientOptions {
  gatewayIp: string;
  restPort: number;
  gatewayName?: string;
  /** Injectable fetch (tests pass a fake), matching `cloud-transport.ts`'s `fetchImpl` pattern.
   * Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms for `testConnection`/`setTargetValue`. Default 3000. */
  timeoutMs?: number;
}

export class CasambiLocalRestNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `casambi: Local Gateway REST ${operation} is not implemented — no such endpoint is documented in the ` +
        `Lithernet WebAPI reference (only GET /set/target_value exists). See TODO.md.`,
    );
    this.name = "CasambiLocalRestNotImplementedError";
  }
}

export interface CasambiSetTargetValueParams {
  targetType: CasambiTargetType;
  targetId: number;
  /** Fade time; the gateway "converts internally into the corresponding Casambi duration"
   * (p.358) — units are the raw REST `duration` parameter, not pre-converted 10ms ticks. */
  durationMs?: number;
  value: number;
}

export type CasambiSetTargetValueResult = "ok" | "error";

/** Real REST client for the Lithernet Gateway's documented WebAPI. */
export class CasambiLocalRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CasambiLocalRestClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  get gatewayIp(): string {
    return this.opts.gatewayIp;
  }

  get restPort(): number {
    return this.opts.restPort;
  }

  private baseUrl(): string {
    return `http://${this.opts.gatewayIp}:${this.opts.restPort}`;
  }

  /**
   * Reachability probe for the Setup Wizard's "Test Connection" action. Deliberately does NOT
   * call `/set/target_value` — that endpoint always writes a real value to a real target, and
   * the PR-2 brief requires connectivity checks to never actuate a device. Instead this issues a
   * plain GET to the gateway's HTTP root: any response (including a 404, since the gateway's
   * embedded web server has no documented root page) proves the host is up and speaking HTTP;
   * only a network-level failure (refused/timeout/DNS) means unreachable.
   */
  async testConnection(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.fetchImpl(this.baseUrl(), { method: "GET", signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** No REST discovery endpoint is documented — see class doc comment. */
  async fetchNetwork(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("fetchNetwork");
  }

  /** No REST state-read endpoint is documented — see class doc comment. */
  async fetchState(): Promise<never> {
    throw new CasambiLocalRestNotImplementedError("fetchState");
  }

  /**
   * GET /set/target_value (p.358) — the one real, documented write endpoint. `targetType`
   * mirrors the UDP protocol's Target_Type addressing scheme (`CASAMBI_TARGET_TYPE` in
   * `udp-codec.ts`); the WebAPI doc doesn't restate that table but describes the same concept
   * ("target (e.g., device, group, or broadcast)") from the same reference manual.
   */
  async setTargetValue(params: CasambiSetTargetValueParams): Promise<CasambiSetTargetValueResult> {
    const url = new URL("/set/target_value", this.baseUrl());
    url.searchParams.set("type", String(params.targetType));
    url.searchParams.set("id", String(params.targetId));
    if (params.durationMs !== undefined) url.searchParams.set("duration", String(params.durationMs));
    url.searchParams.set("value", String(params.value));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
      const text = (await res.text()).trim().toLowerCase();
      return text === "ok" ? "ok" : "error";
    } finally {
      clearTimeout(timer);
    }
  }
}

export { CASAMBI_TARGET_TYPE };
