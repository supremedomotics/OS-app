import type { CapabilityKind } from "@supreme/domain-model";
import type { DeviceCardControlSpec, DeviceCardSpec, KnxDeviceType, RecognizedDevice } from "./types.js";

/**
 * Device Card Generator (§ Automatic UI Generation, § Device Card Structure). Produces
 * the installer-facing card spec (icon + controls + quick actions) for a recognized
 * device type. The candidate control list per type is fixed, but every control is
 * filtered down to capabilities the device ACTUALLY has bound — a tunable-white fixture
 * missing its colour-temperature address never gets a colour-temperature slider on its
 * card, matching the "only show what the driver can actually do" rule that governs every
 * device console in Supreme.
 */

interface CardTemplate {
  icon: string;
  controls: DeviceCardControlSpec[];
  quickActions: string[];
}

const TEMPLATES: Record<KnxDeviceType, CardTemplate> = {
  light_switch: { icon: "lightbulb", controls: [{ kind: "toggle", capability: "onoff" }], quickActions: ["On", "Off"] },
  light_dimmable: {
    icon: "lightbulb",
    controls: [{ kind: "toggle", capability: "onoff" }, { kind: "brightness_slider", capability: "brightness" }],
    quickActions: ["On", "Off", "Dim"],
  },
  light_tunable_white: {
    icon: "lightbulb",
    controls: [
      { kind: "toggle", capability: "onoff" },
      { kind: "brightness_slider", capability: "brightness" },
      { kind: "color_temperature_slider", capability: "color" },
    ],
    quickActions: ["On", "Off", "Warm", "Cool"],
  },
  light_color_temp: {
    icon: "lightbulb",
    controls: [{ kind: "toggle", capability: "onoff" }, { kind: "color_temperature_slider", capability: "color" }],
    quickActions: ["On", "Off", "Warm", "Cool"],
  },
  light_rgb: {
    icon: "lightbulb",
    controls: [
      { kind: "toggle", capability: "onoff" },
      { kind: "brightness_slider", capability: "brightness" },
      { kind: "color_wheel", capability: "color" },
    ],
    quickActions: ["On", "Off"],
  },
  light_rgbw: {
    icon: "lightbulb",
    controls: [
      { kind: "toggle", capability: "onoff" },
      { kind: "brightness_slider", capability: "brightness" },
      { kind: "color_wheel", capability: "color" },
    ],
    quickActions: ["On", "Off"],
  },
  light_rgbww: {
    icon: "lightbulb",
    controls: [
      { kind: "toggle", capability: "onoff" },
      { kind: "brightness_slider", capability: "brightness" },
      { kind: "color_wheel", capability: "color" },
      { kind: "color_temperature_slider", capability: "color" },
    ],
    quickActions: ["On", "Off"],
  },
  curtain: {
    icon: "curtains",
    controls: [{ kind: "open_close_stop", capability: "position" }, { kind: "position_slider", capability: "position" }],
    quickActions: ["Open", "Close", "Favorite Position"],
  },
  blind: {
    icon: "blinds",
    controls: [{ kind: "open_close_stop", capability: "position" }, { kind: "position_slider", capability: "position" }],
    quickActions: ["Open", "Close", "Favorite Position"],
  },
  roller_shutter: {
    icon: "roller-shutter",
    controls: [{ kind: "open_close_stop", capability: "position" }, { kind: "position_slider", capability: "position" }],
    quickActions: ["Open", "Close", "Favorite Position"],
  },
  garage_door: {
    icon: "garage",
    controls: [{ kind: "open_close_stop", capability: "position" }],
    quickActions: ["Open", "Close"],
  },
  gate: { icon: "gate", controls: [{ kind: "open_close_stop", capability: "position" }], quickActions: ["Open", "Close"] },
  thermostat: {
    icon: "thermostat",
    controls: [{ kind: "temperature_dial", capability: "temperature" }],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  hvac_vrf: {
    icon: "thermostat",
    controls: [
      { kind: "temperature_dial", capability: "temperature" },
      { kind: "mode_select", capability: "temperature" },
      { kind: "fan_select", capability: "temperature" },
      { kind: "swing_toggle", capability: "temperature" },
    ],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  hvac_split_ac: {
    icon: "thermostat",
    controls: [
      { kind: "temperature_dial", capability: "temperature" },
      { kind: "mode_select", capability: "temperature" },
      { kind: "fan_select", capability: "temperature" },
      { kind: "swing_toggle", capability: "temperature" },
    ],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  hvac_cassette_ac: {
    icon: "thermostat",
    controls: [
      { kind: "temperature_dial", capability: "temperature" },
      { kind: "mode_select", capability: "temperature" },
      { kind: "fan_select", capability: "temperature" },
      { kind: "swing_toggle", capability: "temperature" },
    ],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  hvac_duct_ac: {
    icon: "thermostat",
    controls: [
      { kind: "temperature_dial", capability: "temperature" },
      { kind: "mode_select", capability: "temperature" },
      { kind: "fan_select", capability: "temperature" },
    ],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  fan_coil: {
    icon: "thermostat",
    controls: [{ kind: "temperature_dial", capability: "temperature" }, { kind: "fan_select", capability: "temperature" }],
    quickActions: ["Comfort", "Eco", "Away", "Schedule"],
  },
  fan: {
    icon: "fan",
    controls: [{ kind: "toggle", capability: "onoff" }, { kind: "fan_select", capability: "fan" }],
    quickActions: ["On", "Off"],
  },
  sensor_temperature: { icon: "thermometer", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_humidity: { icon: "droplet", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_motion: { icon: "motion", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_presence: { icon: "motion", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_lux: { icon: "sun", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_pressure: { icon: "gauge", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_co2: { icon: "air", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_pm25: { icon: "air", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_leak: { icon: "water-alert", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_smoke: { icon: "smoke-alert", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_door: { icon: "door", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  sensor_window: { icon: "window", controls: [{ kind: "value_readout", capability: "sensor" }], quickActions: [] },
  energy_meter: { icon: "bolt", controls: [{ kind: "chart", capability: "sensor" }, { kind: "value_readout", capability: "sensor" }], quickActions: [] },
  scene: { icon: "scene", controls: [{ kind: "scene_tile", capability: "onoff" }], quickActions: [] },
  audio: {
    icon: "speaker",
    controls: [{ kind: "toggle", capability: "onoff" }, { kind: "brightness_slider", capability: "brightness" }],
    quickActions: ["On", "Off"],
  },
  door_lock: {
    icon: "lock",
    controls: [{ kind: "lock_toggle", capability: "lock" }],
    quickActions: ["Lock", "Unlock"],
  },
  irrigation: { icon: "sprinkler", controls: [{ kind: "toggle", capability: "onoff" }], quickActions: ["On", "Off"] },
  pool: { icon: "pool", controls: [{ kind: "toggle", capability: "onoff" }], quickActions: ["On", "Off"] },
  ventilation: {
    icon: "fan",
    controls: [{ kind: "toggle", capability: "onoff" }, { kind: "fan_select", capability: "fan" }],
    quickActions: ["On", "Off"],
  },
  custom_device: { icon: "device", controls: [{ kind: "toggle", capability: "onoff" }], quickActions: [] },
};

export function generateDeviceCard(device: RecognizedDevice): DeviceCardSpec {
  const template = TEMPLATES[device.deviceType];
  const bound = new Set<CapabilityKind>(device.bindings.map((b) => b.capability));
  return {
    icon: template.icon,
    controls: template.controls.filter((c) => bound.has(c.capability)),
    quickActions: template.quickActions,
  };
}
