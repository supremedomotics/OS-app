import { useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";

/**
 * Purpose-built lighting control (§11.1) — a large brightness dial, an HSV colour wheel,
 * and a warm→cool temperature slider, shown per the light's capabilities. Drives the
 * Supreme `brightness` + `color` commands; the homeowner never sees a backend.
 */
export function LightingDetail({ device, onClose }: { device: Device; onClose: () => void }) {
  const st = device.state as Record<string, { on?: boolean; level?: number; hue?: number; saturation?: number; kelvin?: number }>;
  const hasColour = device.capabilities.some((c) => c.kind === "color");
  const [on, setOn] = useState<boolean>(st.brightness?.on ?? st.onoff?.on ?? false);
  const [level, setLevel] = useState<number>(st.brightness?.level ?? (on ? 100 : 0));
  const [hue, setHue] = useState<number>(st.color?.hue ?? 40);
  const [sat, setSat] = useState<number>((st.color?.saturation ?? 60) / 100);
  const [kelvin, setKelvin] = useState<number>(st.color?.kelvin ?? 2700);
  const [mode, setMode] = useState<"colour" | "white">("colour");

  const cmd = (c: CapabilityCommand) => client.command(device.id as DeviceId, c);
  const setBrightness = (v: number) => {
    const val = Math.round(v);
    setLevel(val);
    setOn(val > 0);
    void cmd({ capability: "brightness", action: "set", level: val } as CapabilityCommand);
  };
  const setColour = (h: number, s: number) => {
    setHue(h);
    setSat(s);
    void cmd({ capability: "color", hue: Math.round(h), saturation: Math.round(s * 100) } as CapabilityCommand);
  };
  const setTemp = (k: number) => {
    setKelvin(Math.round(k));
    void cmd({ capability: "color", kelvin: Math.round(k) } as CapabilityCommand);
  };

  return (
    <div className="light-detail">
      <div className="screen-head">
        <button className="back" onClick={onClose}>‹ Back</button>
        <button className={`edit-btn${on ? " on" : ""}`} onClick={() => { const n = !on; setOn(n); void cmd({ capability: hasColour || st.brightness ? "brightness" : "onoff", action: n ? "on" : "off" } as CapabilityCommand); }}>
          {on ? "On" : "Off"}
        </button>
      </div>
      <h1 className="title">{device.name}</h1>

      <div className="light-cols">
        <BrightnessBar value={level / 100} hue={hue} sat={sat} mode={mode} kelvin={kelvin} onChange={(v) => setBrightness(v * 100)} />
        <div className="light-right">
          <div className="readout">{Math.round(level)}%</div>
          {hasColour && (
            <div className="seg" style={{ marginTop: 8 }}>
              <button className={mode === "colour" ? "on" : ""} onClick={() => setMode("colour")}>Colour</button>
              <button className={mode === "white" ? "on" : ""} onClick={() => setMode("white")}>White</button>
            </div>
          )}
        </div>
      </div>

      {hasColour && mode === "colour" && <ColorWheel hue={hue} sat={sat} onChange={setColour} />}
      {hasColour && mode === "white" && <TempSlider kelvin={kelvin} onChange={setTemp} />}
    </div>
  );
}

function BrightnessBar({ value, hue, sat, mode, kelvin, onChange }: { value: number; hue: number; sat: number; mode: "colour" | "white"; kelvin: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const fromY = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height)));
  };
  const fill = mode === "white" ? kelvinToCss(kelvin) : `hsl(${hue} ${Math.round(sat * 100)}% 60%)`;
  return (
    <div
      ref={ref}
      className="bright-bar"
      onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromY(e.clientY); }}
      onPointerMove={(e) => { if (drag.current) fromY(e.clientY); }}
      onPointerUp={() => { drag.current = false; }}
    >
      <div className="bright-fill" style={{ height: `${value * 100}%`, background: `linear-gradient(180deg, ${fill}, ${fill})` }}>
        <span className="bright-ic">☀</span>
      </div>
    </div>
  );
}

function ColorWheel({ hue, sat, onChange }: { hue: number; sat: number; onChange: (h: number, s: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
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
        onPointerUp={() => { drag.current = false; }}
      >
        <span className="wheel-thumb" style={{ left: tx, top: ty, background: `hsl(${hue} ${Math.round(sat * 100)}% 50%)` }} />
      </div>
    </div>
  );
}

function TempSlider({ kelvin, onChange }: { kelvin: number; onChange: (k: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const MIN = 2200, MAX = 6500;
  const t = (kelvin - MIN) / (MAX - MIN);
  const fromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(MIN + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (MAX - MIN));
  };
  return (
    <div className="temp-wrap">
      <div
        ref={ref}
        className="temp-bar"
        onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromX(e.clientX); }}
        onPointerMove={(e) => { if (drag.current) fromX(e.clientX); }}
        onPointerUp={() => { drag.current = false; }}
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
