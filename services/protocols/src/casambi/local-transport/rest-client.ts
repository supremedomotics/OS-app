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
  /** § Casambi Local Gateway Auth — `Lithernet_General_Settings_Network.pdf` p.64: "Username and
   * password... Only one user account can be set up. This account has full access to all system
   * functions." The same login the gateway's embedded web server prompts for natively (p.109
   * screenshot shows a browser-native credential dialog, not a custom HTML form) is required for
   * direct HTTP/REST endpoints too, per that same page. Sent as HTTP Basic Authentication — the
   * standard mechanism that produces exactly that native-prompt behavior; the manuals show the
   * prompt but never name the scheme explicitly, so Basic Auth here is a disclosed, informed
   * choice, not a literally-documented protocol fact. Entirely independent of Casambi Cloud's
   * `apiKey`/`email`/`password` — never reused across the two. */
  gatewayUsername?: string;
  gatewayPassword?: string;
  /** Injectable fetch (tests pass a fake), matching `cloud-transport.ts`'s `fetchImpl` pattern.
   * Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms for `testConnection`/`setTargetValue`. Default 3000. */
  timeoutMs?: number;
}

/**
 * Result of the reachability + auth probe used by the Setup Wizard's "Test Connection" action.
 * Kept as a structured shape (rather than a single boolean) so the UI can show REST reachability
 * and HTTP authentication as the two distinct, honest facts they are — a gateway can be fully
 * reachable over HTTP and still reject the configured credentials, which is not the same failure
 * as being unreachable at all.
 */
export interface CasambiLocalRestTestResult {
  /** True if the gateway responded to the HTTP request at all (any status code) — false only on
   * a network-level failure (refused/timeout/DNS/abort). */
  reachable: boolean;
  /** The HTTP status of the reachability GET, or `null` if the request never got a response. */
  httpStatus: number | null;
  /** `true` if the gateway responded 401/403 (credentials required and missing/rejected),
   * `false` if it responded without an auth challenge, `null` if unreachable so auth could not
   * be evaluated at all. Never fabricated. */
  authFailed: boolean | null;
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

export type CasambiSetTargetValueResult = "ok" | "error" | "unauthorized";

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

  /** Basic Auth header for every Local REST request, built from the Gateway Username/Password —
   * never from Casambi Cloud credentials. Omitted entirely when no gateway credentials are
   * configured, so an unauthenticated gateway (or one not yet configured with credentials in
   * SupremeOS) still gets a plain request rather than a malformed header. */
  private authHeaders(): Record<string, string> {
    if (!this.opts.gatewayUsername || !this.opts.gatewayPassword) return {};
    const token = Buffer.from(`${this.opts.gatewayUsername}:${this.opts.gatewayPassword}`, "utf8").toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  /**
   * Reachability + HTTP-auth probe for the Setup Wizard's "Test Connection" action. Deliberately
   * does NOT call `/set/target_value` — that endpoint always writes a real value to a real
   * target, and connectivity checks must never actuate a device. Instead this issues a plain GET
   * to the gateway's HTTP root, carrying the configured Gateway Username/Password as Basic Auth:
   * any response (including a 404, since the gateway's embedded web server has no documented
   * root page) proves the host is up and speaking HTTP; a 401/403 proves it's up AND rejecting
   * the given credentials; only a network-level failure (refused/timeout/DNS/abort) means
   * unreachable, and only then is `authFailed` left `null` rather than guessed.
   */
  async testConnection(): Promise<CasambiLocalRestTestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl(), { method: "GET", signal: controller.signal, headers: this.authHeaders() });
      return { reachable: true, httpStatus: res.status, authFailed: res.status === 401 || res.status === 403 };
    } catch {
      return { reachable: false, httpStatus: null, authFailed: null };
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
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal, headers: this.authHeaders() });
      if (res.status === 401 || res.status === 403) return "unauthorized";
      const text = (await res.text()).trim().toLowerCase();
      return text === "ok" ? "ok" : "error";
    } finally {
      clearTimeout(timer);
    }
  }
}

export { CASAMBI_TARGET_TYPE };
