/**
 * Casambi Driver — public barrel (§ Casambi Driver Refactor — Foundation). One import surface
 * for every module in this driver: Connection Manager, Cloud Transport, Local Transport (REST
 * Client + UDP Engine), Entity Mapper, Discovery Engine, Feedback Engine, Event Bus, Diagnostics,
 * Health Monitor, Driver Settings, and the orchestrating `CasambiProtocolDriver` itself.
 */
export {
  CasambiProtocolDriver,
  type CasambiDriverOptions,
  type CasambiCommonDriverOptions,
  type CasambiHealth,
} from "./casambi-driver.js";
export {
  HttpCasambiTransport,
  CasambiSessionExpiredError,
  type CasambiTransport,
  type CasambiCredentials,
  type CasambiSession,
  type CasambiNetwork,
  type CasambiGroup,
  type CasambiEvent,
  type CasambiWire,
  type CasambiWireHandlers,
  type CasambiSocketFactory,
  type WebSocketLike,
  type HttpCasambiTransportOptions,
} from "./cloud-transport.js";
export {
  capabilitiesFromUnit,
  colorConfigFromUnit,
  statesFromUnit,
  commandToTargetControls,
  rgbToHueSat,
  describeCasambiEntityKind,
  type CasambiUnit,
  type CasambiControl,
  type CasambiEntityKind,
} from "./entity-mapper.js";
export {
  createConnection,
  type CasambiConnectionMode,
  type CasambiConnection,
  type CasambiConnectionOptions,
  type CasambiCloudConnectionOptions,
  type CasambiLocalConnectionOptions,
} from "./connection-manager.js";
export {
  CasambiLocalRestClient,
  CasambiLocalRestNotImplementedError,
  CasambiUdpEngine,
  CasambiLocalTransport,
  type CasambiLocalRestClientOptions,
  type CasambiSetTargetValueParams,
  type CasambiSetTargetValueResult,
  type CasambiUdpEngineOptions,
  type CasambiUdpPacket,
  type CasambiLocalGatewayConfig,
  type CasambiWireFormat,
  type CasambiPacket,
} from "./local-transport/index.js";
export { buildDiscoveredDevices } from "./discovery-engine.js";
export { CasambiFeedbackEngine, WIRE_ID } from "./feedback-engine.js";
export {
  CasambiEventBus,
  type CasambiEventListener,
  type CasambiDriverEvent,
  type DeviceEvent,
  type ButtonEvent,
  type SceneEvent,
  type SensorEvent,
  type NetworkEvent,
  type DiagnosticEvent,
} from "./event-engine.js";
export {
  buildDiagnosticsSnapshot,
  type CasambiDiagnosticsSnapshot,
  type CasambiDiagnosticsInputs,
} from "./diagnostics.js";
export {
  computeHealthVerdict,
  restSubsystemStatus,
  udpSubsystemStatus,
  type CasambiSubsystemStatus,
  type CasambiHealthInputs,
  type CasambiHealthVerdict,
} from "./health-monitor.js";
export {
  DEFAULT_CASAMBI_ADVANCED_SETTINGS,
  type CasambiCloudSettings,
  type CasambiLocalSettings,
  type CasambiAdvancedSettings,
  type CasambiDriverSettings,
} from "./driver-settings.js";
