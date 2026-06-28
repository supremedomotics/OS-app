import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Assistant } from "./index.js";

/**
 * OAuth2 account-linking provider (blueprint §9). Supreme Cloud is the IdP that Alexa and Google
 * link against: the assistant sends the user to /oauth/authorize, the user proves their Supreme
 * identity, and we hand back an authorization code; the assistant's cloud exchanges it at
 * /oauth/token for access + refresh tokens it presents on every directive.
 *
 * Tokens are self-contained HMAC artifacts (no DB lookup to validate) that reference a server-side
 * LinkRecord by id, so revocation is a single delete and the token store can stay stateless.
 * Authorization codes are opaque, single-use, and short-lived. This is the certification surface —
 * the actual device control is delegated to the hub over the Tunnel Broker.
 */

/** What a verified Supreme login resolves to — the binding the link captures. */
export interface LinkIdentity {
  accountId: string;
  homeId: string;
  /** A hub-scoped Supreme access token the cloud presents when forwarding directives. */
  hubToken: string;
  scopes?: string[];
}

export interface LinkRecord extends LinkIdentity {
  linkId: string;
  assistant: Assistant;
  scopes: string[];
  linkedAt: number;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  assistant: Assistant;
  /** Exact redirect URIs the assistant cloud is allowed to use. */
  redirectUris: string[];
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

interface CodeEntry {
  record: LinkRecord;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

interface TokenPayload {
  lid: string;
  typ: "access" | "refresh";
  exp: number;
}

export interface OAuthProviderOptions {
  /** HMAC signing secret for tokens. MUST be set from a real secret in production. */
  signingSecret: string;
  clients: OAuthClient[];
  now?: () => number;
  /** TTLs (ms). */
  codeTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
}

export class OAuthProvider {
  private readonly secret: string;
  private readonly clients = new Map<string, OAuthClient>();
  private readonly links = new Map<string, LinkRecord>();
  private readonly codes = new Map<string, CodeEntry>();
  private readonly now: () => number;
  private readonly codeTtl: number;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(opts: OAuthProviderOptions) {
    this.secret = opts.signingSecret;
    for (const c of opts.clients) this.clients.set(c.clientId, c);
    this.now = opts.now ?? (() => Date.now());
    this.codeTtl = opts.codeTtlMs ?? 10 * 60 * 1000; // 10 min
    this.accessTtl = opts.accessTtlMs ?? 60 * 60 * 1000; // 1 h
    this.refreshTtl = opts.refreshTtlMs ?? 180 * 24 * 60 * 60 * 1000; // 180 d
  }

  /**
   * Validate the /authorize query BEFORE we render a login. Guards the client + redirect_uri so an
   * attacker can't trick us into redirecting a code to an unregistered URL (open-redirect / code
   * theft). Returns the resolved client so the login page can show the assistant's name.
   */
  validateAuthorization(params: { clientId?: string; redirectUri?: string; responseType?: string }): OAuthClient {
    const client = params.clientId ? this.clients.get(params.clientId) : undefined;
    if (!client) throw new OAuthError("invalid_client", "unknown client_id", 400);
    if (params.responseType !== "code") throw new OAuthError("unsupported_response_type", "only response_type=code is supported");
    if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri not registered for this client");
    }
    return client;
  }

  /**
   * Issue an authorization code AFTER the user has proven their Supreme identity. Binds the code to
   * the resolved home + a hub-scoped token. The caller redirects the user to
   * `${redirectUri}?code=...&state=...`.
   */
  issueCode(params: { clientId: string; redirectUri: string; identity: LinkIdentity }): string {
    const client = this.validateAuthorization({ clientId: params.clientId, redirectUri: params.redirectUri, responseType: "code" });
    const linkId = `lnk_${randomBytes(12).toString("hex")}`;
    const record: LinkRecord = {
      linkId,
      assistant: client.assistant,
      accountId: params.identity.accountId,
      homeId: params.identity.homeId,
      hubToken: params.identity.hubToken,
      scopes: params.identity.scopes ?? ["control"],
      linkedAt: this.now(),
    };
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { record, clientId: client.clientId, redirectUri: params.redirectUri, expiresAt: this.now() + this.codeTtl });
    return code;
  }

  /** Exchange grant (authorization_code or refresh_token) → token set. */
  exchange(params: {
    grantType?: string;
    code?: string;
    refreshToken?: string;
    redirectUri?: string;
    clientId?: string;
    clientSecret?: string;
  }): { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number } {
    const client = this.authenticateClient(params.clientId, params.clientSecret);
    if (params.grantType === "authorization_code") {
      return this.exchangeCode(client, params.code, params.redirectUri);
    }
    if (params.grantType === "refresh_token") {
      return this.exchangeRefresh(client, params.refreshToken);
    }
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  /** Resolve an access token to its live link, or undefined if invalid/expired/revoked. */
  resolve(accessToken: string | undefined): LinkRecord | undefined {
    const payload = this.verifyToken(accessToken);
    if (!payload || payload.typ !== "access") return undefined;
    return this.links.get(payload.lid);
  }

  /** Revoke a link (assistant DISCONNECT / user unlink). Idempotent. */
  revoke(token: string | undefined): boolean {
    const payload = this.verifyToken(token);
    if (!payload) return false;
    return this.links.delete(payload.lid);
  }

  /** Test/inspection helper: is this link still active? */
  hasLink(linkId: string): boolean {
    return this.links.has(linkId);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────
  private authenticateClient(clientId?: string, clientSecret?: string): OAuthClient {
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (!client || !clientSecret || !constantTimeEqual(clientSecret, client.clientSecret)) {
      throw new OAuthError("invalid_client", "client authentication failed", 401);
    }
    return client;
  }

  private exchangeCode(client: OAuthClient, code: string | undefined, redirectUri: string | undefined) {
    const entry = code ? this.codes.get(code) : undefined;
    if (!entry) throw new OAuthError("invalid_grant", "unknown or used authorization code");
    this.codes.delete(code!); // single-use, even on failure below
    if (entry.expiresAt < this.now()) throw new OAuthError("invalid_grant", "authorization code expired");
    if (entry.clientId !== client.clientId) throw new OAuthError("invalid_grant", "code was issued to a different client");
    if (entry.redirectUri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    this.links.set(entry.record.linkId, entry.record);
    return this.mintTokens(entry.record.linkId);
  }

  private exchangeRefresh(client: OAuthClient, refreshToken: string | undefined) {
    const payload = this.verifyToken(refreshToken);
    if (!payload || payload.typ !== "refresh") throw new OAuthError("invalid_grant", "invalid refresh token");
    const record = this.links.get(payload.lid);
    if (!record) throw new OAuthError("invalid_grant", "link revoked");
    if (record.assistant !== client.assistant) throw new OAuthError("invalid_grant", "refresh token does not belong to this client");
    return this.mintTokens(record.linkId);
  }

  private mintTokens(lid: string) {
    const access = this.signToken({ lid, typ: "access", exp: this.now() + this.accessTtl });
    const refresh = this.signToken({ lid, typ: "refresh", exp: this.now() + this.refreshTtl });
    return { access_token: access, refresh_token: refresh, token_type: "bearer" as const, expires_in: Math.floor(this.accessTtl / 1000) };
  }

  private signToken(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  private verifyToken(token: string | undefined): TokenPayload | undefined {
    if (!token) return undefined;
    const dot = token.indexOf(".");
    if (dot < 0) return undefined;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (!constantTimeEqual(sig, expected)) return undefined;
    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (typeof payload.exp !== "number" || payload.exp < this.now()) return undefined;
    return payload;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
