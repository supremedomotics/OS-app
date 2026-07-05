import { WebSocket } from "ws";

/**
 * Headless Home Assistant provisioner (blueprint §7, §8) — makes HA truly invisible.
 *
 * On first boot the hub onboards HA with NO human in the loop: it creates the single
 * hidden internal owner account, completes onboarding, and mints a long-lived access
 * token via the authenticated WS API. The token is the ONLY HA credential the system
 * keeps; it's handed back to the boot edge to store in the secrets manager and inject
 * into the SIL transport. Installers and homeowners never see HA, never log into it,
 * and never edit `.env` to supply a token.
 *
 * Everything here is confined below the SIL boundary (the `ha/` folder), so no HA
 * onboarding detail leaks upward. HTTP + WS are injectable for tests.
 */
export interface HaProvisionerOptions {
  /** HA HTTP base, e.g. "http://homeassistant:8123". */
  httpUrl: string;
  /** HA WebSocket URL, e.g. "ws://homeassistant:8123/api/websocket". */
  wsUrl: string;
  /** Hidden internal account the gateway uses to reach HA. */
  adminUsername: string;
  adminPassword: string;
  /** Friendly system name + locale used to complete onboarding's core config. */
  systemName?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  language?: string;
  /** Long-lived token lifespan in days (default 3650 ≈ 10y). */
  lifespanDays?: number;
  fetchImpl?: typeof fetch;
  /** Injectable WS constructor (tests); defaults to the real `ws` client. */
  wsCtor?: new (url: string) => WebSocket;
}

interface OnboardingStep {
  step: string;
  done: boolean;
}

/**
 * Provision (or detect) HA and return a long-lived token.
 *  - Returns `{ token, created }` on success (`created=true` when we onboarded HA now).
 *  - Returns `null` when HA onboarding is ALREADY complete (a prior owner exists) and we
 *    therefore cannot create the internal account — the caller must fall back to a
 *    supplied/stored token.
 */
export async function provisionHaToken(
  opts: HaProvisionerOptions,
): Promise<{ token: string; created: boolean } | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const http = opts.httpUrl.replace(/\/$/, "");
  const clientId = `${http}/`;
  const language = opts.language ?? "en";

  const steps = (await getJson(fetchImpl, `${http}/api/onboarding`)) as OnboardingStep[] | null;
  const userDone = Array.isArray(steps) && steps.find((s) => s.step === "user")?.done;
  if (userDone) {
    // HA already has an owner — we can't (and must not) create another. Caller falls back.
    return null;
  }

  // 1. Create the hidden internal owner account → short-lived auth code.
  const userRes = await fetchImpl(`${http}/api/onboarding/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      name: "Supreme Internal",
      username: opts.adminUsername,
      password: opts.adminPassword,
      language,
    }),
  });
  if (!userRes.ok) throw new Error(`HA onboarding/users failed: ${userRes.status}`);
  const authCode = ((await userRes.json()) as { auth_code?: string }).auth_code;
  if (!authCode) throw new Error("HA onboarding returned no auth_code");

  // 2. Exchange the auth code for an access token (OAuth2 form-encoded).
  const tokenRes = await fetchImpl(`${http}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      client_id: clientId,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`HA auth/token failed: ${tokenRes.status}`);
  const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!accessToken) throw new Error("HA auth/token returned no access_token");

  // 3. Best-effort: finish the remaining onboarding steps so HA is fully initialized and
  //    its setup UI can never reappear. Failures here are non-fatal (token already works).
  await completeOnboarding(fetchImpl, http, clientId, accessToken, opts);

  // 4. Mint a long-lived access token over the authenticated WS API.
  const token = await mintLongLivedToken(
    opts.wsUrl,
    accessToken,
    opts.systemName ? `Supreme Gateway (${opts.systemName})` : "Supreme Gateway",
    opts.lifespanDays ?? 3650,
    opts.wsCtor,
  );
  return { token, created: true };
}

async function completeOnboarding(
  fetchImpl: typeof fetch,
  http: string,
  clientId: string,
  accessToken: string,
  opts: HaProvisionerOptions,
): Promise<void> {
  const auth = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => {
    try {
      await fetchImpl(`${http}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    } catch {
      // non-fatal — the token is already valid; remaining steps are cosmetic.
    }
  };
  await post("/api/onboarding/core_config", {
    client_id: clientId,
    location_name: opts.systemName ?? "Supreme Residence",
    ...(opts.latitude !== undefined ? { latitude: opts.latitude } : {}),
    ...(opts.longitude !== undefined ? { longitude: opts.longitude } : {}),
    ...(opts.timeZone ? { time_zone: opts.timeZone } : {}),
  });
  await post("/api/onboarding/analytics", { client_id: clientId });
  await post("/api/onboarding/integration", { client_id: clientId, redirect_uri: clientId });
}

/** Open a WS, authenticate with the access token, and request a long-lived token. */
function mintLongLivedToken(
  wsUrl: string,
  accessToken: string,
  clientName: string,
  lifespanDays: number,
  wsCtor: (new (url: string) => WebSocket) | undefined,
): Promise<string> {
  const Ctor = wsCtor ?? WebSocket;
  return new Promise<string>((resolve, reject) => {
    const ws = new Ctor(wsUrl);
    const id = 1;
    let settled = false;
    const done = (err: Error | null, token?: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(token!);
    };
    const timer = setTimeout(() => done(new Error("HA long-lived token request timed out")), 15000);
    (timer as { unref?: () => void }).unref?.();

    ws.on("message", (raw: { toString(): string }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
      } else if (msg.type === "auth_ok") {
        ws.send(
          JSON.stringify({ id, type: "auth/long_lived_access_token", client_name: clientName, lifespan: lifespanDays }),
        );
      } else if (msg.type === "auth_invalid") {
        clearTimeout(timer);
        done(new Error(`HA auth failed during provisioning: ${String(msg.message ?? "")}`));
      } else if (msg.type === "result" && msg.id === id) {
        clearTimeout(timer);
        if (msg.success && typeof msg.result === "string") done(null, msg.result);
        else done(new Error(`HA long-lived token request failed: ${JSON.stringify(msg.error ?? msg)}`));
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      done(err);
    });
  });
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Derive the HA HTTP base from its WS URL (ws://host:8123/api/websocket → http://host:8123). */
export function haHttpFromWsUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/api\/websocket\/?$/, "");
}
