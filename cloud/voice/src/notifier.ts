import { createSign } from "node:crypto";
import type { LinkRecord } from "./oauth.js";
import type { AssistantNotifier, AssistantReport } from "./reporting.js";

/**
 * Real dispatch of proactive reports to the assistant clouds — the credential boundary from ADR 0010,
 * now implemented (no native deps; just HTTPS + crypto):
 *   • Alexa: exchange the link's AcceptGrant code for an event-gateway access token (LWA), inject it
 *     into the ChangeReport's endpoint scope, and POST to the Alexa event gateway.
 *   • Google: mint a service-account JWT, exchange it for a HomeGraph access token, and POST the
 *     ReportState request.
 * Tokens are cached until just before expiry. All I/O goes through an injectable `fetchImpl` so the
 * token-exchange + dispatch mechanics are unit-testable without real Amazon/Google credentials.
 */

export interface AlexaNotifierConfig {
  /** Login-with-Amazon client credentials for the skill. */
  clientId: string;
  clientSecret: string;
  lwaTokenUrl?: string; // default https://api.amazon.com/auth/o2/token
  eventGatewayUrl?: string; // default https://api.amazonalexa.com/v3/events
}

export interface GoogleNotifierConfig {
  serviceAccountEmail: string;
  /** PEM RSA private key for the HomeGraph service account. */
  privateKey: string;
  tokenUrl?: string; // default https://oauth2.googleapis.com/token
  reportStateUrl?: string; // default https://homegraph.googleapis.com/v1/devices:reportStateAndNotification
}

export interface HttpAssistantNotifierOptions {
  alexa?: AlexaNotifierConfig;
  google?: GoogleNotifierConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class HttpAssistantNotifier implements AssistantNotifier {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly alexaTokens = new Map<string, CachedToken>(); // per link (grant code → token)
  private googleToken: CachedToken | null = null;

  constructor(private readonly opts: HttpAssistantNotifierOptions) {
    this.f = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async notify(report: AssistantReport, link: LinkRecord): Promise<void> {
    if (report.assistant === "alexa" && this.opts.alexa) return this.notifyAlexa(report, link);
    if (report.assistant === "google" && this.opts.google) return this.notifyGoogle(report);
    this.opts.log?.("no notifier configured for assistant", { assistant: report.assistant });
  }

  // ── Alexa event gateway ────────────────────────────────────────────────────────────────────
  private async notifyAlexa(report: AssistantReport, link: LinkRecord): Promise<void> {
    if (!link.acceptGrant) {
      this.opts.log?.("alexa link not enrolled for proactive reporting (no AcceptGrant)", { linkId: link.linkId });
      return;
    }
    const token = await this.alexaEventToken(link);
    // Inject the event-gateway token into the ChangeReport endpoint scope (the builder leaves it out).
    const payload = report.payload as { event?: { endpoint?: Record<string, unknown> } };
    if (payload.event?.endpoint) payload.event.endpoint.scope = { type: "BearerToken", token };
    const cfg = this.opts.alexa!;
    const res = await this.f(cfg.eventGatewayUrl ?? "https://api.amazonalexa.com/v3/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(report.payload),
    });
    if (!res.ok) throw new Error(`alexa event gateway ${res.status}`);
  }

  private async alexaEventToken(link: LinkRecord): Promise<string> {
    const cached = this.alexaTokens.get(link.linkId);
    if (cached && cached.expiresAt > this.now() + 30_000) return cached.token;
    const cfg = this.opts.alexa!;
    const res = await this.f(cfg.lwaTokenUrl ?? "https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: link.acceptGrant!.code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`lwa token exchange ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    const token = { token: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    this.alexaTokens.set(link.linkId, token);
    return token.token;
  }

  // ── Google HomeGraph ───────────────────────────────────────────────────────────────────────
  private async notifyGoogle(report: AssistantReport): Promise<void> {
    const token = await this.googleAccessToken();
    const cfg = this.opts.google!;
    const res = await this.f(cfg.reportStateUrl ?? "https://homegraph.googleapis.com/v1/devices:reportStateAndNotification", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(report.payload),
    });
    if (!res.ok) throw new Error(`homegraph reportState ${res.status}`);
  }

  private async googleAccessToken(): Promise<string> {
    if (this.googleToken && this.googleToken.expiresAt > this.now() + 30_000) return this.googleToken.token;
    const cfg = this.opts.google!;
    const tokenUrl = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: cfg.serviceAccountEmail, scope: "https://www.googleapis.com/auth/homegraph", aud: tokenUrl, iat, exp: iat + 3600 }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(cfg.privateKey, "base64url");
    const assertion = `${header}.${claims}.${signature}`;
    const res = await this.f(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok) throw new Error(`google token exchange ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.googleToken = { token: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.googleToken.token;
  }
}
