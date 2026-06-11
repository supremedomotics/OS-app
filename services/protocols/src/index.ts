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
export { CoolMasterProtocolDriver, type CoolMasterDriverOptions } from "./coolmaster-driver.js";
export {
  parseUnitLine,
  commandToCoolMaster,
  temperatureStateFromUnit,
  type CoolMasterUnit,
} from "./coolmaster-codec.js";
export {
  SipProtocolDriver,
  type SipDriverOptions,
  type SipDoorStation,
  type SipRingEvent,
} from "./sip-driver.js";
