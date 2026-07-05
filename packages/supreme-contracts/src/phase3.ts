import {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Phase-3 contracts (§16): the visual Automation Builder DSL surface, energy
 * analytics, advanced audit, and the AI assistant. All Supreme — backend-agnostic.
 */

// ── Automations ──────────────────────────────────────────────────────────────

export const CreateAutomationRequest = z.object({
  name: z.string().min(1),
  triggers: z.array(AutomationTrigger).min(1),
  conditions: z.array(AutomationCondition).default([]),
  actions: z.array(AutomationAction).min(1),
  engine: z.enum(["ha", "supreme"]).default("supreme"),
  enabled: z.boolean().default(true),
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

/** Register this client's push token so it can receive notifications while backgrounded. */
export const RegisterPushTokenRequest = z.object({
  platform: z.enum(["fcm", "apns", "webpush"]),
  token: z.string().min(1),
});
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequest>;

export const PushTokenResponse = z.object({ registered: z.boolean(), pushEnabled: z.boolean() });
export type PushTokenResponse = z.infer<typeof PushTokenResponse>;
