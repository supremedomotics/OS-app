-- Persist native protocol bindings (§3, §4): which Supreme device/capability is wired
-- to which bus address on which driver (KNX/Modbus/MQTT). Re-bound onto the native
-- engine on boot so commissioned bus devices survive a hub restart.
CREATE TABLE IF NOT EXISTS protocol_bindings (
  device_id  TEXT NOT NULL,
  capability TEXT NOT NULL,
  protocol   TEXT NOT NULL,
  address    TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (device_id, capability)
);
