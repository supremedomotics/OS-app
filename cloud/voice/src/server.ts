import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  alexaBearerToken,
  alexaDirectiveToCanonical,
  alexaOptimisticProperties,
  buildAcceptGrantResponse,
  buildControlResponse,
  buildDiscoveryResponse,
  buildErrorResponse,
  buildReportStateResponse,
  type AlexaDirective,
} from "./alexa.js";
import { dispatchStateDelta, LoggingNotifier, type AssistantNotifier, type StateDelta } from "./reporting.js";
import {
  buildExecuteResponse,
  buildQueryResponse,
  buildSyncResponse,
  googleDeviceState,
  googleExecutionToCanonical,
  type GoogleCommandResult,
  type GoogleRequest,
} from "./google.js";
import { HubUnavailableError, toHubCommand, type CanonicalIntent, type HubRouter } from "./hub-router.js";
import { OAuthError, OAuthProvider, type LinkIdentity, type LinkRecord } from "./oauth.js";

/**
 * Cloud Voice HTTP surface (blueprint §9) — the certification endpoints assistants actually call:
 *   • OAuth2 account-linking IdP (/oauth/authorize, /oauth/token) so Alexa/Google bind to a Supreme
 *     account+home;
 *   • Alexa Smart Home Skill webhook (/voice/alexa);
 *   • Google Smart Home fulfillment (/voice/google).
 * Every device action is forwarded to the hub over the Tunnel Broker (HubRouter) where identity +
 * RBAC are enforced locally. The cloud is transport + protocol translation only.
 */

export interface VoiceServerOptions {
  oauth: OAuthProvider;
  hub: HubRouter;
  /**
   * Resolve a Supreme login (from the consent screen) to the account+home and a hub-scoped token.
   * In production this calls the Identity plane; the returned hubToken is what the cloud presents
   * when forwarding directives to the hub.
   */
  authenticateUser: (credentials: { email: string; password: string }) => Promise<LinkIdentity | null>;
  /** Per-hub API key → homeId, authenticating the hub's proactive state-report ingest (/v1/state). */
  hubKeys?: Map<string, string>;
  /** Dispatches proactive reports to the assistant clouds; defaults to a logging no-op. */
  notifier?: AssistantNotifier;
  logLevel?: string;
  now?: () => number;
}

/** Hard cap on device operations per Google EXECUTE request (anti-amplification). */
const MAX_EXECUTE_OPS = 64;

export function buildVoiceServer(opts: VoiceServerOptions): FastifyInstance {
  // Cap the body size so a giant payload can't exhaust memory before our op-count guard runs.
  const app = Fastify({ logger: { level: opts.logLevel ?? "info" }, bodyLimit: 256 * 1024 });
  const now = opts.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();
  // Per-IP fixed-window limiter for the credential-bearing consent endpoint.
  const rateLimit = new FixedWindowLimiter({ now, windowMs: 60_000, max: 20 });
  const notifier = opts.notifier ?? new LoggingNotifier((m, meta) => app.log.info(meta ?? {}, m));
  const hubKeys = opts.hubKeys ?? new Map<string, string>();

  // Alexa and Google post form-encoded bodies to the token endpoint; accept both.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body as string)) params[k] = v;
    done(null, params);
  });

  app.get("/healthz", async () => ({ status: "ok", service: "voice" }));

  // ── OAuth2 account linking ─────────────────────────────────────────────────────────────────
  // Consent screen. In production this is the Supreme-branded login; here it renders a minimal form
  // that POSTs the user's Supreme credentials back with the (validated) authorize params.
  app.get<{ Querystring: Record<string, string> }>("/oauth/authorize", async (req, reply) => {
    const q = req.query;
    try {
      const client = opts.oauth.validateAuthorization({ clientId: q.client_id, redirectUri: q.redirect_uri, responseType: q.response_type });
      const csrf = opts.oauth.issueLinkingTicket({ clientId: client.clientId, redirectUri: q.redirect_uri! });
      reply.type("text/html").send(consentPage(client.assistant, { ...q, csrf }));
    } catch (err) {
      replyOAuthError(reply, err);
    }
  });

  // Consent decision: authenticate the Supreme user, then redirect back with an authorization code.
  app.post<{ Body: Record<string, string> }>("/oauth/authorize/decision", async (req, reply) => {
    const b = req.body ?? {};
    try {
      // Brute-force / credential-stuffing guard on this unauthenticated, credential-bearing endpoint.
      if (!rateLimit.allow(req.ip)) {
        reply.code(429).send({ error: "rate_limited", error_description: "too many attempts" });
        return;
      }
      const client = opts.oauth.validateAuthorization({ clientId: b.client_id, redirectUri: b.redirect_uri, responseType: "code" });
      // CSRF: the decision must echo a valid, unexpired ticket minted by our own authorize page.
      if (!opts.oauth.verifyLinkingTicket(b.csrf, { clientId: b.client_id, redirectUri: b.redirect_uri })) {
        reply.code(403).send({ error: "invalid_request", error_description: "missing or invalid CSRF token" });
        return;
      }
      const identity = await opts.authenticateUser({ email: b.email ?? "", password: b.password ?? "" });
      if (!identity) {
        const csrf = opts.oauth.issueLinkingTicket({ clientId: client.clientId, redirectUri: b.redirect_uri! });
        reply.code(401).type("text/html").send(consentPage(client.assistant, { ...b, csrf }, "Invalid Supreme credentials"));
        return;
      }
      const code = opts.oauth.issueCode({ clientId: b.client_id ?? "", redirectUri: b.redirect_uri ?? "", identity });
      const url = new URL(b.redirect_uri ?? "");
      url.searchParams.set("code", code);
      if (b.state) url.searchParams.set("state", b.state);
      reply.redirect(url.toString(), 302);
    } catch (err) {
      replyOAuthError(reply, err);
    }
  });

  app.post<{ Body: Record<string, string> }>("/oauth/token", async (req, reply) => {
    const b = req.body ?? {};
    // Client may authenticate via Basic auth or body params (both are spec-allowed).
    const basic = parseBasicAuth(req.headers.authorization);
    try {
      const tokens = opts.oauth.exchange({
        grantType: b.grant_type,
        code: b.code,
        refreshToken: b.refresh_token,
        redirectUri: b.redirect_uri,
        clientId: basic?.id ?? b.client_id,
        clientSecret: basic?.secret ?? b.client_secret,
      });
      reply.header("cache-control", "no-store").send(tokens);
    } catch (err) {
      replyOAuthError(reply, err);
    }
  });

  // ── Alexa Smart Home ───────────────────────────────────────────────────────────────────────
  app.post<{ Body: AlexaDirective }>("/voice/alexa", async (req, reply) => {
    const directive = req.body;
    const ns = directive?.directive?.header?.namespace;
    const link = opts.oauth.resolve(alexaBearerToken(directive));

    if (ns === "Alexa.Discovery") {
      // Discovery never errors hard — an unlinked/again-linking account just sees no endpoints.
      const devices = link ? await safe(() => opts.hub.listDevices(link), []) : [];
      reply.send(buildDiscoveryResponse(devices));
      return;
    }
    // Proactive-reporting enrollment: store the grant on the link (the grantee token is in the
    // payload scope, not the endpoint scope, so resolve it explicitly here).
    if (ns === "Alexa.Authorization" && directive.directive.header.name === "AcceptGrant") {
      const payload = directive.directive.payload as { grant?: { code?: string }; grantee?: { token?: string } };
      const ok = opts.oauth.recordAcceptGrant(payload.grantee?.token, payload.grant?.code ?? "");
      reply.send(ok ? buildAcceptGrantResponse() : buildErrorResponse(directive, "INVALID_AUTHORIZATION_CREDENTIAL", "account not linked"));
      return;
    }
    if (!link) {
      reply.send(buildErrorResponse(directive, "INVALID_AUTHORIZATION_CREDENTIAL", "account not linked"));
      return;
    }
    const endpointId = directive.directive.endpoint?.endpointId;
    if (ns === "Alexa" && directive.directive.header.name === "ReportState") {
      const device = endpointId ? await opts.hub.getDevice(link, endpointId) : undefined;
      if (!device) {
        reply.send(buildErrorResponse(directive, "NO_SUCH_ENDPOINT", "unknown device"));
        return;
      }
      reply.send(buildReportStateResponse(directive, device, nowIso()));
      return;
    }
    const intent = alexaDirectiveToCanonical(directive);
    if (!intent || !endpointId) {
      reply.send(buildErrorResponse(directive, "INVALID_DIRECTIVE", "unsupported directive"));
      return;
    }
    try {
      const res = await opts.hub.command(link, endpointId, toHubCommand(intent));
      if (!res.ok) {
        reply.send(buildErrorResponse(directive, res.status === 403 ? "INSUFFICIENT_PERMISSIONS" : "ENDPOINT_UNREACHABLE", `hub returned ${res.status}`));
        return;
      }
      reply.send(buildControlResponse(directive, alexaOptimisticProperties(intent, nowIso())));
    } catch (err) {
      // Only surface the safe "hub offline" message; generic internal errors must not leak detail.
      const isHub = err instanceof HubUnavailableError;
      reply.send(buildErrorResponse(directive, hubErrorType(err), isHub ? (err as Error).message : "internal error"));
    }
  });

  // ── Google Smart Home ──────────────────────────────────────────────────────────────────────
  app.post<{ Body: GoogleRequest }>("/voice/google", async (req, reply) => {
    const body = req.body;
    const link = opts.oauth.resolve(bearerFromHeader(req.headers.authorization));
    const input = body?.inputs?.[0];
    if (!input) {
      reply.send({ requestId: body?.requestId, payload: { errorCode: "protocolError" } });
      return;
    }
    if (!link) {
      // Google expects 401 so it re-runs account linking.
      reply.code(401).send({ requestId: body.requestId, payload: { errorCode: "authFailure" } });
      return;
    }
    switch (input.intent) {
      case "action.devices.SYNC": {
        const devices = await safe(() => opts.hub.listDevices(link), []);
        reply.send(buildSyncResponse(body.requestId, link.accountId, devices));
        return;
      }
      case "action.devices.QUERY": {
        const ids = ((input.payload?.devices as { id: string }[] | undefined) ?? []).map((d) => d.id);
        const all = await safe(() => opts.hub.listDevices(link), []);
        const byId = new Map(all.map((d) => [d.id, d]));
        const states: Record<string, Record<string, unknown>> = {};
        for (const id of ids) {
          const dev = byId.get(id);
          states[id] = dev ? googleDeviceState(dev) : { online: false, status: "OFFLINE" };
        }
        reply.send(buildQueryResponse(body.requestId, states));
        return;
      }
      case "action.devices.EXECUTE": {
        const commands = (input.payload?.commands as GoogleExecCommand[] | undefined) ?? [];
        // Bound the fan-out: one request must not amplify into an unbounded number of hub calls.
        const totalOps = commands.reduce((n, c) => n + (c.devices?.length ?? 0) * (c.execution?.length ?? 0), 0);
        if (totalOps > MAX_EXECUTE_OPS) {
          reply.code(413).send({ requestId: body.requestId, payload: { errorCode: "protocolError" } });
          return;
        }
        const results = await executeGoogle(opts.hub, link, commands);
        reply.send(buildExecuteResponse(body.requestId, results));
        return;
      }
      case "action.devices.DISCONNECT": {
        opts.oauth.revoke(bearerFromHeader(req.headers.authorization));
        reply.send({});
        return;
      }
      default:
        reply.send({ requestId: body.requestId, payload: { errorCode: "notSupported" } });
    }
  });

  // ── Proactive state reporting ──────────────────────────────────────────────────────────────
  // The hub posts a local state change here (authenticated by its per-hub API key → homeId); we fan
  // it out as a proactive report to every assistant linked for that home.
  app.post<{ Body: { deviceId?: string; capability?: string; state?: Record<string, unknown> } }>("/v1/state", async (req, reply) => {
    const homeId = hubKeys.get(bearerFromHeader(req.headers.authorization) ?? "");
    if (!homeId) {
      reply.code(401).send({ code: "unauthorized" });
      return;
    }
    const b = req.body ?? {};
    if (!b.deviceId || !b.capability || typeof b.state !== "object") {
      reply.code(400).send({ code: "validation_failed", message: "deviceId, capability, state required" });
      return;
    }
    const delta: StateDelta = { deviceId: b.deviceId, capability: b.capability, state: b.state ?? {} };
    const delivered = await dispatchStateDelta({ links: opts.oauth.linksForHome(homeId), delta, notifier, nowIso: nowIso() });
    reply.send({ delivered });
  });

  return app;
}

interface GoogleExecCommand {
  devices: { id: string }[];
  execution: { command: string; params?: Record<string, unknown> }[];
}

/** Run a Google EXECUTE batch, grouping results by outcome as the protocol expects. */
async function executeGoogle(hub: HubRouter, link: LinkRecord, commands: GoogleExecCommand[]): Promise<GoogleCommandResult[]> {
  const success: string[] = [];
  const offline: string[] = [];
  const errors: string[] = [];
  for (const c of commands) {
    for (const exec of c.execution) {
      const intent = googleExecutionToCanonical(exec.command, exec.params ?? {});
      for (const d of c.devices) {
        if (!intent) {
          errors.push(d.id);
          continue;
        }
        try {
          const res = await hub.command(link, d.id, toHubCommand(intent));
          (res.ok ? success : errors).push(d.id);
        } catch (err) {
          (err instanceof HubUnavailableError ? offline : errors).push(d.id);
        }
      }
    }
  }
  const out: GoogleCommandResult[] = [];
  if (success.length) out.push({ ids: success, status: "SUCCESS" });
  if (offline.length) out.push({ ids: offline, status: "OFFLINE" });
  if (errors.length) out.push({ ids: errors, status: "ERROR", errorCode: "deviceTurnedOff" });
  return out;
}

const hubErrorType = (err: unknown) => (err instanceof HubUnavailableError ? "ENDPOINT_UNREACHABLE" : "INTERNAL_ERROR");

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function bearerFromHeader(authorization: string | undefined): string | undefined {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function parseBasicAuth(authorization: string | undefined): { id: string; secret: string } | undefined {
  if (!authorization?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  return { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
}

function replyOAuthError(reply: FastifyReply, err: unknown): void {
  if (err instanceof OAuthError) {
    reply.code(err.statusCode).send({ error: err.error, error_description: err.message });
    return;
  }
  // Never reflect an unexpected exception message to the caller — log server-side, return generic.
  reply.log?.error?.({ err }, "voice oauth error");
  reply.code(500).send({ error: "server_error", error_description: "internal error" });
}

/** Minimal Supreme-branded consent form (production replaces with the full design-system login). */
function consentPage(assistant: string, params: Record<string, string>, error?: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "response_type", "scope", "csrf"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k] ?? "")}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link Supreme</title></head>
<body style="font-family:system-ui;background:#0c0c0e;color:#f4efe6;max-width:380px;margin:60px auto;padding:24px">
<h1 style="color:#d4af37">Supreme</h1>
<p>Link your Supreme home to ${escapeHtml(assistant)}.</p>
${error ? `<p style="color:#e06b6b">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize/decision">
${hidden}
<label>Email<br><input name="email" type="email" required style="width:100%"></label><br><br>
<label>Password<br><input name="password" type="password" required style="width:100%"></label><br><br>
<button type="submit" style="background:#d4af37;border:0;padding:10px 18px;border-radius:8px">Link</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Tiny in-memory fixed-window rate limiter. (A multi-instance deploy would back this with Redis.) */
class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly opts: { now: () => number; windowMs: number; max: number }) {}
  allow(key: string): boolean {
    const t = this.opts.now();
    const bucket = this.buckets.get(key);
    if (!bucket || t - bucket.windowStart >= this.opts.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: t });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.opts.max;
  }
}
