import { SupremeClient, SupremeStream } from "@supreme/sdk";
import type { DeviceCapabilitiesRefreshResponse, DeviceDriverDiagnostics, DeviceTraceEntry, SystemLogEntry } from "@supreme/contracts";
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
/** Diagnostics Console (§ Universal AV Driver SDK): real connection/traffic
 * diagnostics from a device's owning driver — null when unsupported (HA-backed device,
 * or a protocol with no diagnostics tracker), never a fabricated all-zero shape. */
export async function fetchDeviceDiagnostics(deviceId: string): Promise<DeviceDriverDiagnostics | null> {
  try {
    const res = await authed(`/v1/devices/${deviceId}/diagnostics`);
    return res.ok ? ((await res.json()) as { diagnostics: DeviceDriverDiagnostics | null }).diagnostics : null;
  } catch {
    return null;
  }
}
/** § Universal AVR SDK — the device's owning driver's recent raw protocol trace (every
 * real send/receive line, automatically captured). `null` when unsupported, same
 * "never a fabricated placeholder" posture as `fetchDeviceDiagnostics`. */
export async function fetchDeviceTrace(deviceId: string): Promise<DeviceTraceEntry[] | null> {
  try {
    const res = await authed(`/v1/devices/${deviceId}/diagnostics/trace`);
    return res.ok ? ((await res.json()) as { trace: DeviceTraceEntry[] | null }).trace : null;
  } catch {
    return null;
  }
}
/** § RTI Capability Audit, Category C.4 — POST /v1/devices/:id/raw-command: devMode-only
 * raw-token escape hatch. Writes `token` verbatim to the device's owning driver,
 * bypassing the typed capability-command dispatch entirely. Throws on any failure
 * (including a device whose driver doesn't support this at all — 422) so the caller
 * can surface a real error rather than silently doing nothing. */
export async function sendRawDeviceCommand(deviceId: string, token: string): Promise<void> {
  const res = await authed(`/v1/devices/${deviceId}/raw-command`, { method: "POST", body: JSON.stringify({ token }) });
  if (!res.ok) throw new Error(await errorMessage(res, "Raw command failed."));
}
/** § Capability Refresh — POST /v1/devices/:id/capabilities/refresh: re-query the
 * device's owning driver in place and persist whatever fresh AudioCapabilityConfig it
 * reports. `refreshed: false` is an honest, non-error outcome for a protocol with no
 * live capability query (e.g. classic Denon/Marantz Telnet) — never recreates the
 * device, never touches room assignment/automations/history. Throws on a genuine
 * network/server failure so the caller can show a real error instead of silently
 * doing nothing. */
export async function refreshDeviceCapabilities(deviceId: string): Promise<DeviceCapabilitiesRefreshResponse> {
  const res = await authed(`/v1/devices/${deviceId}/capabilities/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to refresh capabilities (${res.status})`);
  return (await res.json()) as DeviceCapabilitiesRefreshResponse;
}
export interface DriverHealth {
  key: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  status: string;
  configComplete: boolean;
  missing: string[];
  /** Real native-protocol connection state — null when this driver has no live
   * protocol instance to check against (e.g. not currently registered), never a
   * guess. See {@link statusLabel} — this is what tells "installed and enabled" apart
   * from "actually connected to the bus/gateway right now". */
  connected: boolean | null;
  connectError: string | null;
  verdict: "disabled" | "error" | "not_configured" | "healthy";
  logCount: number;
}
export async function fetchDriverHealth(id: string): Promise<DriverHealth | null> {
  try {
    const res = await authed(`/v1/drivers/${id}/health`);
    return res.ok ? ((await res.json()) as DriverHealth) : null;
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

/** A KNX/IP interface found by real KNXnet/IP SEARCH_REQUEST discovery (§ Gateway Auto
 * Discovery) — real fields only; `tunnellingCapable`/`routingCapable` are null when the
 * response carried no SUPP_SVC_FAMILIES DIB, never guessed. */
export interface KnxGateway {
  address: string;
  port: number;
  individualAddress: string;
  name: string;
  multicastAddress?: string;
  macAddress?: string;
  tunnellingCapable: boolean | null;
  routingCapable: boolean | null;
}
/** Scans the LAN for KNX/IP interfaces (§ Gateway Auto Discovery) — the existing
 * `knxSearch()` backend, reused as-is; this is the only client-side entry point for it. */
export async function discoverKnxGateways(): Promise<KnxGateway[]> {
  const res = await authed("/v1/commissioning/knx/interfaces");
  if (!res.ok) throw new Error(await errorMessage(res, "Gateway discovery failed."));
  return ((await res.json()) as { interfaces: KnxGateway[] }).interfaces;
}

// ── Casambi Driver Refactor — Foundation (authenticated) ──────────────────────────
/** One entry in the bounded UDP protocol trace (§ UDP Receive Pipeline Audit) — recorded for
 * every datagram received, parsed or not, so a real capture (e.g. Wireshark) can be cross-checked
 * against what SupremeOS actually saw at the socket layer. */
export interface CasambiUdpPacketTrace {
  at: string;
  sourceAddress: string;
  sourcePort: number;
  destinationPort: number | null;
  payloadLength: number;
  rawAscii: string;
  rawHex: string;
  decoded: { netId: number; direction: string; opcode: number; args: number[] } | null;
  parseError: string | null;
}
/** Real, non-fabricated UDP transport detail — Local mode only (§ UDP Diagnostics). `null`
 * fields mean "not yet measured." No `packetLoss` field exists: the documented Casambi UDP
 * packet structure carries no sequence numbers, so ongoing loss cannot be computed honestly. */
export interface CasambiUdpDetail {
  stage: "not_configured" | "socket_error" | "bound_waiting" | "active";
  socketState: "closed" | "bound" | "error";
  localAddress: string | null;
  localPort: number | null;
  remoteAddress: string;
  remotePort: number;
  packetsSent: number;
  packetsReceived: number;
  lastPacketAt: string | null;
  averageLatencyMs: number | null;
  lastSendError: string | null;
  lastDecodeError: { raw: string; message: string; at: string } | null;
  recentTraces: CasambiUdpPacketTrace[];
}
/** The dedicated Casambi Diagnostics page's snapshot — driver-level, not per-device. */
export interface CasambiDiagnostics {
  connectionType: "cloud" | "local";
  gateway: string | null;
  latencyMs: number | null;
  entities: number;
  onlineDevices: number;
  offlineDevices: number;
  reconnectCount: number;
  lastEventAt: string | null;
  restStatus: "connected" | "disconnected" | "not_configured" | "not_implemented";
  udpStatus: "connected" | "disconnected" | "not_configured" | "not_implemented";
  health: "healthy" | "degraded" | "error" | "not_implemented";
  udp: CasambiUdpDetail | null;
}
export async function fetchCasambiDiagnostics(driverId: string): Promise<CasambiDiagnostics | null> {
  try {
    const res = await authed(`/v1/drivers/${driverId}/casambi/diagnostics`);
    return res.ok ? ((await res.json()) as CasambiDiagnostics) : null;
  } catch {
    return null;
  }
}
/**
 * § Runtime Data Path Verification — the full receive-path evidence bundle: eleven instrumented
 * pipeline stages, the automatic root-cause verdict, the Wireshark comparison, and the
 * seven-section certification report.
 *
 * `wiresharkPackets` is the one number SupremeOS genuinely cannot observe about itself — how many
 * packets a host-side capture saw over the same window. Passing it resolves the one case where two
 * mutually exclusive causes ("the gateway is silent" vs "the packets never reach this network
 * namespace") produce byte-identical counters; omitting it leaves the verdict honestly `unknown`.
 */
export interface ReceiveStageMetrics {
  entered: number | null;
  exited: number | null;
  failures: number | null;
  firstAt: string | null;
  lastAt: string | null;
  latencyMs: number | null;
  unmeasured: string | null;
}
export interface ReceivePipelineStage {
  name: string;
  status: "pass" | "fail" | "waiting";
  detail?: string;
  metrics?: ReceiveStageMetrics;
}
export interface ReceiveCertification {
  generatedAt: string;
  sections: { name: string; status: "pass" | "fail" | "not_evaluated"; detail: string }[];
  rootCause: { cause: string; summary: string; evidence: string[]; needed: string | null };
  wireshark: { wiresharkPackets: number | null; socketPackets: number | null; difference: number | null; stageWherePacketsDisappear: string; captureFilter: string | null };
  stages: ReceivePipelineStage[];
  certified: boolean;
  lanQueryError: string | null;
}

export async function fetchCasambiReceivePipeline(driverId: string, wiresharkPackets?: number): Promise<ReceiveCertification | null> {
  try {
    const q = typeof wiresharkPackets === "number" && Number.isInteger(wiresharkPackets) && wiresharkPackets >= 0 ? `?wiresharkPackets=${wiresharkPackets}` : "";
    const res = await authed(`/v1/drivers/${driverId}/casambi/receive-pipeline${q}`);
    return res.ok ? ((await res.json()) as ReceiveCertification) : null;
  } catch {
    return null;
  }
}

/** Local Gateway setup wizard — "Test Connection" params, matching the Local Gateway config
 * fields on the manifest (`gatewayIp`/`restPort`/`udpPort`/`netId`/`dataFormat`/gateway login). */
export interface CasambiTestConnectionParams {
  gatewayIp: string;
  restPort: number;
  udpPort: number;
  netId?: number;
  dataFormat?: "hex-dot" | "dec-hash";
  gatewayUsername?: string;
  gatewayPassword?: string;
}
/** Staged, honest Test Connection result (§ UDP Diagnostics — "do not assume UDP behaves like
 * TCP"). REST and UDP are reported as independent, structured facts rather than a single
 * reachable/unreachable boolean. */
export interface CasambiTestConnectionResult {
  implemented: true;
  rest: {
    reachable: boolean;
    httpStatus: number | null;
    authFailed: boolean | null;
  };
  udp: {
    socketCreated: boolean;
    socketBound: boolean;
    packetSent: boolean;
    localAddress: string | null;
    localPort: number | null;
    remoteAddress: string | null;
    remotePort: number | null;
    notificationReceived: boolean;
    packetsReceived: number;
    averageLatencyMs: number | null;
    lastError: string | null;
    recentTraces: CasambiUdpPacketTrace[];
  };
  message: string;
}
export async function testCasambiLocalConnection(params: CasambiTestConnectionParams): Promise<CasambiTestConnectionResult> {
  const res = await authed("/v1/commissioning/casambi/test-connection", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Test connection failed."));
  return (await res.json()) as CasambiTestConnectionResult;
}
/** Gateway auto-discovery honestly reports `implemented: false` — no discovery endpoint is
 * documented for the Lithernet Gateway; never a fabricated success. */
export interface CasambiNotImplementedResult {
  implemented: false;
  message: string;
}
export async function discoverCasambiLocalGateway(): Promise<CasambiNotImplementedResult & { gateways: unknown[] }> {
  const res = await authed("/v1/commissioning/casambi/discover-gateway", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(await errorMessage(res, "Gateway discovery failed."));
  return (await res.json()) as CasambiNotImplementedResult & { gateways: unknown[] };
}

// ── Supreme KNX Unified Device Intelligence — Discovery Queue (authenticated) ─────
// Real backend shapes (services/gateway/src/installer-context.ts) — no new fields
// invented here, only what the Confidence/Duplicate/Binding/Room-Assignment engines
// already compute and the queue endpoint already returns.
export interface KnxDeviceClassification {
  category: string;
  type: string;
  canonicalDetailPage: string;
  icon: string;
  automationCategory: string;
  confidence: number;
  reason: string;
  matchedKeyword: string | null;
}
export interface KnxUnifiedDevice {
  backendId: string;
  suggestedName: string;
  capabilities: string[];
  raw: {
    deviceKind: string;
    metadata: { room: string | null; manufacturer: string | null; model: string | null; deviceName: string | null };
    mergeExplanation: string[];
    sourceHrefs: string[];
    groupingKey: string;
    communicationObjects: { id: string; name: string; source: "knx_iot" | "ets" }[];
    /** Universal Device Intelligence Engine output (§ Universal Device Intelligence Engine) — protocol-agnostic classification, not KNX-specific. */
    classification: KnxDeviceClassification;
  };
}
export interface KnxConfidenceScores {
  name: number; room: number; capability: number; grouping: number; manufacturer: number; model: number; overall: number;
}
export interface KnxRoomAssignment { room: string | null; source: string; reason: string }
export interface KnxDuplicateCheck { decision: "new" | "merge" | "update" | "ignore" | "ask_installer"; reason: string; matchedOn: string | null }
export interface KnxBindingPlan { capability: string; address: string | null; config: Record<string, unknown>; bindable: boolean; reason: string }
export type KnxQueueSection = "ready" | "needs_review" | "duplicates" | "conflicts";
export interface KnxInstallerQueueItem {
  device: KnxUnifiedDevice;
  confidence: KnxConfidenceScores;
  room: KnxRoomAssignment;
  duplicate: KnxDuplicateCheck;
  plans: KnxBindingPlan[];
  section: KnxQueueSection;
}
export interface KnxDiscoverySummary {
  totalGroupAddresses: number;
  communicationObjects: number;
  circuitsCreated: number;
  devicesCreated: number;
  duplicateCircuits: number;
  unsupportedObjects: number;
  needsReviewCount: number;
  readyCount: number;
  discoveryDurationMs: number;
  groupAddressSchema: string;
}
/** Runs the full Unified Device Intelligence pipeline (§ discoverUnified -> Confidence
 * -> Room Assignment -> Duplicate Detection -> Binding Engine) — the same backend used
 * by Driver Settings, reused as-is; this is only the client entry point for it. */
export async function knxDiscoveryQueue(ets?: { content?: string; knxproj?: string; password?: string }): Promise<{ queue: KnxInstallerQueueItem[]; summary: KnxDiscoverySummary }> {
  const res = await authed("/v1/commissioning/knx/queue", { method: "POST", body: JSON.stringify(ets ?? {}) });
  if (!res.ok) throw new Error(await errorMessage(res, "Discovery failed."));
  return (await res.json()) as { queue: KnxInstallerQueueItem[]; summary: KnxDiscoverySummary };
}

// ── Non-blocking counterpart (§ Pass 11.2) — same inputs, returns a jobId immediately
// instead of awaiting the whole parse/synthesize/classify pipeline on this request.
// This is the path the production "Discover devices" button uses; `knxDiscoveryQueue`
// above is kept only for internal/test callers (see knx-installer-workflow.e2e.test.ts).
export type KnxImportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type KnxImportJobStage = "queued" | "parse_and_synthesize" | "complete";
export interface KnxImportJob {
  jobId: string;
  status: KnxImportJobStatus;
  stage: KnxImportJobStage;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  result: { queue: KnxInstallerQueueItem[]; summary: KnxDiscoverySummary } | null;
}
export async function knxDiscoveryQueueJobStart(ets?: { content?: string; knxproj?: string; password?: string }): Promise<{ jobId: string; status: KnxImportJobStatus; stage: KnxImportJobStage }> {
  const res = await authed("/v1/commissioning/knx/queue/job", { method: "POST", body: JSON.stringify(ets ?? {}) });
  if (!res.ok) throw new Error(await errorMessage(res, "Discovery failed."));
  return (await res.json()) as { jobId: string; status: KnxImportJobStatus; stage: KnxImportJobStage };
}
export async function knxDiscoveryQueueJobStatus(jobId: string): Promise<KnxImportJob> {
  const res = await authed(`/v1/commissioning/knx/queue/job/${encodeURIComponent(jobId)}`, { method: "GET" });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not check import job status."));
  return (await res.json()) as KnxImportJob;
}
export async function knxDiscoveryQueueJobCancel(jobId: string): Promise<{ jobId: string; status: "cancelled" }> {
  const res = await authed(`/v1/commissioning/knx/queue/job/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not cancel import job."));
  return (await res.json()) as { jobId: string; status: "cancelled" };
}
export interface KnxApprovalResult {
  device: { id: string; name: string };
  status: "ready" | "warning" | "error";
  reason?: string;
}
/** Commission + bind + validate in one action (§ Approval) — rolls back automatically
 * server-side on any failure; nothing here duplicates that logic. */
export async function approveKnxDevice(input: { device: KnxUnifiedDevice; name: string; roomId?: string; roomNameHint?: string; plans: KnxBindingPlan[] }): Promise<KnxApprovalResult> {
  const res = await authed("/v1/commissioning/knx/approve", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await errorMessage(res, "Approval failed."));
  return (await res.json()) as KnxApprovalResult;
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

/**
 * Client-side display projection of the backend `Automation` (`@supreme/domain-model`'s
 * full DSL type) — deliberately narrower than the wire shape, since the web UI only ever
 * renders/summarizes triggers/conditions/actions, never authors the richer per-capability
 * fields (brightness/color/temperature/…) the DSL already supports. Not a duplicate-by-
 * accident: the editor's own authoring shape is `EditorNode` in automations.tsx, an
 * even narrower onoff-only subset — see docs/architecture/Automation-Editor.md.
 */
export interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  triggers: { type: string; deviceId?: string; capability?: string; field?: string; at?: string; everyMinutes?: number }[];
  conditions: { type: string; deviceId?: string; capability?: string; field?: string }[];
  actions: { type: string; deviceId?: string; command?: Record<string, unknown> }[];
  tags: string[];
}

/** Every automation with at least one trigger/condition/action referencing this device — there's
 * no server-side filter (§ Automations reference devices by id inside their DSL, not via an
 * index), so this fetches the home's automations and filters client-side. */
export function automationsForDevice(automations: AutomationView[], deviceId: string): AutomationView[] {
  return automations.filter((a) =>
    a.triggers.some((t) => t.deviceId === deviceId) ||
    a.conditions.some((c) => c.deviceId === deviceId) ||
    a.actions.some((act) => act.deviceId === deviceId),
  );
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

/** Rename (§ ADR 0100 Management) — PATCH accepts a name-only partial body already. */
export async function renameAutomation(id: string, name: string): Promise<boolean> {
  const res = await authed(`/v1/automations/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
  return res.ok;
}

/** Delete (§ ADR 0100 Management) — existing route, reused as-is. */
export async function deleteAutomation(id: string): Promise<boolean> {
  const res = await authed(`/v1/automations/${id}`, { method: "DELETE" });
  return res.ok;
}

/** Tags (§ ADR 0100 Management) — PATCH accepts a tags-only partial body already. */
export async function setAutomationTags(id: string, tags: string[]): Promise<boolean> {
  const res = await authed(`/v1/automations/${id}`, { method: "PATCH", body: JSON.stringify({ tags }) });
  return res.ok;
}

/** Duplicate with an explicit resolved name (§ ADR 0100 Management — bulk duplicate naming). */
export async function duplicateAutomationAs(id: string, name: string): Promise<AutomationView | null> {
  const res = await authed(`/v1/automations/${id}/duplicate`, { method: "POST", body: JSON.stringify({ name }) });
  return res.ok ? ((await res.json()) as { automation: AutomationView }).automation : null;
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
  tags?: string[];
}): Promise<boolean> {
  const res = await authed("/v1/automations", { method: "POST", body: JSON.stringify(body) });
  return res.ok;
}

/** Dry-run (§ Phase 1): evaluates real conditions against real state, executes nothing. Returns
 * the same trace shape the Automation Debugger already renders, tagged "dry_run". */
export async function dryRunAutomation(id: string): Promise<AutomationRunView | null> {
  const res = await authed(`/v1/automations/${id}/dry-run`, { method: "POST", body: "{}" });
  return res.ok ? ((await res.json()) as { run: AutomationRunView }).run : null;
}

export interface AutomationHealth {
  status: "disabled" | "waiting" | "healthy" | "warning" | "broken";
  reason: string;
}

/** Plain-language health (§ Phase 1), derived from real run history. */
export async function fetchAutomationHealth(id: string): Promise<AutomationHealth | null> {
  const res = await authed(`/v1/automations/${id}/health`);
  return res.ok ? ((await res.json()) as AutomationHealth) : null;
}

/** Clone an automation, disabled by default until reviewed (§ Phase 1). */
export async function duplicateAutomation(id: string): Promise<AutomationView | null> {
  const res = await authed(`/v1/automations/${id}/duplicate`, { method: "POST", body: "{}" });
  return res.ok ? ((await res.json()) as { automation: AutomationView }).automation : null;
}

/** Test Panel (§ Phase 1): inject a synthetic device-state event through the REAL Automation
 * Engine — never a fake execution path. */
export async function simulateDeviceEvent(input: { deviceId: string; capability: string; state: Record<string, unknown> }): Promise<boolean> {
  const res = await authed("/v1/automations/simulate-event", { method: "POST", body: JSON.stringify(input) });
  return res.ok;
}

// ── Device history (§ Design System — Universal Page Structure: History) ────────
// Two independent, genuinely-per-device timelines the hub already keeps — the Supreme
// Intelligence Engine's own decision log, and (only once a homeowner has configured an
// electricity provider) the energy-cost series. Neither has an SDK wrapper yet; both fail
// soft to an empty list so an unconfigured/quiet device just hides its History section
// rather than showing an error (§ "only show fields that exist").

export interface DeviceHistoryEntry {
  id: string;
  ts: string;
  action: string;
  reason: string | null;
  automatic: boolean;
}

export async function fetchIntelligenceHistory(deviceId: string): Promise<DeviceHistoryEntry[]> {
  try {
    const res = await authed(`/v1/intelligence/history?deviceId=${encodeURIComponent(deviceId)}&limit=20`);
    if (!res.ok) return [];
    return ((await res.json()) as { history: DeviceHistoryEntry[] }).history;
  } catch {
    return [];
  }
}

export interface EnergyHistoryPoint {
  period: string;
  kwh: number;
  cost: number;
}

export async function fetchEnergyHistory(deviceId: string): Promise<{ currency: string; points: EnergyHistoryPoint[] }> {
  try {
    const res = await authed(`/v1/energy/history?deviceId=${encodeURIComponent(deviceId)}&bucket=day`);
    if (!res.ok) return { currency: "", points: [] };
    const j = (await res.json()) as { currency: string; history: EnergyHistoryPoint[] };
    return { currency: j.currency, points: j.history };
  } catch {
    return { currency: "", points: [] };
  }
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
