/**
 * SupremeOS Core (§ Casambi Driver Refactor — PR-2) — cross-driver primitives every future
 * protocol driver builds on: the Core Event Bus, Capability Engine, Packet Recorder Framework,
 * Driver Health Engine, and Driver Metrics Engine. Casambi (this PR) is the first real consumer;
 * nothing here is Casambi-specific.
 */
export {
  CoreEventBus,
  type CoreDriverEvent,
  type CoreEventListener,
  type DeviceEvent,
  type ButtonEvent,
  type SensorEvent,
  type LightingEvent,
  type MediaEvent,
  type ClimateEvent,
  type AutomationEvent,
  type SceneEvent,
  type GroupEvent,
  type DiagnosticEvent,
  type DriverEvent,
  type NetworkEvent,
  type HealthEvent,
} from "./event-bus.js";
export {
  computeEntityCapabilities,
  computeDriverCapabilities,
  type CapabilitySnapshot,
  type EntityCapabilityFlags,
  type DriverCapabilityInfo,
  type DriverCapabilityFlags,
} from "./capability-engine.js";
export {
  PacketRecorder,
  type PacketDirection,
  type RecordedPacket,
  type PacketRecorderFilter,
  type PacketRecorderOptions,
} from "./packet-recorder.js";
export {
  computeDriverHealth,
  type LifecycleState,
  type DriverHealthInputs,
  type DriverHealthSnapshot,
  type DriverHealthVerdict,
} from "./driver-health-engine.js";
export {
  DriverMetricsEngine,
  type MetricCounterName,
  type DriverMetricsSnapshot,
} from "./driver-metrics-engine.js";
