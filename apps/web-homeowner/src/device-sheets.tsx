import { useRef, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { Icon, Sheet } from "@supreme/aureon-web";
import { client } from "./api.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "./device-detail-sections.js";
import { useLive } from "./live.js";

/**
 * Device-detail overlay (§ Design System — Universal Page Structure) — a right-hand panel on
 * desktop/tablet, a sheet that slides up over the dimmed room on mobile ({@link Sheet} picks the
 * presentation from the viewport). Every device gets the SAME seven sections in the SAME order —
 * Overview, Controls, Information, Diagnostics, Automations, History, Advanced Settings — routed
 * entirely off this device's capabilities, never its protocol; a section or field that has
 * nothing real behind it simply doesn't render, rather than the page taking a different shape
 * per device type (§ "only show fields that exist").
 *
 * Overview + Controls are the capability-specific sheet below (a climate dual setpoint, cover
 * up/stop/down, lock unlatch/unlock, switch turn-off, media transport, …) — its `Title` is the
 * Overview, its body is Controls. Everything from Information down is common to every device.
 */
export function DeviceSheet({ device, onClose, roomName, devMode = false, onRemoved }: {
  device: Device; onClose: () => void; roomName?: string; devMode?: boolean; onRemoved?: () => void;
}) {
  const caps = device.capabilities.map((c) => c.kind);
  return (
    <Sheet open onClose={onClose} aria-label={`${device.name} controls`}>
      {caps.includes("temperature") ? (
        <ClimateSheet device={device} />
      ) : caps.includes("position") ? (
        <CoverSheet device={device} />
      ) : caps.includes("lock") ? (
        <LockSheet device={device} />
      ) : caps.includes("fan") ? (
        <FanSheet device={device} />
      ) : caps.includes("vacuum") ? (
        <VacuumSheet device={device} />
      ) : caps.includes("media") ? (
        <MediaSheet device={device} />
      ) : (
        <SwitchSheet device={device} />
      )}

      <div className="sheet-sections">
        <InformationSection device={device} roomName={roomName} />
        {devMode && <DiagnosticsSection device={device} />}
        <AutomationsSection device={device} />
        <HistorySection device={device} />
        <AdvancedSettingsSection device={device} onRemoved={onRemoved} />
      </div>
    </Sheet>
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

/** Shared by the Lock Expanded Sheet above and the Security module's Premium Detail Page
 * ({@link ../features/security/lock-detail.js}) — one slide-to-unlock gesture, not two. */
export function SlideUnlock({ onUnlock, relock, locked }: { onUnlock: () => void; relock: () => void; locked: boolean }) {
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
      <span className="knob" style={{ left: x }}><Icon name={locked ? "lock-unlocked" : "lock-locked"} size={20} /></span>
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

// ── Fan ─────────────────────────────────────────────────────────────────────────
function FanSheet({ device }: { device: Device }) {
  const f = (device.state as Record<string, { on?: boolean; preset?: string; direction?: string }>).fan ?? {};
  const [on, setOn] = useState<boolean>(f.on ?? true);
  const [preset, setPreset] = useState<string>(f.preset ?? "auto");
  const [dir, setDir] = useState<string>(f.direction ?? "forward");
  return (
    <>
      <Title name={device.name} status={on ? "On" : "Off"} />
      <div className="preset-row">
        {["auto", "sleep", "turbo"].map((p) => (
          <button key={p} className={`preset${preset === p ? " on" : ""}`} onClick={() => { setPreset(p); void cmd(device.id, { capability: "fan", action: "preset", preset: p as "auto" } as CapabilityCommand); }}>
            {p[0]!.toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      <div className="icon-row">
        <button onClick={() => { const d = dir === "forward" ? "reverse" : "forward"; setDir(d); void cmd(device.id, { capability: "fan", action: "direction", direction: d as "forward" } as CapabilityCommand); }}>{dir === "forward" ? "↻" : "↺"}</button>
        <button className={`pwr${on ? " on" : ""}`} onClick={() => { const n = !on; setOn(n); void cmd(device.id, { capability: "fan", action: n ? "on" : "off" } as CapabilityCommand); }}>⏻</button>
      </div>
    </>
  );
}

// ── Vacuum ──────────────────────────────────────────────────────────────────────
function VacuumSheet({ device }: { device: Device }) {
  const v = (device.state as Record<string, { status?: string; fanSpeed?: string }>).vacuum ?? {};
  const [status, setStatus] = useState<string>(v.status ?? "idle");
  const [speed, setSpeed] = useState<string>(v.fanSpeed ?? "normal");
  const act = (action: "start" | "pause" | "stop", s: string) => { setStatus(s); void cmd(device.id, { capability: "vacuum", action } as CapabilityCommand); };
  return (
    <>
      <Title name={device.name} status={status[0]!.toUpperCase() + status.slice(1)} />
      <div className="preset-row">
        {["quiet", "normal", "turbo"].map((s) => (
          <button key={s} className={`preset${speed === s ? " on" : ""}`} onClick={() => { setSpeed(s); void cmd(device.id, { capability: "vacuum", action: "fan", fanSpeed: s as "quiet" } as CapabilityCommand); }}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="icon-row">
        <button onClick={() => act("pause", "paused")}>⏸</button>
        <button className="stop" onClick={() => act("stop", "idle")}>⏹</button>
      </div>
    </>
  );
}

// ── Media ───────────────────────────────────────────────────────────────────────
interface MediaCapState {
  playback?: string;
  title?: string | null;
  artist?: string | null;
  source?: string | null;
  volume?: number;
  artworkUrl?: string | null;
  durationSec?: number | null;
  positionSec?: number | null;
  shuffle?: boolean | null;
  repeat?: "off" | "all" | "one" | null;
}
interface MediaInput {
  id: string;
  label: string;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function MediaSheet({ device }: { device: Device }) {
  const { states, apply } = useLive();
  const live = (states[device.id]?.media ?? (device.state as Record<string, MediaCapState>).media ?? {}) as MediaCapState;
  const [picker, setPicker] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  // Dynamic capability detection (Universal AVR Framework §7): the input list comes
  // from this device's own advertised AudioCapabilityConfig (device-reported or
  // installer-declared, depending on the protocol) — never a hardcoded brand list.
  const mediaCap = device.capabilities.find((c) => c.kind === "media");
  const inputs = Array.isArray(mediaCap?.config.inputs) ? (mediaCap.config.inputs as MediaInput[]) : [];

  const a = (action: string, extra?: Record<string, unknown>) => cmd(device.id, { capability: "media", action, ...extra } as CapabilityCommand);
  const applyMedia = (patch: Partial<MediaCapState>) => apply(device.id, "media", { ...live, ...patch });

  const playing = live.playback === "playing";
  const vol = live.volume ?? 0;
  const duration = live.durationSec ?? null;
  const position = seekPreview ?? live.positionSec ?? null;

  if (picker) {
    return (
      <>
        <Title name="Home" status="Choose inputs" />
        <div className="source-list">
          {inputs.length === 0 ? (
            <p className="muted">No inputs configured for this device.</p>
          ) : (
            inputs.map((s) => (
              <button key={s.id} className="source-row" onClick={() => { applyMedia({ source: s.id }); void a("source", { source: s.id }); setPicker(false); }}>
                <span className="thumb" />
                <span className="nm">{s.label}</span>
                <span className={`radio${live.source === s.id ? " on" : ""}`} />
              </button>
            ))
          )}
        </div>
      </>
    );
  }

  const sourceLabel = inputs.find((i) => i.id === live.source)?.label ?? live.source ?? "Speakers";

  return (
    <>
      <div className="sheet-title with-badge">
        <button className="src-badge" onClick={() => setPicker(true)}>{sourceLabel} ⌄</button>
        <h2>{device.name}</h2>
        <p>{live.title ? `${live.title}${live.artist ? ` · ${live.artist}` : ""}` : "Idle"}</p>
      </div>
      {live.artworkUrl ? <img className="media-artwork" src={live.artworkUrl} alt="" /> : null}
      {duration ? (
        <div className="media-progress">
          <input
            className="cover-slider"
            type="range"
            min={0}
            max={duration}
            value={position ?? 0}
            onChange={(e) => setSeekPreview(Number(e.target.value))}
            onMouseUp={(e) => { const v = Number((e.target as HTMLInputElement).value); setSeekPreview(null); applyMedia({ positionSec: v }); void a("seek", { positionSec: v }); }}
            onTouchEnd={(e) => { const v = Number((e.target as HTMLInputElement).value); setSeekPreview(null); applyMedia({ positionSec: v }); void a("seek", { positionSec: v }); }}
          />
          <div className="media-time">
            <span>{formatTime(position ?? 0)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      ) : null}
      <div className="media-transport">
        <button onClick={() => void a("previous")}>⏮</button>
        <button className="pp" onClick={() => { applyMedia({ playback: playing ? "paused" : "playing" }); void a(playing ? "pause" : "play"); }}>{playing ? "⏸" : "▶"}</button>
        <button onClick={() => void a("next")}>⏭</button>
      </div>
      {live.shuffle !== null && live.shuffle !== undefined || live.repeat !== null && live.repeat !== undefined ? (
        <div className="toggle-row">
          {live.shuffle !== null && live.shuffle !== undefined ? (
            <button className={`toggle-chip${live.shuffle ? " on" : ""}`} onClick={() => { const next = !live.shuffle; applyMedia({ shuffle: next }); void a("shuffle", { shuffle: next }); }}>
              🔀 Shuffle
            </button>
          ) : null}
          {live.repeat !== null && live.repeat !== undefined ? (
            <button className={`toggle-chip${live.repeat !== "off" ? " on" : ""}`} onClick={() => { const next = live.repeat === "off" ? "all" : live.repeat === "all" ? "one" : "off"; applyMedia({ repeat: next }); void a("repeat", { repeat: next }); }}>
              {live.repeat === "one" ? "🔂" : "🔁"} Repeat{live.repeat === "one" ? " One" : ""}
            </button>
          ) : null}
        </div>
      ) : null}
      <input className="cover-slider" type="range" min={0} max={100} value={vol} onChange={(e) => { const v = Number(e.target.value); applyMedia({ volume: v }); void a("volume", { volume: v }); }} />
    </>
  );
}
