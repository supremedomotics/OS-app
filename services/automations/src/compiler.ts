import type { Automation } from "@supreme/domain-model";

/**
 * Compile a Supreme automation to a Home Assistant automation config (§10). This is
 * the `engine = "ha"` path: the SIL would push this config to HA and store the
 * returned id as `externalRef`. It lives here (not above the SIL) so the rest of
 * the system never sees HA shapes. Phase-3 produces the config; wiring it into a
 * live HA is done by the SIL HaAdapter when an HA backend is present.
 */
export interface HaAutomationConfig {
  alias: string;
  trigger: Record<string, unknown>[];
  condition: Record<string, unknown>[];
  action: Record<string, unknown>[];
}

export function compileToHa(a: Automation): HaAutomationConfig {
  return {
    alias: `supreme:${a.id}`,
    trigger: a.triggers.map((t) => {
      if (t.type === "device_state") {
        return { platform: "state", entity_id: `supreme.${t.deviceId}`, attribute: t.field };
      }
      if (t.type === "time") return { platform: "time", at: t.at };
      return { platform: "time_pattern", minutes: `/${t.everyMinutes}` };
    }),
    condition: a.conditions.map((c) =>
      c.type === "time_window"
        ? { condition: "time", after: c.window.start, before: c.window.end }
        : { condition: "state", entity_id: `supreme.${c.deviceId}`, state: String(c.value) },
    ),
    action: a.actions.map((act) => {
      if (act.type === "scene_activate") return { service: "scene.turn_on", target: { entity_id: `supreme.${act.sceneId}` } };
      if (act.type === "delay") return { delay: { milliseconds: act.ms } };
      if (act.type === "notify") return { service: "notify.supreme", data: { title: act.title, message: act.body } };
      return { service: "supreme.command", data: { device: act.deviceId, command: act.command } };
    }),
  };
}
