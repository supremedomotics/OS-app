import {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Phase-3 contracts (§16): the visual Automation Builder DSL surface, energy
 * analytics, advanced audit, and the AI assistant — all Supreme-native.
 */

// ── Automations ──────────────────────────────────────────────────────────────

export const CreateAutomationRequest = z.object({
  name: z.string().min(1),
  triggers: z.array(AutomationTrigger).min(1),
  conditions: z.array(AutomationCondition).default([]),
  actions: z.array(AutomationAction).min(1),
  engine: z.enum(["supreme"]).default("supreme"),
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
});
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

export const UpdateAutomationRequest = CreateAutomationRequest.partial();
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

export const AutomationResponse = z.object({ automation: Automation });
export type AutomationResponse = z.infer<typeof AutomationResponse>;

export const AutomationList = z.object({ automations: z.array(Automation) });
export type AutomationList = z.infer<typeof AutomationList>;

export const SetAutomationEnabledRequest = z.object({ enabled: z.boolean() });
export type SetAutomationEnabledRequest = z.infer<typeof SetAutomationEnabledRequest>;

// ── Automation Debugger (§ Automation Debugger) ──────────────────────────────

export const AutomationRunAction = z.object({
  type: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number(),
  summary: z.string(),
});
export type AutomationRunAction = z.infer<typeof AutomationRunAction>;

/** One execution trace: what triggered it, whether conditions passed, per-action outcome + timing. */
export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  startedAt: z.string(),
  trigger: z.string(),
  conditionsPassed: z.boolean(),
  failedCondition: z.string().optional(),
  actions: z.array(AutomationRunAction),
  durationMs: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunList = z.object({ runs: z.array(AutomationRun) });
export type AutomationRunList = z.infer<typeof AutomationRunList>;

/** Dry-run result (§ Phase 1): the SAME AutomationRun shape the debugger already renders,
 * with `trigger: "dry_run"` and every action recorded as "would execute", never really run. */
export const AutomationDryRunResponse = z.object({ run: AutomationRun });
export type AutomationDryRunResponse = z.infer<typeof AutomationDryRunResponse>;

/** Plain-language health (§ Phase 1) — derived from real run history, never a bare enum alone. */
export const AutomationHealthResponse = z.object({
  status: z.enum(["disabled", "waiting", "healthy", "warning", "broken"]),
  reason: z.string(),
});
export type AutomationHealthResponse = z.infer<typeof AutomationHealthResponse>;

/** Test Panel (§ Phase 1): inject a synthetic device-state event through the REAL Automation
 * Engine — never a fake/mocked execution path, exactly the same `onDeviceState` real triggers
 * use. Development/installer testing tool, not a production device command. */
export const SimulateDeviceEventRequest = z.object({
  deviceId: z.string(),
  capability: z.string(),
  state: z.record(z.unknown()),
});
export type SimulateDeviceEventRequest = z.infer<typeof SimulateDeviceEventRequest>;

// ── Energy / analytics ───────────────────────────────────────────────────────

export const MeasureSummary = z.object({
  measure: z.string(),
  total: z.number(),
  average: z.number(),
  count: z.number().int(),
  unit: z.string(),
});
export const EnergySummaryResponse = z.object({
  summary: z.array(MeasureSummary),
  topConsumers: z.array(z.object({ deviceId: z.string(), total: z.number(), unit: z.string() })),
});
export type EnergySummaryResponse = z.infer<typeof EnergySummaryResponse>;

export const DeviceEnergyResponse = z.object({
  series: z.array(z.object({ hour: z.string(), total: z.number(), average: z.number() })),
});
export type DeviceEnergyResponse = z.infer<typeof DeviceEnergyResponse>;

// ── Advanced audit ───────────────────────────────────────────────────────────

export const AuditEntry = z.object({
  id: z.string(),
  seq: z.number().int(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  entryHash: z.string(),
});
export const AuditList = z.object({ entries: z.array(AuditEntry) });
export type AuditList = z.infer<typeof AuditList>;

export const AuditVerifyResponse = z.object({
  ok: z.boolean(),
  brokenAtSeq: z.number().int().optional(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponse>;

// ── AI assistant ─────────────────────────────────────────────────────────────

export const AiAssistRequest = z.object({ utterance: z.string().min(1) });
export type AiAssistRequest = z.infer<typeof AiAssistRequest>;

/** The assistant returns a draft the user confirms (actions/scene/automation/answer). */
export const AiAssistResponse = z.object({
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("actions"), summary: z.string(), commands: z.array(z.unknown()) }),
    z.object({ kind: z.literal("scene"), summary: z.string(), name: z.string(), steps: z.array(z.unknown()) }),
    z.object({
      kind: z.literal("automation"),
      summary: z.string(),
      name: z.string(),
      triggers: z.array(z.unknown()),
      actions: z.array(z.unknown()),
    }),
    z.object({ kind: z.literal("answer"), summary: z.string() }),
  ]),
});
export type AiAssistResponse = z.infer<typeof AiAssistResponse>;

// ── Security & cameras ───────────────────────────────────────────────────────

export const SecurityMode = z.enum(["disarmed", "armed_home", "armed_away", "armed_night"]);
export type SecurityMode = z.infer<typeof SecurityMode>;

export const SecurityStateResponse = z.object({
  mode: SecurityMode,
  triggered: z.boolean(),
  lastChangedBy: z.string().nullable(),
  lastChangedAt: z.string(),
});
export type SecurityStateResponse = z.infer<typeof SecurityStateResponse>;

export const ArmRequest = z.object({
  mode: z.enum(["armed_home", "armed_away", "armed_night"]),
  pin: z.string().optional(),
});
export type ArmRequest = z.infer<typeof ArmRequest>;

export const DisarmRequest = z.object({ pin: z.string().optional() });
export type DisarmRequest = z.infer<typeof DisarmRequest>;

export const CameraView = z.object({
  id: z.string(),
  name: z.string(),
  roomId: z.string().nullable(),
  snapshotUrl: z.string().nullable(),
  /** The camera's RTSP source URI (installer/NVR use; not directly browser-playable). */
  streamUrl: z.string().nullable(),
});
export const CameraList = z.object({ cameras: z.array(CameraView) });
export type CameraList = z.infer<typeof CameraList>;

/** A client-playable stream for a camera (HLS/WebRTC), or the raw RTSP source. */
export const CameraStream = z.object({
  kind: z.enum(["hls", "webrtc", "rtsp"]),
  url: z.string(),
});
export type CameraStream = z.infer<typeof CameraStream>;

/** The playable streams for one camera, resolved through the hub's stream engine. */
export const CameraStreamResponse = z.object({
  cameraId: z.string(),
  streams: z.array(CameraStream),
});
export type CameraStreamResponse = z.infer<typeof CameraStreamResponse>;

/** Register a (view-only) camera device with its source URLs. */
export const RegisterCameraRequest = z.object({
  name: z.string().min(1),
  roomId: z.string().nullable().optional(),
  /** RTSP source, e.g. "rtsp://10.0.0.5:554/h264". */
  streamUrl: z.string().optional(),
  snapshotUrl: z.string().optional(),
});
export type RegisterCameraRequest = z.infer<typeof RegisterCameraRequest>;

/** Update an existing camera's source URLs. */
export const SetCameraStreamRequest = z.object({
  streamUrl: z.string().nullable().optional(),
  snapshotUrl: z.string().nullable().optional(),
});
export type SetCameraStreamRequest = z.infer<typeof SetCameraStreamRequest>;

export const CameraResponse = z.object({ camera: CameraView });
export type CameraResponse = z.infer<typeof CameraResponse>;

// ── RTSP Camera driver: discovery + commissioning (§ RTSP Camera Extension) ─────────

export const RtspDiscoveryResultSchema = z.object({
  id: z.string(),
  discoveryMethod: z.enum(["onvif", "rtsp-probe"]),
  discoveryMethods: z.array(z.enum(["onvif", "rtsp-probe"])),
  ipAddress: z.string(),
  port: z.number(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  hostname: z.string().nullable(),
  onvifUuid: z.string().nullable(),
  onvifEndpoint: z.string().nullable(),
  rtspAvailable: z.boolean(),
  onvifAvailable: z.boolean(),
  rtspPorts: z.array(z.number()),
  /** § UniFi Protect — a host that answered on 7441/7447: the console, not a camera. */
  unifiProtectConsole: z.boolean().optional(),
});
export type RtspDiscoveryResultDto = z.infer<typeof RtspDiscoveryResultSchema>;

export const RtspDiscoverRequest = z.object({ timeoutMs: z.number().min(500).max(15_000).optional() });
export type RtspDiscoverRequest = z.infer<typeof RtspDiscoverRequest>;

export const RtspDiscoverResponse = z.object({ cameras: z.array(RtspDiscoveryResultSchema) });
export type RtspDiscoverResponse = z.infer<typeof RtspDiscoverResponse>;

/** § STEP 8 — plain-English validation checklist, shared by the ONVIF and manual RTSP flows. */
export const RtspStreamCheckSchema = z.object({
  ok: z.boolean(),
  checklist: z.array(z.object({ label: z.string(), pass: z.boolean() })),
  reason: z.string().nullable(),
  diagnostics: z.array(z.string()),
  codec: z.string().nullable(),
});
export type RtspStreamCheckDto = z.infer<typeof RtspStreamCheckSchema>;

/** Test Connection — either an ONVIF candidate (endpoint + credentials, profile/stream resolved
 * server-side) or a manual RTSP-only URL + optional credentials. Passwords never round-trip back
 * out in any response (§ STEP 11). */
export const RtspTestConnectionRequest = z.union([
  z.object({ mode: z.literal("onvif"), onvifEndpoint: z.string().min(1), username: z.string().min(1), password: z.string().min(1) }),
  z.object({ mode: z.literal("manual"), rtspUrl: z.string().min(1), username: z.string().optional(), password: z.string().optional() }),
]);
export type RtspTestConnectionRequest = z.infer<typeof RtspTestConnectionRequest>;

export const RtspTestConnectionResponse = z.object({
  result: RtspStreamCheckSchema,
  // Populated only for a successful ONVIF test — lets the Add-Camera UI show what will actually
  // be commissioned before the installer confirms.
  resolvedMainStreamUrl: z.string().nullable().optional(),
  resolvedSubStreamUrl: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type RtspTestConnectionResponse = z.infer<typeof RtspTestConnectionResponse>;

export const RtspCommissionRequest = z.object({
  name: z.string().min(1),
  roomId: z.string().nullable().optional(),
  mode: z.enum(["onvif", "manual"]),
  onvifEndpoint: z.string().optional(),
  onvifUuid: z.string().optional(),
  rtspUrl: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type RtspCommissionRequest = z.infer<typeof RtspCommissionRequest>;

export const RtspCommissionResponse = z.object({ camera: CameraView, validation: RtspStreamCheckSchema });
export type RtspCommissionResponse = z.infer<typeof RtspCommissionResponse>;

// ── UniFi Protect mode (§ RTSP Camera Extension) ─────────────────────────────────────
// The API key is request-only: it is never stored, logged, or returned.

export const UnifiProtectListRequest = z.object({ host: z.string().min(1).max(255), apiKey: z.string().min(1).max(512) });
export type UnifiProtectListRequest = z.infer<typeof UnifiProtectListRequest>;

export const UnifiProtectCameraSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().nullable(),
  state: z.string().nullable(),
});
export type UnifiProtectCameraDto = z.infer<typeof UnifiProtectCameraSchema>;

export const UnifiProtectListResponse = z.object({ cameras: z.array(UnifiProtectCameraSchema) });
export type UnifiProtectListResponse = z.infer<typeof UnifiProtectListResponse>;

export const UnifiProtectCommissionRequest = z.object({
  host: z.string().min(1).max(255),
  apiKey: z.string().min(1).max(512),
  roomId: z.string().nullable().optional(),
  cameras: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(200), model: z.string().nullable().optional() })).min(1).max(64),
});
export type UnifiProtectCommissionRequest = z.infer<typeof UnifiProtectCommissionRequest>;

export const UnifiProtectCommissionResultSchema = z.object({
  unifiCameraId: z.string(),
  name: z.string(),
  status: z.enum(["added", "already-added", "failed"]),
  deviceId: z.string().nullable(),
  reason: z.string().nullable(),
  diagnostics: z.array(z.string()),
});
export type UnifiProtectCommissionResultDto = z.infer<typeof UnifiProtectCommissionResultSchema>;

export const UnifiProtectCommissionResponse = z.object({ results: z.array(UnifiProtectCommissionResultSchema) });
export type UnifiProtectCommissionResponse = z.infer<typeof UnifiProtectCommissionResponse>;

/** Register this client's push token so it can receive notifications while backgrounded. */
export const RegisterPushTokenRequest = z.object({
  platform: z.enum(["fcm", "apns", "webpush"]),
  token: z.string().min(1),
});
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequest>;

export const PushTokenResponse = z.object({ registered: z.boolean(), pushEnabled: z.boolean() });
export type PushTokenResponse = z.infer<typeof PushTokenResponse>;
