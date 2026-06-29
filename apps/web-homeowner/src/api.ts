import { MemoryTokenStore, SupremeClient, SupremeStream } from "@supreme/sdk";

/**
 * The single Supreme API client for the homeowner web app. The app binds to the
 * Supreme contract only — it has no concept of Home Assistant. The hub base URL is
 * resolved from the environment (LAN-direct in the home; cloud relay when remote).
 */
export const baseUrl = import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080";
const wsBaseUrl = baseUrl.replace(/^http/, "ws");

export const client = new SupremeClient({ baseUrl, tokenStore: new MemoryTokenStore() });

// ── Unauthenticated onboarding + account-recovery endpoints ─────────────────────
// These are first-run / pre-login flows the SDK doesn't model; small fetch helpers
// keep the app bound to the Supreme contract (still zero Home Assistant awareness).
async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string };
    return j.message ?? fallback;
  } catch {
    return fallback;
  }
}

export interface SetupStatus {
  setupRequired: boolean;
  systemName: string;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  try {
    const res = await fetch(`${baseUrl}/v1/setup/status`);
    if (!res.ok) return { setupRequired: false, systemName: "" };
    return (await res.json()) as SetupStatus;
  } catch {
    return { setupRequired: false, systemName: "" };
  }
}

export interface SetupInput {
  username: string;
  password: string;
  confirmPassword: string;
  systemName: string;
  location?: string;
  timeZone?: string;
}

export async function completeSetup(input: SetupInput): Promise<void> {
  const res = await postJson("/v1/setup", input);
  if (!res.ok) throw new Error(await errorMessage(res, "Setup could not be completed."));
}

export async function forgotPassword(email: string): Promise<{ resetToken?: string }> {
  const res = await postJson("/v1/auth/forgot-password", { email });
  return res.ok ? ((await res.json()) as { resetToken?: string }) : {};
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const res = await postJson("/v1/auth/reset-password", { token, newPassword });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not reset the password."));
}

// ── Licensing (authenticated) ────────────────────────────────────────────────────
export interface LicenseService {
  active: boolean;
  devMode: boolean;
  licenseType: string;
  tier: string;
  skus: string[] | "all";
  features: string[] | "all";
  expiresAt: string | null;
  source: string;
  sources: string[];
}
export interface LicenseInfo {
  licensed: boolean;
  skus: string[];
  features: string[];
  service?: LicenseService;
}

export async function fetchLicense(): Promise<LicenseInfo | null> {
  try {
    const res = await authed("/v1/license");
    return res.ok ? ((await res.json()) as LicenseInfo) : null;
  } catch {
    return null;
  }
}

export async function setDevMode(enabled: boolean): Promise<LicenseInfo> {
  const res = await authed("/v1/license/dev-mode", { method: "POST", body: JSON.stringify({ enabled }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not change Developer Mode."));
  return (await res.json()) as LicenseInfo;
}

// ── Automations (authenticated) ─────────────────────────────────────────────────
async function authed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${client.accessToken ?? ""}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

export interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  triggers: { type: string; capability?: string; field?: string; at?: string; everyMinutes?: number }[];
  conditions: { type: string }[];
  actions: { type: string }[];
}

export async function fetchAutomations(): Promise<AutomationView[]> {
  try {
    const res = await authed("/v1/automations");
    return res.ok ? ((await res.json()) as { automations: AutomationView[] }).automations : [];
  } catch {
    return [];
  }
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
  await authed(`/v1/automations/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export async function runAutomation(id: string): Promise<void> {
  await authed(`/v1/automations/${id}/run`, { method: "POST", body: "{}" });
}

export async function createAutomation(body: {
  name: string;
  triggers: unknown[];
  conditions: unknown[];
  actions: unknown[];
}): Promise<boolean> {
  const res = await authed("/v1/automations", { method: "POST", body: JSON.stringify(body) });
  return res.ok;
}

/** Open the realtime WSS stream once authenticated (live device state + notifications). */
export function openStream(): SupremeStream | null {
  const token = client.accessToken;
  if (!token) return null;
  return new SupremeStream(wsBaseUrl, token, WebSocket as unknown as never);
}
