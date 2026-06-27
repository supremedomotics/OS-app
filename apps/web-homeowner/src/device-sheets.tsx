import { useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import { useLive } from "./live.js";

/**
 * Ovio-style device-detail BOTTOM SHEETS — a sheet slides up over the dimmed room with a
 * grab handle, a Title + status subtitle, and capability-specific controls (climate dual
 * setpoint, cover up/stop/down, lock unlatch/unlock, switch turn-off, media transport).
 */
export function DeviceSheet({ device, onClose }: { device: Device; onClose: () => void }) {
  const caps = device.capabilities.map((c) => c.kind);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <span className="grab" />
        {caps.includes("temperature") ? (
          <ClimateSheet device={device} />
        ) : caps.includes("position") ? (
          <CoverSheet device={device} />
        ) : caps.includes("lock") ? (
          <LockSheet device={device} />
        ) : caps.includes("media") ? (
          <MediaSheet device={device} />
        ) : (
          <SwitchSheet device={device} />
        )}
      </div>
    </div>
  );
}

const cmd = (id: string, c: CapabilityCommand) => client.command(id as DeviceId, c);

function Title({ name, status }: { name: string; status: string }) {
  return (
    <div className="sheet-title">
      <h2>{name}</h2>
      <p>{status}</p>
    </div>
  );
}

// ── Climate ─────────────────────────────────────────────────────────────────────
function ClimateSheet({ device }: { device: Device }) {
  const t = (device.state as Record<string, { ambientC?: number; targetC?: number; targetLowC?: number; targetHighC?: number; mode?: string }>).temperature ?? {};
  const [low, setLow] = useState<number>(t.targetLowC ?? (t.targetC ?? 21) - 1);
  const [high, setHigh] = useState<number>(t.targetHighC ?? (t.targetC ?? 21) + 2);
  const [mode, setMode] = useState<string>(t.mode ?? "auto");
  const send = (lo: number, hi: number) => void cmd(device.id, { capability: "temperature", targetLowC: lo, targetHighC: hi } as CapabilityCommand);
  const modes: [string, string][] = [["heat", "🔥"], ["cool", "❄"], ["fan_only", "≋"], ["auto", "⚙"], ["off", "⏻"]];
  return (
    <>
      <Title name={device.name} status={`${(t.ambientC ?? 20).toFixed(1)}° Inside`} />
      <div className="setpoints">
        <Stepper value={low} onChange={(v) => { setLow(v); send(v, high); }} />
        <Stepper value={high} onChange={(v) => { setHigh(v); send(low, v); }} />
      </div>
      <div className="sheet-row"><span className="muted">Mode</span><strong style={{ textTransform: "capitalize" }}>{mode.replace("_", " ")}</strong></div>
      <div className="mode-row">
        {modes.map(([m, ic]) => (
          <button key={m} className={`mode-btn${mode === m ? " on" : ""}`} onClick={() => { setMode(m); void cmd(device.id, { capability: "temperature", mode: m } as CapabilityCommand); }}>
            <span>{ic}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.round((value - 0.5) * 10) / 10)}>−</button>
      <span className="val">{value.toFixed(1)}°</span>
      <button onClick={() => onChange(Math.round((value + 0.5) * 10) / 10)}>+</button>
    </div>
  );
}

// ── Cover ───────────────────────────────────────────────────────────────────────
function CoverSheet({ device }: { device: Device }) {
  const { states, apply } = useLive();
  const live = (states[device.id]?.position ?? (device.state as Record<string, { position?: number }>).position) as { position?: number } | undefined;
  const pos = live?.position ?? 0;
  const act = (action: "open" | "close" | "stop") => void cmd(device.id, { capability: "position", action } as CapabilityCommand);
  const set = (p: number) => { apply(device.id, "position", { kind: "position", position: p, moving: false }); void cmd(device.id, { capability: "position", action: "set", position: p } as CapabilityCommand); };
  return (
    <>
      <Title name={device.name} status={`${Math.round(pos)}% open`} />
      <div className="cover-ctl">
        <button onClick={() => act("open")}>↑</button>
        <button onClick={() => act("stop")}>↕</button>
        <button onClick={() => act("close")}>↓</button>
      </div>
      <input className="cover-slider" type="range" min={0} max={100} value={Math.round(pos)} onChange={(e) => set(Number(e.target.value))} />
    </>
  );
}

// ── Lock ────────────────────────────────────────────────────────────────────────
function LockSheet({ device }: { device: Device }) {
  const ls = (device.state as Record<string, { locked?: boolean }>).lock ?? {};
  const [locked, setLocked] = useState<boolean>(ls.locked ?? true);
  const toggle = (next: boolean) => { setLocked(next); void cmd(device.id, { capability: "lock", action: next ? "lock" : "unlock" } as CapabilityCommand); };
  return (
    <>
      <Title name={device.name} status={locked ? "Locked" : "Unlocked"} />
      <div className="lock-actions">
        <button className="lock-secondary" onClick={() => toggle(false)}>Unlatch</button>
        <SlideUnlock onUnlock={() => toggle(false)} relock={() => toggle(true)} locked={locked} />
      </div>
    </>
  );
}

function SlideUnlock({ onUnlock, relock, locked }: { onUnlock: () => void; relock: () => void; locked: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const drag = useRef(false);
  const move = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setX(Math.max(0, Math.min(r.width - 56, clientX - r.left - 28)));
  };
  const end = () => {
    const el = ref.current;
    drag.current = false;
    if (el && x > el.getBoundingClientRect().width - 90) onUnlock();
    setX(0);
  };
  return (
    <div
      ref={ref}
      className={`slide-unlock${locked ? "" : " done"}`}
      onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (drag.current) move(e.clientX); }}
      onPointerUp={end}
    >
      <span className="knob" style={{ left: x }}>{locked ? "🔓" : "🔒"}</span>
      <span className="label">{locked ? "Slide to unlock" : "Unlocked — slide to lock"}</span>
      {!locked && <button className="relock" onClick={relock}>Lock</button>}
    </div>
  );
}

// ── Switch ──────────────────────────────────────────────────────────────────────
function SwitchSheet({ device }: { device: Device }) {
  const os = (device.state as Record<string, { on?: boolean }>).onoff ?? {};
  const [on, setOn] = useState<boolean>(os.on ?? false);
  return (
    <>
      <Title name={device.name} status={on ? "On" : "Off"} />
      <button className="big-action" onClick={() => { const n = !on; setOn(n); void cmd(device.id, { capability: "onoff", action: n ? "on" : "off" } as CapabilityCommand); }}>
        {on ? "Turn off" : "Turn on"}
      </button>
    </>
  );
}

// ── Media ───────────────────────────────────────────────────────────────────────
function MediaSheet({ device }: { device: Device }) {
  const m = (device.state as Record<string, { playback?: string; title?: string; artist?: string; source?: string; volume?: number }>).media ?? {};
  const [playing, setPlaying] = useState<boolean>(m.playback === "playing");
  const [vol, setVol] = useState<number>(m.volume ?? 30);
  const a = (action: string, extra?: Record<string, unknown>) => cmd(device.id, { capability: "media", action, ...extra } as CapabilityCommand);
  return (
    <>
      <Title name={device.name} status={m.title ? `${m.title}${m.artist ? ` · ${m.artist}` : ""}` : m.source ?? "Idle"} />
      <div className="media-transport">
        <button onClick={() => void a("previous")}>⏮</button>
        <button className="pp" onClick={() => { setPlaying((p) => !p); void a(playing ? "pause" : "play"); }}>{playing ? "⏸" : "▶"}</button>
        <button onClick={() => void a("next")}>⏭</button>
      </div>
      <input className="cover-slider" type="range" min={0} max={100} value={vol} onChange={(e) => { const v = Number(e.target.value); setVol(v); void a("volume", { volume: v }); }} />
    </>
  );
}
