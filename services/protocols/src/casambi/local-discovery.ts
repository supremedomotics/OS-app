import type { CasambiControlValue } from "./local-transport/udp-codec.js";
import type { CasambiUnit } from "./entity-mapper.js";

/**
 * Casambi Local Discovery (§ Casambi Driver Refactor — PR-2, Local Gateway Foundation).
 *
 * No REST endpoint documented anywhere in the supplied Lithernet reference set lists devices,
 * groups, or scenes (`Lithernet_WebAPI.pdf` documents exactly one write endpoint and nothing
 * else; `Lithernet_Casambi_App_Settings.pdf` never exposes group/scene names over the wire
 * either). The only real, protocol-grounded signal Local mode has for building Supreme entities
 * is the UDP NotifyControlValues subscription (opcode 0x4B, §5.10.2.2.24/§5.10.2.1.10 of
 * `Lithernet_UDP_Developer_Reference.pdf`) — each unit's set of reported control-value TYPE ids
 * tells us which Supreme capabilities it actually has, the same way `entity-mapper.ts`'s
 * `capabilitiesFromUnit` already reads Cloud's `controls` array. This is a real mechanism, not a
 * fabricated one — but it is honestly progressive: a unit only becomes visible once its first
 * NotifyControlValues packet arrives, so Local discovery fills in over time rather than
 * enumerating everything instantly like Cloud's `/units` REST call does. That difference is
 * architectural, not a bug, and must stay visible in diagnostics (see `diagnostics.ts`).
 *
 * `updateUnitFromControlValues` folds one 0x4B response into the existing (or a fresh)
 * {@link CasambiUnit} record, reusing the exact same `controls`/`sensors`/`on`/`dimLevel` fields
 * `entity-mapper.ts`'s `capabilitiesFromUnit`/`statesFromUnit` already know how to read — Local
 * discovery is additive to the unified entity model, never a parallel implementation of it.
 *
 * Deliberately NOT mapped here (a documented, honest gap — see `TODO.md`): the color-related
 * control types (2 Color Temperature, 3 Hue/Saturation, 4 XY color, 5 Color Source Selector, 11
 * White channel). Their byte layouts are documented (p.277 of the UDP reference), but type 2's
 * single-byte "Color Temperature" value has no documented Kelvin range/normalization at this
 * layer (contrast opcode 0x48's SET command, which documents either a 0x400-0x4000 Kelvin range
 * or a separate 0x00-0xFF normalized form, p.310) — reporting a `kelvin` value from this byte
 * without knowing which encoding it uses would be a guess, not a fact, so this module leaves
 * color-capability inference out of Local discovery entirely rather than fabricate it.
 */
export function updateUnitFromControlValues(
  unitId: number,
  values: readonly CasambiControlValue[],
  previous?: CasambiUnit,
): CasambiUnit {
  const unit: CasambiUnit = { ...previous, id: unitId };
  const sensors: Record<string, unknown> = { ...(previous?.sensors ?? {}) };
  const controls = [...(previous?.controls ?? [])];

  const setControl = (type: string, value: number) => {
    const idx = controls.findIndex((c) => c.type === type);
    if (idx >= 0) controls[idx] = { ...controls[idx], type, value };
    else controls.push({ type, value });
  };

  for (const cv of values) {
    const shortType = cv.type & 0x7f;
    switch (shortType) {
      case 1: // dimmerChannel — 1 byte, 0-255 (p.277)
        unit.dimLevel = (cv.valueBytes[0] ?? 0) / 255;
        setControl("dimmer", unit.dimLevel);
        break;
      case 16: // onOffToggle — 1 byte, 0/1 (p.278)
        unit.on = (cv.valueBytes[0] ?? 0) === 1;
        break;
      case 7: { // batteryLevel — 1 byte, 1-100%, 0 = undefined (p.277)
        const v = cv.valueBytes[0] ?? 0;
        if (v > 0) sensors.battery_level = v;
        break;
      }
      case 6: { // deviceTemperature — 1 byte, 1-255 low-res °C, 0 = undefined (p.277)
        const v = cv.valueBytes[0] ?? 0;
        if (v > 0) sensors.temperature = v;
        break;
      }
      case 20: { // lightSensorLux — 2 bytes little-endian (p.278)
        const low = cv.valueBytes[0] ?? 0;
        const high = cv.valueBytes[1] ?? 0;
        sensors.lux = (high << 8) | low;
        break;
      }
      case 21: // presenceSensor — 1 byte, 0=inactive/1=active/2=hold (p.278)
        sensors.presence = cv.valueBytes[0] ?? 0;
        break;
      default:
        // Unsupported/reserved/color types — honestly ignored per the doc's own "Client
        // requirements: ... ignore unknown or unsupported content" (p.276).
        break;
    }
  }

  if (Object.keys(sensors).length > 0) unit.sensors = sensors;
  if (controls.length > 0) unit.controls = controls;
  return unit;
}
