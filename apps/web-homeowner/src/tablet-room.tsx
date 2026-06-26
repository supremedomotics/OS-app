import { useEffect, useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId, RoomId } from "@supreme/domain-model";
import { client } from "./api.js";
import { LightingDetail } from "./lighting.js";

/**
 * Tablet room experience (§11.1, Ovio iPad layout): a bento mosaic of light tiles around
 * a large central lighting disc. Each colour light is a draggable NODE on the disc — a
 * warm dim disc in White mode, a full HSV wheel in Colour mode — so a whole room of lights
 * is tuned on one canvas. Long-press a tile for Dim / Colour / Off.
 */
type Light = { id: string; name: string; hue: number; sat: number; on: boolean; level: number };

export function TabletRoom({ roomId, name, onBack }: { roomId: string; name: string; onBack: () => void }) {
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
            const c = (d.state as Record<string, { hue?: number; saturation?: number; on?: boolean; level?: number }>).color ?? {};
            return { id: d.id, name: d.name, hue: c.hue ?? 40, sat: (c.saturation ?? 70) / 100, on: c.on ?? false, level: c.level ?? 0 };
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
  const toggle = (id: string) => {
    setLights((ls) => ls.map((l) => (l.id === id ? { ...l, on: !l.on } : l)));
    const l = lights.find((x) => x.id === id);
    void client.command(id as DeviceId, { capability: "brightness", action: l?.on ? "off" : "on" } as CapabilityCommand);
    setMenu(null);
  };

  if (detail) return <LightingDetail device={detail} onClose={() => setDetail(null)} />;

  return (
    <div className="tablet-room" onClick={() => setMenu(null)}>
      <div className="tr-head">
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

        {/* Centre — the multi-light disc */}
        <div className="tr-centre">
          <MultiLightDisc
            lights={lights}
            mode={mode}
            selected={selected}
            onSelect={setSelected}
            onChange={setColour}
          />
          <button className="disc-mode" onClick={() => setMode((m) => (m === "colour" ? "white" : "colour"))} title="Toggle colour / white">
            <span className="ring" />
          </button>
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
              <span className="dot" style={{ background: l.on ? `hsl(${l.hue} ${Math.round(l.sat * 100)}% 60%)` : "var(--aureon-color-base-hairline)" }} />
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

function MultiLightDisc({ lights, mode, selected, onSelect, onChange }: { lights: Light[]; mode: "colour" | "white"; selected: string | null; onSelect: (id: string) => void; onChange: (id: string, hue: number, sat: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<string | null>(null);
  const handle = (id: string, clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
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
      {lights.map((l) => {
        const rad = ((l.hue - 90) * Math.PI) / 180;
        const left = `${50 + l.sat * R * 100 * Math.cos(rad)}%`;
        const top = `${50 + l.sat * R * 100 * Math.sin(rad)}%`;
        return (
          <span
            key={l.id}
            className={`node${selected === l.id ? " sel" : ""}${l.on ? "" : " off"}`}
            style={{ left, top, background: l.on ? `hsl(${l.hue} ${Math.round(l.sat * 100)}% 55%)` : "rgba(150,150,150,0.6)" }}
            onPointerDown={(e) => { drag.current = l.id; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); onSelect(l.id); }}
            onPointerMove={(e) => { if (drag.current === l.id) handle(l.id, e.clientX, e.clientY); }}
            onPointerUp={() => { drag.current = null; }}
          />
        );
      })}
    </div>
  );
}
