import { REST_FATAL_STATUS_CODES, REST_TRANSIENT_STATUS_CODES } from "./coolmaster-constants.js";
import { CoolMasterConnectionError, CoolMasterProtocolError, CoolMasterTimeoutError } from "./coolmaster-errors.js";
import type { CoolMasterScopedLogger } from "./coolmaster-logger.js";

/**
 * Local REST v2.0 transport (docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt).
 * Stateless HTTP/JSON — no persistent connection to manage, unlike ASCII_IF.
 *
 * SCOPE NOTE (§ "do not guess behavior when the documentation provides an answer"): the
 * reference docs describe REST v2's "Primary endpoints" as `ls`/`ls2` (native JSON,
 * §4/§5) but do not document v1's request/response envelope beyond field names in
 * general terms ("Response object", no example). Rather than invent a v1 JSON shape this
 * driver has no way to verify, REST here implements ONLY the documented v2 ls/ls2 reads.
 * All commands (on/off/temp/mode/…) and everything beyond ls/ls2 go through ASCII_IF
 * (coolmaster-ascii-protocol.ts) instead — which still satisfies the requirement
 * verbatim ("REST should be preferred for JSON status retrieval. ASCII_IF should be used
 * where required by the protocol") without fabricating v1's wire format. See
 * docs/coolmaster/README.md "Limitations" for the full accounting.
 */

export interface CoolMasterRestTransportOptions {
  host: string;
  port: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: CoolMasterScopedLogger;
}

/** One row of the v2.0 `ls2` response, using the exact field names the reference docs
 * give (docs/coolmaster/CoolMaster_Core_Reference_Part5_v1.0.txt §5/§11): uid, onoff,
 * mode, st (setpoint), rt (room temp), fspeed, filt, dmnd, fault. Everything is typed
 * `unknown`/optional at this layer — coolmaster-parser.ts is the single place that
 * validates and narrows it, so a field this gateway omits never crashes the transport. */
export interface RawCoolMasterUnitJson {
  uid?: unknown;
  onoff?: unknown;
  mode?: unknown;
  st?: unknown;
  rt?: unknown;
  fspeed?: unknown;
  swing?: unknown;
  filt?: unknown;
  dmnd?: unknown;
  fault?: unknown;
  [extra: string]: unknown;
}

export class CoolMasterRestTransport {
  private readonly fetchImpl: typeof fetch;
  private reachable = false;

  constructor(private readonly opts: CoolMasterRestTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isReachable(): boolean {
    return this.reachable;
  }

  private baseUrl(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  /** Probe REST reachability without assuming a serial is known yet — used by
   * coolmaster-connection.ts to decide whether "auto" mode can prefer REST at all. */
  async probe(): Promise<boolean> {
    try {
      // No unauthenticated, serial-less "ping" endpoint is documented, so probing uses
      // a real v2 endpoint with a wildcard-ish placeholder serial; any HTTP response
      // (even a 404 for an unknown serial) proves the REST server itself is up, which is
      // all this probe needs to know — the real serial-scoped calls happen afterward.
      await this.fetchWithTimeout(`${this.baseUrl()}/v2.0/device/probe/ls`, {});
      // Any response at all (including a 404 for the placeholder serial) proves the
      // REST server itself is reachable, which is all a probe needs to establish.
      this.reachable = true;
      return this.reachable;
    } catch {
      this.reachable = false;
      return false;
    }
  }

  async ls2(serial: string): Promise<RawCoolMasterUnitJson[]> {
    return this.getUnitList(serial, "ls2");
  }

  async ls(serial: string): Promise<RawCoolMasterUnitJson[]> {
    return this.getUnitList(serial, "ls");
  }

  private async getUnitList(serial: string, command: "ls" | "ls2"): Promise<RawCoolMasterUnitJson[]> {
    const url = `${this.baseUrl()}/v2.0/device/${encodeURIComponent(serial)}/${command}`;
    const body = await this.getJson(url);
    // The documented shape gives field names but not the envelope (bare array vs
    // `{units:[...]}` vs `{data:[...]}`) — accept the common shapes defensively rather
    // than assume one, per the same "never crash on an unexpected-but-plausible shape"
    // principle as the parser layer.
    if (Array.isArray(body)) return body as RawCoolMasterUnitJson[];
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      for (const key of ["units", "data", "result", "response"]) {
        if (Array.isArray(obj[key])) return obj[key] as RawCoolMasterUnitJson[];
      }
    }
    throw new CoolMasterProtocolError(
      `coolmaster: unexpected REST ${command} response shape`,
      JSON.stringify(body).slice(0, 500),
    );
  }

  private async getJson(url: string): Promise<unknown> {
    let lastErr: Error = new CoolMasterConnectionError("coolmaster: REST request failed", "rest");
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, {});
        if (REST_FATAL_STATUS_CODES.includes(res.status)) {
          throw new CoolMasterProtocolError(`coolmaster: REST ${res.status} for ${url}`, await safeText(res));
        }
        if (REST_TRANSIENT_STATUS_CODES.includes(res.status)) {
          throw new CoolMasterConnectionError(`coolmaster: REST ${res.status} (transient) for ${url}`, "rest");
        }
        if (!res.ok) {
          throw new CoolMasterProtocolError(`coolmaster: REST ${res.status} for ${url}`, await safeText(res));
        }
        this.reachable = true;
        return await res.json();
      } catch (err) {
        this.reachable = false;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (err instanceof CoolMasterProtocolError) throw err; // fatal — no retry
        this.opts.logger?.debug("rest retry", { url, attempt, message: lastErr.message });
      }
    }
    throw lastErr;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new CoolMasterTimeoutError(`coolmaster: REST request to ${url} timed out`, "rest");
      }
      throw new CoolMasterConnectionError(`coolmaster: REST request to ${url} failed`, "rest", err);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
