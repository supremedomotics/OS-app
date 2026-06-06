/**
 * @supreme/protocols — real native protocol drivers behind the SupremeNativeAdapter
 * seam (§3, §7). Each driver speaks one real wire protocol and confines that
 * protocol's framing, emitting pure Supreme capabilities upward.
 */
export { MqttProtocolDriver, type MqttDriverOptions } from "./mqtt-driver.js";
export { stateFromPayload, payloadFromCommand } from "./mqtt-codec.js";
export { ModbusProtocolDriver, type ModbusDriverOptions } from "./modbus-driver.js";
