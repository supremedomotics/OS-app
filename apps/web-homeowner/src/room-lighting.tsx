import { useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import { useLive } from "./live.js";
import { colorModes } from "./colormode.js";
import { DeviceTile } from "./device-tile.js";
import { LightingDetail, ColorWheel, TempSlider } from "./lighting.js";

type ColorSt = { on?: boolean; level?: number; hue?: number | null; saturation?: number | null; kelvin?: number | null };
type BrightnessSt = { on?: boolean; level?: number };

/**
 * The room's Lighting page (§11.1): reached via Room → Lighting on the category screen. A master
 * "all lights" control, room-wide colour-temperature and colour controls — each shown ONLY when the
 * room actually has a light that supports it — and every individual light as a tap-to-toggle,
 * drag-to-dim tile. Tapping a light's chevron opens its own full {@link LightingDetail}. Everything
 * here is live: a change made anywhere else (another screen, a physical switch, the driver's own
 * app) reflects immediately, because every value reads through {@link useLive}.
 */
export function RoomLighting({ name, lights, onBack, onDeviceRemoved, devMode = false }: { roomId: string; name: string; lights: Device[]; onBack: () => void; onDeviceRemoved?: () => void; devMode?: boolean }) {
  const { states, apply } = useLive();
  const [detail, setDetail] = useState<Device | null>(null);

  const stateOf = (d: Device) => ({ ...d.state, ...states[d.id] }) as Record<string, ColorSt | BrightnessSt | undefined>;
  const colorOf = (d: Device) => stateOf(d).color as ColorSt | undefined;
  const onOf = (d: Device) => {
    const s = stateOf(d);
    const b = s.brightness as BrightnessSt | undefined;
    const c = s.color as ColorSt | undefined;
    const o = s.onoff as { on?: boolean } | undefined;
    return b?.on ?? c?.on ?? o?.on ?? false;
  };
  const levelOf = (d: Device) => {
    const s = stateOf(d);
    const b = s.brightness as BrightnessSt | undefined;
    const c = s.color as ColorSt | undefined;
    return b?.level ?? c?.level ?? (onOf(d) ? 100 : 0);
  };

  const onCount = lights.filter(onOf).length;
  // The master switch reflects "is anything on" (matches the room-summary convention used
  // elsewhere in the app), not "is everything on" — a single light left on should still read
  // as the room being on. Tapping mirrors the same rule: turns everything off from any partial
  // or fully-on state, or everything on from fully off.
  const anyOn = onCount > 0;
  const rgbLights = lights.filter((d) => colorModes(colorOf(d)).rgb);
  const cctLights = lights.filter((d) => colorModes(colorOf(d)).cct);
  // The group control's thumb position anchors on the room's first light in that mode — simplest
  // honest starting point when the room's lights may currently differ.
  const rgbAnchor = rgbLights.length > 0 ? colorOf(rgbLights[0]!) : undefined;
  const cctAnchor = cctLights.length > 0 ? colorOf(cctLights[0]!) : undefined;

  if (detail) {
    return (
      <LightingDetail
        device={detail}
        onClose={() => setDetail(null)}
        onRemoved={() => { setDetail(null); onDeviceRemoved?.(); }}
        roomName={name}
        devMode={devMode}
      />
    );
  }

  function setAll(on: boolean) {
    for (const d of lights) {
      const hasBrightness = d.capabilities.some((c) => c.kind === "brightness");
      if (hasBrightness) {
        apply(d.id, "brightness", { kind: "brightness", on, level: on ? (levelOf(d) > 0 ? levelOf(d) : 100) : 0 });
        void client.command(d.id as DeviceId, { capability: "brightness", action: on ? "on" : "off" } as CapabilityCommand);
      } else {
        apply(d.id, "onoff", { kind: "onoff", on });
        void client.command(d.id as DeviceId, { capability: "onoff", action: on ? "on" : "off" } as CapabilityCommand);
      }
    }
  }
  function setGroupKelvin(k: number) {
    const kr = Math.round(k);
    for (const d of cctLights) {
      apply(d.id, "color", { kind: "color", on: true, level: levelOf(d), hue: null, saturation: null, kelvin: kr });
      void client.command(d.id as DeviceId, { capability: "color", kelvin: kr } as CapabilityCommand);
    }
  }
  function setGroupColour(h: number, s: number) {
    for (const d of rgbLights) {
      apply(d.id, "color", { kind: "color", on: true, level: levelOf(d), hue: Math.round(h), saturation: Math.round(s * 100), kelvin: null });
      void client.command(d.id as DeviceId, { capability: "color", hue: Math.round(h), saturation: Math.round(s * 100) } as CapabilityCommand);
    }
  }

  return (
    <div className="room-lighting">
      <button className="back" onClick={onBack}>‹ {name}</button>
      <h1 className="title">Lighting</h1>

      {lights.length > 0 && (
        <button className={`rl-master${anyOn ? " on" : ""}`} onClick={() => setAll(!anyOn)}>
          <span className="rl-master-ic" aria-hidden>☀</span>
          <span className="rl-master-body">
            <span className="rl-master-lbl">All lights</span>
            <span className="rl-master-sub">{onCount} of {lights.length} on</span>
          </span>
          <span className={`rl-master-sw${anyOn ? " on" : ""}`}><span className="rl-master-knob" /></span>
        </button>
      )}

      {(cctLights.length > 0 || rgbLights.length > 0) && (
        <div className="rl-group">
          {cctLights.length > 0 && (
            <div className="rl-group-item">
              <span className="rl-group-lbl">Room colour temperature</span>
              <TempSlider kelvin={cctAnchor?.kelvin ?? 2700} onChange={setGroupKelvin} />
            </div>
          )}
          {rgbLights.length > 0 && (
            <div className="rl-group-item">
              <span className="rl-group-lbl">Room colour</span>
              <ColorWheel hue={rgbAnchor?.hue ?? 40} sat={(rgbAnchor?.saturation ?? 60) / 100} onChange={setGroupColour} />
            </div>
          )}
        </div>
      )}

      <div className="rl-grid">
        {lights.map((d) => (
          <DeviceTile key={d.id} device={d} onOpen={() => setDetail(d)} />
        ))}
      </div>
    </div>
  );
}
