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

// ── Developer Edition tools (authenticated) ────────────────────────────────────────
/** Generic authenticated request — powers the developer API Explorer. */
export async function apiRequest(method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> {
  const res = await authed(path.startsWith("/") ? path : `/${path}`, { method, ...(body && method !== "GET" ? { body } : {}) });
  let parsed: unknown = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}
/** The authenticated WebSocket stream URL (for the developer WS inspector). */
export function streamUrl(): string | null {
  return client.accessToken ? `${wsBaseUrl}/v1/stream?access_token=${client.accessToken}` : null;
}

// ── Driver Framework (authenticated) ──────────────────────────────────────────────
export interface DriverConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "select" | "host" | "port";
  required: boolean;
  default?: unknown;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  secret: boolean;
}
export interface DriverEntry {
  key: string;
  name: string;
  description: string;
  category: string;
  channel: string;
  version: string;
  publisher: string;
  capabilities: string[];
  protocols: string[];
  requiresSku: string | null;
  configSchema: DriverConfigField[];
  dependencies: string[];
  operations: string[];
  installed: boolean;
  enabled: boolean;
  status: string;
  installedId: string | null;
  config: Record<string, unknown>;
}

export async function fetchDriverRegistry(): Promise<DriverEntry[]> {
  try {
    const res = await authed("/v1/drivers/registry");
    return res.ok ? ((await res.json()) as { drivers: DriverEntry[] }).drivers : [];
  } catch {
    return [];
  }
}
export async function getDriverConfig(id: string): Promise<{ schema: DriverConfigField[]; config: Record<string, unknown> }> {
  const res = await authed(`/v1/drivers/${id}/config`);
  if (!res.ok) throw new Error(await errorMessage(res, "Could not load config."));
  return (await res.json()) as { schema: DriverConfigField[]; config: Record<string, unknown> };
}
export async function setDriverConfig(id: string, config: Record<string, unknown>): Promise<void> {
  const res = await authed(`/v1/drivers/${id}/config`, { method: "PUT", body: JSON.stringify({ config }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not save config."));
}
export async function fetchDriverHealth(id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await authed(`/v1/drivers/${id}/health`);
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
export async function fetchDriverLogs(id: string): Promise<{ ts: string; level: string; message: string }[]> {
  try {
    const res = await authed(`/v1/drivers/${id}/logs`);
    return res.ok ? ((await res.json()) as { entries: { ts: string; level: string; message: string }[] }).entries : [];
  } catch {
    return [];
  }
}
export async function connectDriver(id: string, connect: boolean): Promise<void> {
  await authed(`/v1/drivers/${id}/${connect ? "connect" : "disconnect"}`, { method: "POST", body: "{}" });
}
export async function installDriverByKey(key: string): Promise<void> {
  const res = await authed("/v1/drivers/install", { method: "POST", body: JSON.stringify({ key }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Install failed."));
}
export async function setDriverEnabled(id: string, enabled: boolean): Promise<void> {
  await authed(`/v1/drivers/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}
export async function uninstallDriver(id: string): Promise<void> {
  await authed(`/v1/drivers/${id}`, { method: "DELETE" });
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

/** Activate a signed license (pasted token or imported .slic file). */
export async function activateLicense(token: unknown): Promise<LicenseInfo> {
  const res = await authed("/v1/license/activate", { method: "POST", body: JSON.stringify({ token }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Activation failed — the license is invalid or for another hub."));
  return (await res.json()) as LicenseInfo;
}

/** Issue a signed license locally (dev/test only) and return its token. */
export async function devIssueLicense(sku: string): Promise<unknown> {
  const res = await authed("/v1/license/dev-issue", { method: "POST", body: JSON.stringify({ sku }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not issue a test license."));
  return ((await res.json()) as { token: unknown }).token;
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
