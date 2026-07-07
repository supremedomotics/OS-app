import { useEffect, useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId, RoomId } from "@supreme/domain-model";
import { client } from "./api.js";
import { LightingDetail } from "./lighting.js";
import { useRoomPhoto, styleForPhoto } from "./room-image.js";
import { useHeroFlip } from "./herotransition.js";

/**
 * Tablet room experience (§11.1, Ovio iPad layout): a bento mosaic of light tiles around
 * a large central lighting disc. Each colour light is a draggable NODE on the disc — a
 * warm dim disc in White mode, a full HSV wheel in Colour mode — so a whole room of lights
 * is tuned on one canvas. Long-press a tile for Dim / Colour / Off.
 */
type Light = { id: string; name: string; hue: number; sat: number; kelvin: number; on: boolean; level: number };

// Tunable-white range (warm → cool). The `color` capability carries kelvin alongside hue/saturation,
// so one disc drives both RGB(W) colour and tunable white.
const K_MIN = 2200;
const K_MAX = 6500;
/** Approximate the glow of a colour temperature — warm amber-white → cool blue-white. */
function kelvinColor(k: number): string {
  const t = Math.max(0, Math.min(1, (k - K_MIN) / (K_MAX - K_MIN)));
  const r = Math.round(255 - t * 55);
  const g = Math.round(180 + t * 40);
  const b = Math.round(120 + t * 135);
  return `rgb(${r}, ${g}, ${b})`;
}

export function TabletRoom({ roomId, name, heroImageUrl, heroOrigin, onBack }: { roomId: string; name: string; heroImageUrl?: string | null; heroOrigin?: DOMRect | null; onBack: () => void }) {
  const headPhoto = useRoomPhoto({ name, heroImageUrl }, client);
  const heroRef = useHeroFlip<HTMLDivElement>(heroOrigin ?? null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [lights, setLights] = useState<Light[]>([]);
  const [mode, setMode] = useState<"colour" | "white">("colour");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Device | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    void client.devicesInRoom(roomId as RoomId).then((r) => {
      if (!live) return;
      setDevices(r.devices);
      setLights(
        r.devices
          .filter((d) => d.capabilities.some((c) => c.kind === "color"))
          .map((d) => {
            const c = (d.state as Record<string, { hue?: number; saturation?: number; kelvin?: number; on?: boolean; level?: number }>).color ?? {};
            return { id: d.id, name: d.name, hue: c.hue ?? 40, sat: (c.saturation ?? 70) / 100, kelvin: c.kelvin ?? 3000, on: c.on ?? false, level: c.level ?? 0 };
          }),
      );
    });
    return () => { live = false; };
  }, [roomId]);

  const others = devices.filter((d) => !d.capabilities.some((c) => c.kind === "color"));
  const onCount = lights.filter((l) => l.on).length;

  const setColour = (id: string, hue: number, sat: number) => {
    setLights((ls) => ls.map((l) => (l.id === id ? { ...l, hue, sat, on: true } : l)));
    void client.command(id as DeviceId, { capability: "color", hue: Math.round(hue), saturation: Math.round(sat * 100) } as CapabilityCommand);
  };
  // White mode drives the correlated colour temperature (tunable white) on the same `color` capability.
  const setKelvin = (id: string, kelvin: number) => {
    const k = Math.round(kelvin);
    setLights((ls) => ls.map((l) => (l.id === id ? { ...l, kelvin: k, on: true } : l)));
    void client.command(id as DeviceId, { capability: "color", kelvin: k } as CapabilityCommand);
  };
  const toggle = (id: string) => {
    setLights((ls) => ls.map((l) => (l.id === id ? { ...l, on: !l.on } : l)));
    const l = lights.find((x) => x.id === id);
    void client.command(id as DeviceId, { capability: "brightness", action: l?.on ? "off" : "on" } as CapabilityCommand);
    setMenu(null);
  };

  if (detail) return <LightingDetail device={detail} onClose={() => setDetail(null)} />;

  return (
    <div className="tablet-room" onClick={() => setMenu(null)}>
      <div ref={heroRef} className="tr-head has-image" style={(() => { const { emoji, ...s } = styleForPhoto(headPhoto, { name, heroImageUrl }, 0.55); return s; })()}>
        <button className="back" onClick={onBack}>‹ Rooms</button>
        <h1 className="title" style={{ margin: 0 }}>{name}</h1>
        <span />
      </div>

      <div className="tr-grid">
        {/* Left column — aggregate + a room master tile */}
        <div className="tr-col">
          <div className="bento agg tall">
            <span className="big">{onCount}</span>
            <span className="lbl">{onCount === 1 ? "light on" : "lights on"}</span>
          </div>
          <div className="bento">
            <span className="dot" style={{ background: "var(--aureon-color-gold-400)" }} />
            <span className="nm">Lights</span>
          </div>
        </div>

        {/* Centre — the multi-light disc. Only meaningful when the room HAS colour-capable lights;
            a room with none (or only on/off + dimmers) shows no wheel. */}
        <div className="tr-centre">
          {lights.length > 0 ? (
            <>
              <MultiLightDisc
                lights={lights}
                mode={mode}
                selected={selected}
                onSelect={setSelected}
                onChange={setColour}
                onKelvin={setKelvin}
              />
              <button className="disc-mode" onClick={() => setMode((m) => (m === "colour" ? "white" : "colour"))} title="Toggle colour / white">
                {/* Icon reflects the active mode: rainbow for colour, warm→cool for white. */}
                <span className={`ring ${mode === "white" ? "cct" : "rgb"}`} />
              </button>
            </>
          ) : (
            <div className="tr-empty">
              <span className="big">{others.length}</span>
              <span className="lbl">{others.length === 1 ? "device" : "devices"} · no colour lights</span>
            </div>
          )}
        </div>

        {/* Right — the bento mosaic of individual lights */}
        <div className="tr-mosaic">
          {lights.map((l) => (
            <button
              key={l.id}
              className={`bento light${selected === l.id ? " sel" : ""}`}
              onClick={() => setSelected(l.id)}
              onDoubleClick={() => setDetail(devices.find((d) => d.id === l.id) ?? null)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: l.id, x: e.clientX, y: e.clientY }); }}
            >
              <span className="dot" style={{ background: !l.on ? "var(--aureon-color-base-hairline)" : mode === "white" ? kelvinColor(l.kelvin) : `hsl(${l.hue} ${Math.round(l.sat * 100)}% 60%)` }} />
              <span className="nm">{l.name}</span>
            </button>
          ))}
          {others.map((d) => (
            <div key={d.id} className="bento">
              <span className="nm">{d.name}</span>
            </div>
          ))}
        </div>
      </div>

      {menu && (
        <div className="ctx" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setDetail(devices.find((d) => d.id === menu.id) ?? null); setMenu(null); }}>☀ Dim</button>
          <button onClick={() => { setSelected(menu.id); setMode("colour"); setMenu(null); }}>◉ Select on colour picker</button>
          <button onClick={() => toggle(menu.id)}>⏻ Turn off</button>
        </div>
      )}
    </div>
  );
}

function MultiLightDisc({ lights, mode, selected, onSelect, onChange, onKelvin }: { lights: Light[]; mode: "colour" | "white"; selected: string | null; onSelect: (id: string) => void; onChange: (id: string, hue: number, sat: number) => void; onKelvin: (id: string, kelvin: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<string | null>(null);
  const handle = (id: string, clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (mode === "white") {
      // Tunable white: horizontal position across the disc → colour temperature (warm ↔ cool).
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      onKelvin(id, K_MIN + frac * (K_MAX - K_MIN));
      return;
    }
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const sat = Math.min(1, Math.sqrt(dx * dx + dy * dy) / (r.width / 2));
    let h = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (h < 0) h += 360;
    onChange(id, h, sat);
  };
  const R = 0.5; // fraction
  return (
    <div ref={ref} className={`disc ${mode}`}>
      {lights.map((l, i) => {
        // Colour mode: polar position from hue/saturation. White mode: horizontal position from kelvin,
        // with a gentle vertical stagger so lights at a similar temperature stay individually grabbable.
        let left: string, top: string;
        if (mode === "white") {
          const frac = Math.max(0, Math.min(1, (l.kelvin - K_MIN) / (K_MAX - K_MIN)));
          left = `${8 + frac * 84}%`;
          const spread = lights.length > 1 ? (i - (lights.length - 1) / 2) * 14 : 0;
          top = `${Math.max(18, Math.min(82, 50 + spread))}%`;
        } else {
          const rad = ((l.hue - 90) * Math.PI) / 180;
          left = `${50 + l.sat * R * 100 * Math.cos(rad)}%`;
          top = `${50 + l.sat * R * 100 * Math.sin(rad)}%`;
        }
        const bg = !l.on ? "rgba(150,150,150,0.6)" : mode === "white" ? kelvinColor(l.kelvin) : `hsl(${l.hue} ${Math.round(l.sat * 100)}% 55%)`;
        return (
          <span
            key={l.id}
            className={`node${selected === l.id ? " sel" : ""}${l.on ? "" : " off"}`}
            style={{ left, top, background: bg }}
            onPointerDown={(e) => { drag.current = l.id; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); onSelect(l.id); }}
            onPointerMove={(e) => { if (drag.current === l.id) handle(l.id, e.clientX, e.clientY); }}
            onPointerUp={() => { drag.current = null; }}
          />
        );
      })}
    </div>
  );
}
