import { useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import { useLive } from "./live.js";
import { getDeviceUiCapabilities } from "./device-ui-capabilities.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "./device-detail-sections.js";

/**
 * Purpose-built lighting control (§11.1) — a large brightness dial, an HSV colour wheel,
 * and a warm→cool temperature slider, shown per the light's capabilities. Drives the
 * Supreme `brightness` + `color` commands; the homeowner never sees a backend.
 *
 * Live-fed: every value reads through {@link useLive}, so a change made elsewhere (another
 * screen, a physical switch, Casambi's own app) shows up here immediately — and every local
 * drag writes optimistically into the SAME live state via `apply`, so the two never diverge.
 */
type ColorSt = { on?: boolean; level?: number; hue?: number | null; saturation?: number | null; kelvin?: number | null };
type BrightnessSt = { on?: boolean; level?: number };

/**
 * § PASS 23 bug fix — resolves which colour-mode tab is actually shown, given the user's
 * last explicit tab click (`override`, sticky across renders) and whether RGB/CCT are
 * CURRENTLY available. `ui.showRGB`/`ui.showCCT` aren't static: when a device has no
 * driver-reported structural `colorModes` config yet, `getDeviceUiCapabilities` falls back
 * to inferring them from LIVE state (`colormode.ts`'s hue/kelvin nullability check), which
 * changes every time a CCT/RGB command or feedback telegram updates `color` state. Without
 * this guard, a user's earlier tab click stuck even after that inference flipped — e.g.
 * clicking "Colour" while both looked available, then a kelvin-only feedback telegram
 * arrives and `showRGB` becomes false — leaving `mode === "colour"` while `ui.showRGB` is
 * false AND `mode !== "white"`, so NEITHER the ColorWheel nor the TempSlider's render guard
 * matches: the control silently vanishes mid-interaction. Exported for direct unit testing
 * (no React harness needed — this is the entire bug, isolated).
 */
export function resolveColorMode(
  override: "colour" | "white" | null,
  showRGB: boolean,
  showCCT: boolean,
): "colour" | "white" {
  const overrideStillValid = override === "colour" ? showRGB : override === "white" ? showCCT : false;
  if (overrideStillValid) return override!;
  return !showRGB && showCCT ? "white" : "colour";
}

export function LightingDetail({ device, onClose, onRemoved, roomName, devMode = false }: { device: Device; onClose: () => void; onRemoved?: () => void; roomName?: string; devMode?: boolean }) {
  const { states, apply } = useLive();
  const live = states[device.id] as Record<string, unknown> | undefined;
  const merged = { ...device.state, ...live } as Record<string, ColorSt | BrightnessSt | { on?: boolean } | undefined>;
  const brightness = merged.brightness as BrightnessSt | undefined;
  const onoff = merged.onoff as { on?: boolean } | undefined;
  const color = merged.color as ColorSt | undefined;
  // Shared, single-source-of-truth capability derivation (§ ADR 0016 Capability-Driven UI) —
  // the SAME helper room-lighting.tsx's room-aggregate uses, so both surfaces can never drift.
  const ui = getDeviceUiCapabilities(device.capabilities, color);

  const on = brightness?.on ?? onoff?.on ?? color?.on ?? false;
  const level = brightness?.level ?? color?.level ?? (on ? 100 : 0);
  const hue = color?.hue ?? 40;
  const sat = (color?.saturation ?? 60) / 100;
  const kelvin = color?.kelvin ?? 2700;

  // Which colour mode is shown — only meaningful when the light supports both; a single-mode
  // light just shows its one control, no tab.
  const [modeOverride, setModeOverride] = useState<"colour" | "white" | null>(null);
  const mode = resolveColorMode(modeOverride, ui.showRGB, ui.showCCT);

  const cmd = (c: CapabilityCommand) => client.command(device.id as DeviceId, c);
  // § PASS 18 bug fix — split into a VISUAL-only apply (fires continuously during drag,
  // never sends a command) and a COMMIT that sends the actual command exactly once, on
  // pointer release. Live-proven: a single drag gesture previously fired 6 separate
  // command HTTP requests, each racing the others to the KNX bus with no ordering
  // guarantee — the physical light settled on whichever one happened to land last, not
  // necessarily the value the user released on.
  const showBrightness = (v: number) => {
    const val = Math.round(v);
    apply(device.id, "brightness", { kind: "brightness", on: val > 0, level: val });
  };
  const commitBrightness = (v: number) => {
    const val = Math.round(v);
    apply(device.id, "brightness", { kind: "brightness", on: val > 0, level: val });
    void cmd({ capability: "brightness", action: "set", level: val } as CapabilityCommand);
  };
  const showColour = (h: number, s: number) => {
    apply(device.id, "color", { kind: "color", on: true, level, hue: Math.round(h), saturation: Math.round(s * 100), kelvin: null });
  };
  const commitColour = (h: number, s: number) => {
    apply(device.id, "color", { kind: "color", on: true, level, hue: Math.round(h), saturation: Math.round(s * 100), kelvin: null });
    void cmd({ capability: "color", hue: Math.round(h), saturation: Math.round(s * 100) } as CapabilityCommand);
  };
  const showTemp = (k: number) => {
    const kr = Math.round(k);
    apply(device.id, "color", { kind: "color", on: true, level, hue: null, saturation: null, kelvin: kr });
  };
  const commitTemp = (k: number) => {
    const kr = Math.round(k);
    apply(device.id, "color", { kind: "color", on: true, level, hue: null, saturation: null, kelvin: kr });
    void cmd({ capability: "color", kelvin: kr } as CapabilityCommand);
  };
  const toggle = () => {
    const n = !on;
    apply(device.id, ui.showBrightness ? "brightness" : "onoff", ui.showBrightness ? { kind: "brightness", on: n, level: n ? (level > 0 ? level : 100) : 0 } : { kind: "onoff", on: n });
    void cmd({ capability: ui.showBrightness ? "brightness" : "onoff", action: n ? "on" : "off" } as CapabilityCommand);
  };

  return (
    <div className="light-detail">
      <div className="screen-head">
        <button className="back" onClick={onClose}>‹ Back</button>
        <button className={`edit-btn${on ? " on" : ""}`} onClick={toggle}>
          {on ? "On" : "Off"}
        </button>
      </div>
      <h1 className="title">{device.name}</h1>

      <div className="light-cols">
        <BrightnessBar value={level / 100} hue={hue} sat={sat} mode={mode} kelvin={kelvin} onChange={(v) => showBrightness(v * 100)} onCommit={(v) => commitBrightness(v * 100)} />
        <div className="light-right">
          <div className="readout">{Math.round(level)}%</div>
          {ui.showRGB && ui.showCCT && (
            <div className="seg" style={{ marginTop: 8 }}>
              <button className={mode === "colour" ? "on" : ""} onClick={() => setModeOverride("colour")}>Colour</button>
              <button className={mode === "white" ? "on" : ""} onClick={() => setModeOverride("white")}>White</button>
            </div>
          )}
        </div>
      </div>

      {ui.showRGB && mode === "colour" && <ColorWheel hue={hue} sat={sat} onChange={showColour} onCommit={commitColour} />}
      {ui.showCCT && mode === "white" && <TempSlider kelvin={kelvin} onChange={showTemp} onCommit={commitTemp} />}

      {/* § Design System — Universal Page Structure: same five sections every device detail
          page shows, capability- and data-driven, never protocol-driven. */}
      <div className="sheet-sections">
        <InformationSection device={device} roomName={roomName} />
        {devMode && <DiagnosticsSection device={device} />}
        <AutomationsSection device={device} />
        <HistorySection device={device} />
        <AdvancedSettingsSection device={device} onRemoved={onRemoved} />
      </div>
    </div>
  );
}

// § PASS 18 bug fix (live-proven: one real drag gesture produced 6 separate command
// HTTP requests, each targeting a different intermediate value — the actual cause of
// "dimming needs multiple slider moves before it settles," since those 6 unordered
// async KNX writes can complete in any order and the physical light ends up wherever
// the LAST one to actually land on the bus was, not necessarily the value the user
// released on). `onChange` still fires on every pointer move — needed for smooth
// continuous VISUAL feedback while dragging (unchanged) — but the actual command is
// now sent exactly once, from `onCommit`, on pointer release, with the final value.
function BrightnessBar({ value, hue, sat, mode, kelvin, onChange, onCommit }: { value: number; hue: number; sat: number; mode: "colour" | "white"; kelvin: number; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const last = useRef(value);
  const fromY = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
    last.current = v;
    onChange(v);
  };
  const fill = mode === "white" ? kelvinToCss(kelvin) : `hsl(${hue} ${Math.round(sat * 100)}% 60%)`;
  return (
    <div
      ref={ref}
      className="bright-bar"
      onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromY(e.clientY); }}
      onPointerMove={(e) => { if (drag.current) fromY(e.clientY); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; onCommit(last.current); } }}
    >
      <div className="bright-fill" style={{ height: `${value * 100}%`, background: `linear-gradient(180deg, ${fill}, ${fill})` }}>
        <span className="bright-ic">☀</span>
      </div>
    </div>
  );
}

// § PASS 18 bug fix — same fix as BrightnessBar above: `onChange` drives continuous
// visual feedback during drag; `onCommit` sends the actual command exactly once, on
// release, with the final hue/saturation.
export function ColorWheel({ hue, sat, onChange, onCommit }: { hue: number; sat: number; onChange: (h: number, s: number) => void; onCommit: (h: number, s: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const last = useRef({ h: hue, s: sat });
  const handle = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const s = Math.min(1, dist / (r.width / 2));
    let h = (Math.atan2(dx, -dy) * 180) / Math.PI; // clockwise from top → matches conic from 0deg
    if (h < 0) h += 360;
    last.current = { h, s };
    onChange(h, s);
  };
  const R = 120;
  const rad = ((hue - 90) * Math.PI) / 180; // back to math angle for thumb placement
  const tx = R + sat * R * Math.cos(rad);
  const ty = R + sat * R * Math.sin(rad);
  return (
    <div className="wheel-wrap">
      <div
        ref={ref}
        className="wheel"
        onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); handle(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (drag.current) handle(e.clientX, e.clientY); }}
        onPointerUp={() => { if (drag.current) { drag.current = false; onCommit(last.current.h, last.current.s); } }}
      >
        <span className="wheel-thumb" style={{ left: tx, top: ty, background: `hsl(${hue} ${Math.round(sat * 100)}% 50%)` }} />
      </div>
    </div>
  );
}

// § PASS 18 bug fix — same fix as BrightnessBar/ColorWheel above.
export function TempSlider({ kelvin, onChange, onCommit }: { kelvin: number; onChange: (k: number) => void; onCommit: (k: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const last = useRef(kelvin);
  const MIN = 2200, MAX = 6500;
  const t = (kelvin - MIN) / (MAX - MIN);
  const fromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = MIN + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (MAX - MIN);
    last.current = k;
    onChange(k);
  };
  return (
    <div className="temp-wrap">
      <div
        ref={ref}
        className="temp-bar"
        onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromX(e.clientX); }}
        onPointerMove={(e) => { if (drag.current) fromX(e.clientX); }}
        onPointerUp={() => { if (drag.current) { drag.current = false; onCommit(last.current); } }}
      >
        <span className="temp-thumb" style={{ left: `calc(${t * 100}% - 14px)` }} />
      </div>
      <p className="muted" style={{ textAlign: "center" }}>{Math.round(kelvin)}K</p>
    </div>
  );
}

function kelvinToCss(k: number): string {
  // Cheap warm→cool mapping for the brightness-fill tint in white mode.
  const t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
  const warm = [255, 184, 103];
  const cool = [207, 229, 255];
  const c = warm.map((w, i) => Math.round(w + (cool[i]! - w) * t));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}
