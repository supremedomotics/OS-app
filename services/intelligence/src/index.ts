/**
 * Supreme Intelligence Engine (SIE) — public surface.
 *
 * A local-first, modular intelligence platform. The {@link IntelligenceEngine} runs independent
 * {@link IntelligenceModule}s (Presence, Energy, and future Comfort/Security/Maintenance/Predictive/
 * Occupancy/Wellness/Assistant) that each emit Observations + Suggestions with a multi-dimension
 * {@link Confidence}. Everything here is pure + deterministic and has no cloud dependency.
 */
export {
  clamp01,
  toPct,
  weightedMean,
  rollUpDecision,
  makeConfidence,
  type Confidence,
  type ConfidenceDimension,
  type WeightedScore,
} from "./confidence.js";

export {
  IntelligenceEngine,
  type IntelligenceModule,
  type EngineInput,
  type EngineEvaluation,
  type ModuleResult,
  type Observation,
  type Suggestion,
  type SuggestionAction,
} from "./engine.js";

export {
  SOURCE_WEIGHTS,
  ACTIVE_SOURCES,
  sourceWeight,
  type PresenceSignal,
  type PresenceSourceKind,
} from "./presence/sources.js";

export {
  fusePresence,
  fuseUserPresence,
  type FusionOptions,
  type PresenceEstimate,
  type PresenceStatus,
} from "./presence/fusion.js";

export {
  zoneOfRoom,
  ZoneOccupancyTracker,
  type Zone,
  type ZoneOccupancy,
  type HouseOccupancy,
} from "./zones.js";

export {
  validateDeviceIntel,
  validateDeviceIntelMap,
  DeviceIntelError,
  type DeviceIntel,
  type DevicePriority,
} from "./device.js";

export {
  evaluateDevice,
  evaluateEnergyIntelligence,
  type EnergyDeviceInput,
  type EnergyIntelInput,
  type EnergyIntelOptions,
  type DeviceEvaluation,
} from "./energy/decision.js";

export { EnergyIntelligenceModule } from "./energy/module.js";

export {
  decideAutoPilot,
  applyResponse,
  resetEpisode,
  startOfNextUtcDay,
  AUTO_PILOT_MODES,
  type AutoPilotMode,
  type AutoPilotSettings,
  type AutoPilotDecision,
  type SuggestionState,
} from "./autopilot.js";

export {
  buildIntelligenceReport,
  reportToCsv,
  REPORT_PERIODS,
  type ReportPeriod,
  type ReportAggregate,
  type ReportOptions,
  type IntelligenceReport,
} from "./reports.js";
