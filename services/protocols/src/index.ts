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
