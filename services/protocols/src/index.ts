/**
 * @supreme/protocols — real native protocol drivers behind the SupremeNativeAdapter
 * seam (§3, §7). Each driver speaks one real wire protocol and confines that
 * protocol's framing, emitting pure Supreme capabilities upward.
 */
export { MqttProtocolDriver, type MqttDriverOptions } from "./mqtt-driver.js";
export { stateFromPayload, payloadFromCommand } from "./mqtt-codec.js";
export { discoveredFromZ2mBridge } from "./mqtt-discovery.js";
export { ModbusProtocolDriver, type ModbusDriverOptions } from "./modbus-driver.js";
export { KnxProtocolDriver, type KnxDriverOptions, type KnxConnection } from "./knx-driver.js";
export { defaultDpt, stateFromValue, valueFromCommand, type KnxValue } from "./knx-codec.js";
export {
  knxSearch,
  encodeSearchRequest,
  parseSearchResponse,
  formatIndividualAddress,
  type KnxGateway,
  type KnxSearchOptions,
  type KnxDiscoverySocket,
  type KnxDiscoverySocketFactory,
} from "./knx-discovery.js";
export {
  MatterProtocolDriver,
  type MatterDriverOptions,
  type MatterController,
  type MatterAddress,
  type MatterAttributeReport,
  type MatterNodeInfo,
} from "./matter-driver.js";
export {
  capabilitiesFromClusters,
  clusterForCapability,
  invocationFromCommand,
  stateFromAttribute as matterStateFromAttribute,
} from "./matter-codec.js";
export {
  parseMatterSetupCode,
  parseManualPairingCode,
  parseQrPayload,
  MatterPairingError,
  type MatterOnboardingPayload,
} from "./matter-pairing.js";
export {
  MatterFabricManager,
  HttpMatterFabricSync,
  type MatterFabricSync,
  type MatterFabricManagerOptions,
} from "./matter-fabric.js";
export {
  ZigbeeProtocolDriver,
  type ZigbeeDriverOptions,
  type ZigbeeController,
  type ZigbeeAddress,
  type ZigbeeReport,
  type ZigbeeDeviceInfo,
} from "./zigbee-driver.js";
export {
  capabilitiesFromZclClusters,
  zclClusterForCapability,
  commandToZcl,
  stateFromZclReport,
} from "./zigbee-codec.js";
export {
  DaliProtocolDriver,
  type DaliDriverOptions,
  type DaliBus,
  type DaliUnitInfo,
} from "./dali-driver.js";
export {
  type DaliAddress,
  type DaliOperation,
  type DimmingCurve,
  parseDaliAddress,
  daliAddressByte,
  arcPowerFromPercent,
  percentFromArcPower,
  commandToDali,
  capabilitiesFromDeviceType,
  DALI_CMD,
} from "./dali-codec.js";
export { AvrProtocolDriver, type AvrDriverOptions } from "./avr-driver.js";
export { commandToAvr, parseAvrLine, type AvrUpdate } from "./avr-codec.js";
export {
  percentFromScale,
  scaleFromPercent,
  type AudioCapabilityConfig,
  type AvrInput,
  type AvrSoundMode,
  type AvrRange,
  type AvrZoneInfo,
} from "./avr-capabilities.js";
export { ReconnectScheduler, type ReconnectSchedulerOptions } from "./avr-reconnect.js";
export { HeosProtocolDriver, type HeosDriverOptions } from "./heos-driver.js";
export {
  buildHeosCommand,
  commandToHeos,
  parseHeosMessage,
  parseHeosAttrs,
  heosCapabilityConfig,
  heosRepeatFromSupreme,
  supremeRepeatFromHeos,
  playbackFromHeosState,
  buildHeosMediaState,
  HEOS_INPUTS,
  type HeosUpdate,
  type HeosRequest,
  type HeosPlayerInfo,
  type HeosNowPlaying,
  type HeosMediaCache,
} from "./heos-codec.js";
export {
  YamahaProtocolDriver,
  type YamahaDriverOptions,
  type YamahaEventSocket,
  type YamahaEventSocketFactory,
} from "./yamaha-driver.js";
export {
  yamahaUrl,
  yamahaBaseUrl,
  yamahaAbsoluteUrl,
  commandToYamaha,
  parseYamahaFeatures,
  yamahaCapabilityConfig,
  parseYamahaZoneStatus,
  parseYamahaPlayInfo,
  parseYamahaEvent,
  parseUpnpDescription,
  playbackFromYamaha,
  supremeRepeatFromYamaha,
  supremeShuffleFromYamaha,
  buildYamahaMediaState,
  isYamahaZone,
  YAMAHA_ZONES,
  type YamahaZone,
  type YamahaFeatures,
  type YamahaZoneFeatures,
  type YamahaInputInfo,
  type YamahaPlayInfoType,
  type YamahaZoneStatus,
  type YamahaNetUsbPlayInfo,
  type YamahaMediaCache,
  type YamahaEvent,
  type YamahaZoneEvent,
  type YamahaRequest,
} from "./yamaha-codec.js";
export { CoolMasterProtocolDriver, type CoolMasterDriverOptions } from "./coolmaster-driver.js";
export {
  isCoolMasterUid,
  parseLs2Line,
  parseLs2Block,
  parseUnitJson,
} from "./coolmaster-parser.js";
export type {
  ClimateAdvancedControl,
  ClimateCapabilityConfig,
} from "./coolmaster-capabilities.js";
export type {
  CoolMasterUnitStatus,
  CoolMasterGatewayInfo,
  CoolMasterDiscoveryResult,
  CoolMasterProtocolMode,
} from "./coolmaster-types.js";
export {
  SipProtocolDriver,
  type SipDriverOptions,
  type SipDoorStation,
  type SipRingEvent,
} from "./sip-driver.js";
export { WiimProtocolDriver, type WiimDriverOptions } from "./wiim-driver.js";
export { commandToLinkPlay, stateFromLinkPlay, decodeHex } from "./wiim-codec.js";
export { DevialetProtocolDriver, type DevialetDriverOptions } from "./devialet-driver.js";
export { commandToDevialet, stateFromDevialet, DEVIALET_STATE_PATHS } from "./devialet-codec.js";
export {
  SonosProtocolDriver,
  type SonosDriverOptions,
  type SonosPlayer,
  type SonosPlayerState,
  type SonosConnect,
} from "./sonos-driver.js";
export {
  createSonosConnect,
  wrapSonosDevice,
  mapSonosPlayback,
  type SonosDevice,
} from "./sonos-transport.js";
export {
  ssdpSearch,
  parseSsdpResponse,
  type SsdpResponse,
  type SsdpSocket,
  type SsdpSearchOptions,
} from "./ssdp.js";
export {
  mdnsBrowse,
  encodeQuery,
  decodeMessage,
  readName,
  resolveServices,
  type MdnsService,
  type MdnsSocket,
  type MdnsBrowseOptions,
} from "./mdns.js";
export {
  AjaxProtocolDriver,
  type AjaxDriverOptions,
  type AjaxClient,
  type AjaxEvent,
  type AjaxConnect,
} from "./ajax-driver.js";
export { ShellyProtocolDriver, type ShellyDriverOptions } from "./shelly-driver.js";
export {
  commandToShellyRpc,
  stateFromShellyStatus,
  capabilitiesFromShellyStatus,
  type ShellyRpcCall,
} from "./shelly-codec.js";
export {
  AirPlayProtocolDriver,
  type AirPlayDriverOptions,
  type AirPlaySender,
  type AirPlaySenderState,
  type AirPlayConnect,
} from "./airplay-driver.js";
export {
  AppleTvProtocolDriver,
  mediaStateFromNowPlaying,
  type AppleTvDriverOptions,
  type AppleTvClient,
  type AppleTvNowPlaying,
  type AppleTvConnect,
} from "./apple-tv-driver.js";
export { createAppleTvConnect, type AppleTvBridgeOptions } from "./apple-tv-bridge.js";
export { LutronProtocolDriver, type LutronDriverOptions } from "./lutron-driver.js";
export { commandToLutron, parseLutronLine, stateFromLutronLevel, type LutronLine } from "./lutron-codec.js";
export {
  TuyaProtocolDriver,
  type TuyaDriverOptions,
  type TuyaDevice,
  type TuyaConnect,
} from "./tuya-driver.js";
export {
  CasambiProtocolDriver,
  type CasambiDriverOptions,
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
} from "./casambi-transport.js";
export {
  capabilitiesFromUnit,
  statesFromUnit,
  commandToTargetControls,
  rgbToHueSat,
  type CasambiUnit,
  type CasambiControl,
} from "./casambi-codec.js";
