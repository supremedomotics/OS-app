import { SupremeClient, SupremeStream } from "@supreme/sdk";
import type { SystemLogEntry } from "@supreme/contracts";
export type { SystemLogEntry } from "@supreme/contracts";
import { activeHome, homeTokenStore } from "./homes.js";

/**
 * The Supreme API client for the homeowner web app. The app binds to the Supreme contract only — it
 * has no concept of Home Assistant. The hub base URL is the ACTIVE home's base URL (multi-home, §16):
 * resolved from the local home registry, which seeds from the build-time URL on first run. Switching
 * homes writes the registry and reloads, so this re-resolves to the new hub. Each home keeps its own
 * persisted session (homeTokenStore), so a switch doesn't force a re-login.
 */
export const baseUrl = activeHome().baseUrl;
const wsBaseUrl = baseUrl.replace(/^http/, "ws");

// The SDK refreshes an expired access token silently and retries — this only fires when the refresh
// token itself is dead (30-day expiry, or revoked elsewhere), i.e. the session is genuinely over.
const sessionExpiredListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export const client = new SupremeClient({
  baseUrl,
  tokenStore: homeTokenStore(),
  onSessionExpired: () => { for (const l of sessionExpiredListeners) l(); },
});

/** Explicit "Log Out": revokes the session server-side (best-effort — still logs out
 * locally even if the hub is unreachable), then drops the app back to the login screen
 * via the same listeners a session-expiry uses. */
export async function logOut(): Promise<void> {
  await client.logout().catch(() => {});
  for (const l of sessionExpiredListeners) l();
}

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
  hubMinVersion?: string;
  documentationUrl?: string | null;
  releaseNotes?: string;
  changelog?: { version: string; date: string; notes: string }[];
  installedVersion?: string | null;
  updateAvailable?: boolean;
  shipsDisabled?: boolean;
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
/** Settings → Logs: every driver install/enable/connect/native-connection event plus device
 * control operation outcomes, in one unified stream. */
export async function fetchSystemLogs(limit = 300): Promise<SystemLogEntry[]> {
  try {
    const res = await authed(`/v1/system/logs?limit=${limit}`);
    return res.ok ? ((await res.json()) as { entries: SystemLogEntry[] }).entries : [];
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
/** Update an installed driver to the latest catalog version (§ Extension Center). */
export async function updateDriverByKey(key: string): Promise<void> {
  const res = await authed(`/v1/drivers/${key}/update`, { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(await errorMessage(res, "Update failed."));
}
export async function uninstallDriver(id: string): Promise<void> {
  await authed(`/v1/drivers/${id}`, { method: "DELETE" });
}

// ── KNX ETS project import (authenticated) ────────────────────────────────────────
export interface KnxImportResult {
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
}
async function postKnxImport(body: Record<string, string>): Promise<KnxImportResult> {
  const res = await authed("/v1/commissioning/import/knx", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorMessage(res, "Import failed"));
  return (await res.json()) as KnxImportResult;
}
/** Import an ETS group-address export (CSV/XML text) → auto-created device cards (§4). */
export const importKnx = (content: string): Promise<KnxImportResult> => postKnxImport({ content });
/**
 * Import a `.knxproj` file (base64) → device cards placed in their ETS rooms (§4).
 * `password` is required only for ETS6 password-protected projects (WinZip-AES).
 */
export const importKnxProject = (base64: string, password?: string): Promise<KnxImportResult> =>
  postKnxImport(password ? { knxproj: base64, password } : { knxproj: base64 });

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

/** One execution trace for the Automation Debugger. */
export interface AutomationRunView {
  id: string;
  automationId: string;
  startedAt: string;
  trigger: string;
  conditionsPassed: boolean;
  failedCondition?: string;
  actions: { type: string; ok: boolean; error?: string; durationMs: number; summary: string }[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

/** Recent execution traces (§ Automation Debugger) — all automations, or one by id. */
export async function fetchAutomationRuns(id?: string): Promise<AutomationRunView[]> {
  try {
    const res = await authed(id ? `/v1/automations/${id}/runs` : "/v1/automations/runs");
    return res.ok ? ((await res.json()) as { runs: AutomationRunView[] }).runs : [];
  } catch {
    return [];
  }
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

// ── Advanced automation & energy configuration (authenticated) ──────────────────────
// These surface hub functions that were previously API-only: circadian lighting, the climate
// schedule, adaptive ventilation, the energy tariff / provider, and peak load-shifting.
async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await authed(path);
    return res.ok ? ((await res.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await authed(path, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not save."));
  return (await res.json()) as T;
}

export interface CircadianTarget { kelvin: number; brightness: number }
export const getCircadian = () => getJson<{ target: CircadianTarget; atLocalMinute: number } | null>("/v1/lighting/circadian", null);
export async function applyCircadian(roomId?: string): Promise<{ applied: string[] }> {
  const res = await authed("/v1/lighting/circadian/apply", { method: "POST", body: JSON.stringify(roomId ? { roomId } : {}) });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not apply circadian lighting."));
  return (await res.json()) as { applied: string[] };
}

export interface ClimateBlock { atMinutes: number; targetC: number }
export interface ClimateProgram { weekday: ClimateBlock[]; weekend: ClimateBlock[] }
export const getClimateProgram = () => getJson<{ program: ClimateProgram | null }>("/v1/climate/program", { program: null });
export const setClimateProgram = (program: ClimateProgram) => putJson<{ program: ClimateProgram }>("/v1/climate/program", { program });

export interface VentilationConfig { sensorDeviceId: string; fanDeviceId: string; highThreshold?: number; lowThreshold?: number }
export const getVentilation = () => getJson<{ config: VentilationConfig | null; fanOn: boolean }>("/v1/ventilation/config", { config: null, fanOn: false });
export const setVentilation = (config: VentilationConfig) => putJson<{ config: VentilationConfig }>("/v1/ventilation/config", { config });

export interface TariffPeriod { name: string; ratePerKwh: number; hours: number[] }
export interface Tariff { currency: string; standingChargePerDay?: number; periods: TariffPeriod[] }
export const getTariff = () => getJson<{ tariff: Tariff | null }>("/v1/energy/tariff", { tariff: null });
export const setTariff = (tariff: Tariff) => putJson<{ tariff: Tariff }>("/v1/energy/tariff", { tariff });

export interface EnergyProvider { country?: string; city?: string; provider?: string; ratePerKwh?: number; currency?: string }
export const getEnergyProvider = () => getJson<{ provider: EnergyProvider | null }>("/v1/energy/provider", { provider: null });
export const setEnergyProvider = (p: EnergyProvider) => putJson<{ provider: EnergyProvider }>("/v1/energy/provider", p);

export interface DeviceLite { id: string; name: string; roomId?: string | null; capabilities: { kind: string }[] }
export const getAllDevices = () => getJson<{ devices: DeviceLite[] }>("/v1/devices", { devices: [] });

// ── Audit log (admin, read-only) ────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  seq: number;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  entryHash: string;
}
export async function fetchAudit(): Promise<{ entries: AuditEntry[]; error?: string }> {
  try {
    const res = await authed("/v1/audit");
    if (res.ok) return (await res.json()) as { entries: AuditEntry[] };
    return { entries: [], error: await errorMessage(res, `${res.status}`) };
  } catch {
    return { entries: [], error: "Could not load the audit log." };
  }
}
export async function verifyAudit(): Promise<{ valid: boolean; brokenAt?: number } | null> {
  try {
    const res = await authed("/v1/audit/verify");
    return res.ok ? ((await res.json()) as { valid: boolean; brokenAt?: number }) : null;
  } catch {
    return null;
  }
}

export const getDeferrableLoads = () => getJson<{ deviceIds: string[]; pausedNow: string[] }>("/v1/energy/deferrable-loads", { deviceIds: [], pausedNow: [] });
export const setDeferrableLoads = (deviceIds: string[], ceiling?: number) => putJson<{ deviceIds: string[] }>("/v1/energy/deferrable-loads", ceiling !== undefined ? { deviceIds, ceiling } : { deviceIds });

/** Open the realtime WSS stream once authenticated (live device state + notifications). */
export function openStream(): SupremeStream | null {
  const token = client.accessToken;
  if (!token) return null;
  return new SupremeStream(wsBaseUrl, token, WebSocket as unknown as never);
}
