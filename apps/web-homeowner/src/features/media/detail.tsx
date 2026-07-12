import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client, fetchDriverRegistry } from "../../api.js";
import { useLive } from "../../live.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "../../device-detail-sections.js";
import { useAsync } from "../../use-async.js";
import { MEDIA_KIND_OPTIONS, mediaDeviceKind, mediaKindMeta, type MediaDeviceKind } from "./capability-mapper.js";

/**
 * The AVR/Receiver console (§ AVR Detail Page) — a rich, capability-driven control
 * surface for any `media` device, replacing the plain MediaSheet for the Media page's
 * device-detail view. Every section is driven entirely by this device's own
 * AudioCapabilityConfig (`device.capabilities.find(c => c.kind === "media").config`)
 * and live MediaState — nothing here is hardcoded per brand. A device that declares no
 * inputs, no sound modes, no advanced controls, and no transport support renders a
 * console with those sections simply absent, exactly like a Denon Telnet unit (no
 * transport, no artwork) vs a HEOS player (full transport, no DSP modes) vs a Yamaha
 * zone (both) — the same shape serves Denon/Marantz/Yamaha/HEOS today and any future
 * brand (Onkyo/Pioneer/Anthem/Arcam/NAD/Sonos/BluOS/WiiM/…) that reports this config.
 */

// ── Capability-config types (mirrors @supreme/protocols' AudioCapabilityConfig) ──────
interface AvrInputCfg { id: string; label: string; type?: string }
interface AvrSoundModeCfg { id: string; label: string }
interface AvrRangeCfg { min: number; max: number; step: number }
interface AvrAdvancedControlCfg {
  key: string;
  label: string;
  kind: "toggle" | "select" | "range";
  icon?: string;
  options?: { id: string; label: string }[];
  range?: AvrRangeCfg;
}
interface AvrZoneCfg { id: string; label: string; inputs: AvrInputCfg[] }
interface AudioCapabilityConfigView {
  source?: string;
  inputs?: AvrInputCfg[];
  soundModes?: AvrSoundModeCfg[];
  volumeRange?: AvrRangeCfg;
  toneControl?: { bass: AvrRangeCfg; treble: AvrRangeCfg };
  zones?: AvrZoneCfg[];
  transport?: { play?: boolean; pause?: boolean; stop?: boolean; next?: boolean; previous?: boolean; seek?: boolean; shuffle?: boolean; repeat?: boolean };
  presets?: { id: string; label: string }[];
  bluetooth?: boolean;
  advancedControls?: AvrAdvancedControlCfg[];
}
interface MediaStateView {
  playback: "playing" | "paused" | "stopped" | "idle";
  volume: number;
  muted: boolean;
  title: string | null;
  artist: string | null;
  album?: string | null;
  source: string | null;
  artworkUrl: string | null;
  durationSec?: number | null;
  positionSec?: number | null;
  shuffle?: boolean | null;
  repeat?: "off" | "all" | "one" | null;
  advanced?: Record<string, unknown> | null;
}

const cmd = (id: string, c: CapabilityCommand) => client.command(id as DeviceId, c);

/** Haptic feedback on the (mostly mobile-web) browsers that support it — a genuine
 * physical cue on transport/mute/source taps, silently a no-op everywhere else
 * (desktop Chrome/Safari have no Vibration API; this never throws or blocks). */
function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // unsupported — fine
  }
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Loose, unvalidated icon hint → glyph. Unknown/absent types fall back to a generic
 * note — never a hard requirement, matching AvrInput.type's own "display hint only"
 * contract. */
function inputGlyph(type?: string): string {
  switch (type) {
    case "hdmi": return "📺";
    case "optical": return "🔦";
    case "analog": return "🔌";
    case "tuner": return "📻";
    case "usb": return "🔧";
    case "bluetooth": return "🔵";
    case "streaming": return "☁️";
    case "network": return "🖴";
    default: return "♪";
  }
}

/** Loose, unvalidated icon hint for a listening-mode/sound-program name — matches common
 * substrings across brands' DSP vocabularies (Denon's "MOVIE"/"PURE DIRECT", Yamaha's
 * "sci-fi"/"straight", …) so hardware-style mode buttons get a sensible glyph without
 * ever hardcoding a specific brand's mode list. Falls back to a generic equalizer glyph. */
function soundModeGlyph(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("movie") || l.includes("cinema") || l.includes("theater")) return "🎬";
  if (l.includes("music") || l.includes("concert")) return "🎵";
  if (l.includes("game")) return "🎮";
  if (l.includes("direct") || l.includes("pure") || l.includes("straight")) return "◎";
  if (l.includes("dolby") || l.includes("dts") || l.includes("atmos") || l.includes("surround")) return "🌐";
  if (l.includes("stereo")) return "🎚️";
  if (l.includes("night")) return "🌙";
  return "🎛️";
}

/** Sibling zone devices of the SAME physical unit (§ Zone selector) — computed
 * client-side from discovery-captured network metadata (`metadata.network.ip/host`),
 * not a driver-level runtime zone switch (no protocol here has one — see the AVR
 * console data-contract notes). Empty when this device wasn't discovered with network
 * info, or no sibling shares it — the Zone control simply doesn't render then. */
function zoneSiblings(device: Device, allDevices: Device[]): Device[] {
  const net = (device.metadata as Record<string, unknown> | undefined)?.network as { ip?: string; host?: string } | undefined;
  const key = net?.ip ?? net?.host;
  if (!key) return [];
  return allDevices.filter((d) => {
    if (d.id === device.id) return false;
    if (!d.capabilities.some((c) => c.kind === "media")) return false;
    const dn = (d.metadata as Record<string, unknown> | undefined)?.network as { ip?: string; host?: string } | undefined;
    return (dn?.ip ?? dn?.host) === key;
  });
}

interface RoomStatusItem { icon: string; label: string; good: boolean }

/** Whole-Home Intelligence (§ Entertainment Status) — a slim, contextual read of the
 * room this receiver lives in, built entirely from real sibling devices' live state
 * (never fabricated): covers/curtains, lights, climate, plus the AVR's own zone/format.
 * A device this home doesn't have in the room (e.g. no covers) simply contributes no
 * pill — this is never a fixed checklist, it reflects whatever's actually installed. */
function roomStatus(device: Device, live: MediaStateView, roomDevices: Device[]): RoomStatusItem[] {
  const items: RoomStatusItem[] = [];
  const mates = roomDevices.filter((d) => d.id !== device.id && !d.capabilities.some((c) => c.kind === "media"));

  const covers = mates.filter((d) => d.capabilities.some((c) => c.kind === "position"));
  if (covers.length > 0) {
    const positions = covers.map((d) => ((d.state as Record<string, { position?: number }>).position?.position ?? 0));
    const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
    items.push(avg < 15
      ? { icon: "🪟", label: "Curtains Closed", good: true }
      : { icon: "🪟", label: `Curtains ${Math.round(avg)}% Open`, good: false });
  }

  const lights = mates.filter((d) => d.capabilities.some((c) => c.kind === "brightness" || c.kind === "onoff") && !d.capabilities.some((c) => c.kind === "position"));
  if (lights.length > 0) {
    const on = lights.filter((d) => {
      const s = d.state as Record<string, { on?: boolean; level?: number }>;
      return (s.brightness?.on ?? s.onoff?.on) === true;
    });
    if (on.length === 0) {
      items.push({ icon: "💡", label: "Lights Off", good: true });
    } else {
      const levels = on.map((d) => (d.state as Record<string, { level?: number }>).brightness?.level).filter((v): v is number => typeof v === "number");
      const avg = levels.length > 0 ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : null;
      items.push({ icon: "💡", label: avg !== null ? `Lights ${avg}%` : `${on.length} Light${on.length === 1 ? "" : "s"} On`, good: avg !== null && avg <= 25 });
    }
  }

  const climate = mates.find((d) => d.capabilities.some((c) => c.kind === "temperature"));
  if (climate) {
    const ambient = (climate.state as Record<string, { ambientC?: number }>).temperature?.ambientC;
    if (typeof ambient === "number") items.push({ icon: "🌡️", label: `${ambient.toFixed(0)}°C`, good: true });
  }

  items.push({ icon: "📡", label: device.status === "online" ? "AVR Online" : "AVR Offline", good: device.status === "online" });

  const soundMode = typeof live.advanced?.soundMode === "string" ? (live.advanced.soundMode as string) : null;
  if (soundMode) items.push({ icon: soundModeGlyph(soundMode), label: soundMode, good: true });

  return items;
}

/** A slim, elegant context strip — never a checklist. Read-only (this reflects other
 * devices' state; changing them belongs on their own cards). */
function EntertainmentStatus({ items }: { items: RoomStatusItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="avr-context">
      {items.map((it, i) => (
        <span key={i} className={`avr-context-item${it.good ? " good" : ""}`}>
          <span className="avr-context-ic">{it.icon}</span>{it.label}
        </span>
      ))}
    </div>
  );
}

/** Sample a real artwork image's dominant hue client-side (a downscaled canvas read —
 * cheap, no network round-trip) so the ambient halo can carry a whisper of the actual
 * cover art color instead of a fixed gold, the way a premium player's now-playing glow
 * does. Falls back to null (→ the console's own gold) for art-less devices or any
 * canvas/CORS failure — never blocks rendering on this. */
function useDominantColor(url: string | null): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    setColor(null);
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        const size = 16;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3] ?? 0;
          if (alpha < 32) continue;
          r += data[i] ?? 0; g += data[i + 1] ?? 0; b += data[i + 2] ?? 0; n++;
        }
        if (n === 0 || cancelled) return;
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        // Lift dark/muddy averages toward a usable glow brightness rather than
        // discarding them — a warm, present color reads better than none.
        const max = Math.max(r, g, b);
        if (max < 90 && max > 0) { const boost = 90 / max; r = Math.min(255, r * boost); g = Math.min(255, g * boost); b = Math.min(255, b * boost); }
        setColor(`rgb(${r | 0}, ${g | 0}, ${b | 0})`);
      } catch {
        // Cross-origin canvas taint or decode failure — the gold fallback is fine.
      }
    };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);
  return color;
}

// ── Ambient halo — SupremeOS's signature: a quiet, flowing glow that breathes with
// playback and carries a whisper of the artwork's own color; never a flat colored disc. ─
function AmbientHalo({ playing, tint }: { playing: boolean; tint: string | null }) {
  const style = tint ? ({ "--avr-halo-tint": tint } as React.CSSProperties) : undefined;
  return (
    <div className={`avr-halo${playing ? " on" : ""}`} style={style} aria-hidden="true">
      <span className="avr-halo-particle p1" />
      <span className="avr-halo-particle p2" />
      <span className="avr-halo-particle p3" />
      <span className="avr-halo-particle p4" />
    </div>
  );
}

function AlbumArt({ url, name, playing }: { url: string | null; name: string; playing: boolean }) {
  const tint = useDominantColor(url);
  return (
    <div className="avr-art-wrap">
      <AmbientHalo playing={playing} tint={tint} />
      <div className={`avr-art-float${playing ? " on" : ""}`}>
        {url ? (
          <img className="avr-art" src={url} alt="" />
        ) : (
          <div className="avr-art avr-art-placeholder">{name.charAt(0).toUpperCase()}</div>
        )}
      </div>
    </div>
  );
}

/** A full-width animated bar visualizer, fading softly into the card at both edges —
 * only animates while genuinely playing (§ Animation: "no flashing effects", bars ease,
 * never strobe). Purely decorative; the real transport state is the progress bar below
 * it. Bar count is fixed (not measured), but each bar is flex-sized so the row always
 * spans its container edge-to-edge regardless of card width. */
function Waveform({ playing, muted }: { playing: boolean; muted: boolean }) {
  const bars = 56;
  return (
    <div className={`avr-waveform${playing ? " on" : ""}${muted ? " muted" : ""}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={{ animationDelay: `${(i % 9) * 0.08}s` }} />
      ))}
    </div>
  );
}

const DIAL_TICK_COUNT = 48;

function VolumeDial({
  volume, volumeDb, muted, onChange, onMuteToggle,
}: { volume: number; volumeDb: number | null; muted: boolean; onChange: (v: number) => void; onMuteToggle: () => void }) {
  const r = 80;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, volume));
  const offset = c - (pct / 100) * c;
  const litTicks = Math.round((pct / 100) * DIAL_TICK_COUNT);
  // A tiny tick of haptic feedback each time the dial crosses a new whole tick mark —
  // mirrors a real knob's detents — but only where the Vibration API actually exists.
  const lastTickRef = useRef(litTicks);
  const handleChange = (v: number) => {
    const nextTicks = Math.round((Math.max(0, Math.min(100, v)) / 100) * DIAL_TICK_COUNT);
    if (nextTicks !== lastTickRef.current) { vibrate(4); lastTickRef.current = nextTicks; }
    onChange(v);
  };
  return (
    <div className="avr-dial-col">
      {/* Rotation-reactive lighting (§ Volume Knob: "lighting reacts while rotating") —
          the knob's specular glow genuinely brightens with the real volume level, not a
          fixed decoration. */}
      <div className="avr-dial" style={{ "--avr-dial-glow": (pct / 100).toFixed(2) } as CSSProperties}>
        <div className="avr-dial-ticks">
          {Array.from({ length: DIAL_TICK_COUNT }, (_, i) => (
            <span
              key={i}
              className={`avr-dial-tick${i < litTicks ? " on" : ""}${i % 4 === 0 ? " major" : ""}`}
              style={{ transform: `rotate(${(i / DIAL_TICK_COUNT) * 360}deg)` }}
            />
          ))}
        </div>
        <svg width="208" height="208" viewBox="0 0 208 208">
          <circle cx="104" cy="104" r={r} className="avr-dial-track" />
          <circle
            cx="104" cy="104" r={r} className="avr-dial-fill"
            strokeDasharray={c} strokeDashoffset={offset}
            transform="rotate(-90 104 104)"
          />
        </svg>
        <div className="avr-dial-label">
          <span className="avr-dial-value">{volumeDb !== null ? volumeDb.toFixed(1) : Math.round(volume)}</span>
          <span className="avr-dial-unit">{volumeDb !== null ? "dB" : "%"}</span>
          <span className="avr-dial-caption">MASTER VOLUME</span>
        </div>
        <input
          className="avr-dial-input"
          type="range" min={0} max={100} value={volume}
          onChange={(e) => handleChange(Number(e.target.value))}
          aria-label="Master volume"
        />
      </div>
      <div className="avr-dial-mute">
        <button className={`avr-icon-btn${muted ? " on" : ""}`} onClick={onMuteToggle} aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? "🔇" : "🔈"}
        </button>
      </div>
    </div>
  );
}

/** Hardware-style mode buttons (§ Listening Modes: "resemble luxury hardware buttons
 * rather than software chips") — a real icon per mode (matched generically, never a
 * fixed per-brand list) and a more dimensional pressed/engraved look than a pill chip. */
function ListeningModeSelector({ modes, active, onSelect }: { modes: AvrSoundModeCfg[]; active: string | null; onSelect: (id: string) => void }) {
  if (modes.length === 0) return null;
  return (
    <div className="avr-field">
      <span className="avr-field-label">Listening Mode</span>
      <div className="avr-hw-row">
        {modes.map((m) => (
          <button key={m.id} className={`avr-hw-btn${active === m.id ? " on" : ""}`} onClick={() => onSelect(m.id)}>
            <span className="avr-hw-ic">{soundModeGlyph(m.label)}</span>
            <span className="avr-hw-label">{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ZoneSelector({ current, siblings, onNavigate }: { current: Device; siblings: Device[]; onNavigate: (d: Device) => void }) {
  if (siblings.length === 0) return null;
  return (
    <div className="avr-field">
      <span className="avr-field-label">Zone</span>
      <div className="avr-chip-row">
        <button className="avr-chip on" disabled>{current.name}</button>
        {siblings.map((d) => (
          <button key={d.id} className="avr-chip" onClick={() => onNavigate(d)}>{d.name}</button>
        ))}
      </div>
    </div>
  );
}

/** Premium input tiles (§ Input Selection) — icon, name, connection type, and an active
 * glow, replacing a plain `<select>`. `pending` lights a brief loading ring on the tile
 * that was just tapped while its command is in flight (a real receiver's input switch
 * can take a second or two — this isn't decorative, it's the actual command state). */
function InputSelector({
  inputs, active, pending, onSelect,
}: { inputs: AvrInputCfg[]; active: string | null; pending: string | null; onSelect: (id: string) => void }) {
  if (inputs.length === 0) return null;
  return (
    <div className="avr-field">
      <span className="avr-field-label">Input</span>
      <div className="avr-input-tiles">
        {inputs.map((i) => (
          <button
            key={i.id}
            className={`avr-input-tile${active === i.id ? " on" : ""}${pending === i.id ? " loading" : ""}`}
            onClick={() => onSelect(i.id)}
            disabled={pending === i.id}
          >
            <span className="avr-input-tile-ic">{inputGlyph(i.type)}</span>
            <span className="avr-input-tile-name">{i.label}</span>
            {i.type && <span className="avr-input-tile-type">{i.type.toUpperCase()}</span>}
            {pending === i.id && <span className="avr-input-tile-spinner" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders whatever `advancedControls` this device declares — the ONLY mechanism a
 * brand-specific quick action (Sleep Timer, …) reaches this UI. A device that declares
 * none (HEOS today) simply shows Mute alone. */
function QuickActions({
  muted, onMuteToggle, controls, advanced, onSetAdvanced,
}: {
  muted: boolean; onMuteToggle: () => void;
  controls: AvrAdvancedControlCfg[]; advanced: Record<string, unknown>;
  onSetAdvanced: (key: string, value: unknown) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <div className="avr-quick">
      <span className="avr-field-label">Quick Actions</span>
      <div className="avr-quick-grid">
        <button className={`avr-quick-tile${muted ? " on" : ""}`} onClick={onMuteToggle}>
          <span className="avr-quick-ic">{muted ? "🔇" : "🔈"}</span>
          <span>Audio Mute</span>
        </button>
        {controls.map((ctl) => {
          const current = advanced[ctl.key];
          const currentOption = ctl.options?.find((o) => o.id === String(current));
          return (
            <div key={ctl.key} className="avr-quick-pop-wrap">
              <button
                className={`avr-quick-tile${current !== undefined && current !== 0 && current !== "0" ? " on" : ""}`}
                onClick={() => setOpenKey(openKey === ctl.key ? null : ctl.key)}
              >
                <span className="avr-quick-ic">{ctl.icon === "sleep" ? "⏾" : "⚙️"}</span>
                <span>{ctl.label}</span>
                <span className="avr-quick-val">{currentOption?.label ?? "—"}</span>
              </button>
              {openKey === ctl.key && ctl.kind === "select" && (
                <div className="avr-quick-pop">
                  {(ctl.options ?? []).map((o) => (
                    <button
                      key={o.id}
                      className={`avr-quick-pop-row${String(current) === o.id ? " on" : ""}`}
                      onClick={() => { onSetAdvanced(ctl.key, Number.isNaN(Number(o.id)) ? o.id : Number(o.id)); setOpenKey(null); }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SourceRail({
  inputs, active, pending, onSelect,
}: { inputs: AvrInputCfg[]; active: string | null; pending: string | null; onSelect: (id: string) => void }) {
  if (inputs.length === 0) return null;
  return (
    <div className="avr-source-rail">
      <span className="avr-field-label">Source</span>
      <div className="avr-source-list">
        {inputs.map((i) => (
          <button
            key={i.id}
            className={`avr-source-row${active === i.id ? " on" : ""}${pending === i.id ? " loading" : ""}`}
            onClick={() => onSelect(i.id)}
            disabled={pending === i.id}
          >
            <span className="avr-source-ic">{inputGlyph(i.type)}</span>
            <span className="avr-source-meta">
              <span className="avr-source-name">{i.label}</span>
              {i.type && <span className="avr-source-type">{i.type.toUpperCase()}</span>}
            </span>
            {pending === i.id ? <span className="avr-source-spinner" aria-hidden="true" /> : active === i.id ? <span className="avr-source-check">✓</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniPlayer({
  device, media, position, transportShown, onToggle, onVolume,
}: { device: Device; media: MediaStateView; position: number | null; transportShown: (a: "previous" | "next") => boolean; onToggle: () => void; onVolume: (v: number) => void }) {
  const playing = media.playback === "playing";
  return (
    <div className="avr-mini">
      <div className="avr-mini-art">
        {media.artworkUrl ? <img src={media.artworkUrl} alt="" /> : <span>♪</span>}
      </div>
      <div className="avr-mini-meta">
        <span className="avr-mini-title">{media.title ?? device.name}</span>
        <span className="avr-mini-sub">{media.artist ?? (playing ? "Playing" : "Idle")}</span>
      </div>
      <div className="avr-mini-transport">
        {transportShown("previous") && <button onClick={() => void cmd(device.id, { capability: "media", action: "previous" })}>⏮</button>}
        <button className="avr-mini-pp" onClick={onToggle}>{playing ? "⏸" : "▶"}</button>
        {transportShown("next") && <button onClick={() => void cmd(device.id, { capability: "media", action: "next" })}>⏭</button>}
      </div>
      {media.durationSec ? (
        <div className="avr-mini-progress">
          <span>{fmtTime(position ?? 0)}</span>
          <div className="avr-mini-bar"><div style={{ width: `${((position ?? 0) / media.durationSec) * 100}%` }} /></div>
          <span>{fmtTime(media.durationSec)}</span>
        </div>
      ) : null}
      <div className="avr-mini-vol">
        <span>🔈</span>
        <input type="range" min={0} max={100} value={media.volume} onChange={(e) => onVolume(Number(e.target.value))} />
        <span className="avr-mini-db">{typeof media.advanced?.volumeDb === "number" ? `${(media.advanced.volumeDb as number).toFixed(1)} dB` : `${media.volume}%`}</span>
      </div>
      <span className="avr-mini-zone">{device.name}</span>
    </div>
  );
}

export function AvrConsole({
  device, allDevices, homeDevices, roomName, onBack, onNavigateDevice, onRemoved, onDeviceUpdated, devMode = false,
}: {
  device: Device;
  allDevices: Device[];
  homeDevices: Device[];
  roomName: string;
  onBack: () => void;
  onNavigateDevice: (d: Device) => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  devMode?: boolean;
}) {
  const { states, apply } = useLive();
  const mediaCap = device.capabilities.find((c) => c.kind === "media");
  const config = (mediaCap?.config ?? {}) as AudioCapabilityConfigView;
  const onoff = device.capabilities.some((c) => c.kind === "onoff");
  const live = (states[device.id]?.media ?? (device.state as Record<string, MediaStateView>).media ?? {}) as MediaStateView;
  const power = (states[device.id]?.onoff ?? (device.state as Record<string, { on?: boolean }>).onoff) as { on?: boolean } | undefined;
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);

  const siblings = useMemo(() => zoneSiblings(device, allDevices), [device, allDevices]);
  const roomMates = useMemo(() => homeDevices.filter((d) => d.roomId === device.roomId), [homeDevices, device.roomId]);
  const inputs = config.inputs ?? [];
  const soundModes = config.soundModes ?? [];
  const advancedControls = config.advancedControls ?? [];
  const advanced = live.advanced ?? {};
  const transportCfg = config.transport;
  const transportShown = (action: "play" | "pause" | "next" | "previous" | "seek" | "shuffle" | "repeat") =>
    transportCfg ? transportCfg[action] !== false : true;

  const playing = live.playback === "playing";
  const volumeDb = typeof advanced.volumeDb === "number" ? (advanced.volumeDb as number) : null;
  const duration = live.durationSec ?? null;
  const soundMode = typeof advanced.soundMode === "string" ? (advanced.soundMode as string) : null;

  // A real receiver only reports positionSec on its own cadence (HEOS pushes progress
  // every few seconds; Yamaha/Denon only on poll) — ticking it forward locally between
  // those updates is what makes the progress bar read as "live" rather than jumpy. The
  // anchor resets to the server's true value on every real update; the tick timer only
  // ever advances the DISPLAYED estimate, never the value sent back to the device.
  const [positionAnchor, setPositionAnchor] = useState<{ value: number; at: number } | null>(null);
  useEffect(() => {
    setPositionAnchor(typeof live.positionSec === "number" ? { value: live.positionSec, at: Date.now() } : null);
  }, [live.positionSec, device.id]);
  const [positionTick, setPositionTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setPositionTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);
  const livePosition = useMemo(() => {
    if (!positionAnchor) return null;
    if (!playing) return positionAnchor.value;
    const elapsed = positionAnchor.value + (Date.now() - positionAnchor.at) / 1000;
    return duration != null ? Math.min(elapsed, duration) : elapsed;
    // positionTick is a deliberate no-op dependency — its only job is to force this
    // memo to recompute once a second while playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, positionTick, positionAnchor]);
  const position = seekPreview ?? livePosition;
  const contextItems = useMemo(() => roomStatus(device, live, roomMates), [device, live, roomMates]);

  const applyMedia = (patch: Partial<MediaStateView>) => apply(device.id, "media", { ...live, ...patch });
  const toggle = () => { vibrate(10); applyMedia({ playback: playing ? "paused" : "playing" }); void cmd(device.id, { capability: "media", action: playing ? "pause" : "play" }); };
  const setVolume = (v: number) => { applyMedia({ volume: v }); void cmd(device.id, { capability: "media", action: "volume", volume: v }); };
  const setMuted = () => { vibrate(12); applyMedia({ muted: !live.muted }); void cmd(device.id, { capability: "media", action: live.muted ? "unmute" : "mute" }); };
  // A real receiver's input switch can take a second or two — the `pending` state on
  // both input pickers (the tile row and the sidebar list) is genuine, not decorative.
  const setSource = (id: string) => {
    vibrate(8);
    setPendingSource(id);
    applyMedia({ source: id });
    void cmd(device.id, { capability: "media", action: "source", source: id }).finally(() => setPendingSource((p) => (p === id ? null : p)));
  };
  const setSoundMode = (id: string) => {
    applyMedia({ advanced: { ...advanced, soundMode: id } });
    void cmd(device.id, { capability: "media", action: "advanced", advanced: { soundMode: id } });
  };
  const setAdvanced = (key: string, value: unknown) => {
    applyMedia({ advanced: { ...advanced, [key]: value } });
    void cmd(device.id, { capability: "media", action: "advanced", advanced: { [key]: value } });
  };
  const setPower = (on: boolean) => {
    vibrate(10);
    apply(device.id, "onoff", { kind: "onoff", on });
    void cmd(device.id, { capability: "onoff", action: on ? "on" : "off" });
  };

  // Television / Speaker / AVR / Projector (§ Premium Device Experience Library — Media): all
  // four are the same real `media` capability, never a distinct backend concept — the label and
  // icon come from an explicit installer classification if one's been set, else the one real
  // signal that actually distinguishes anything (the "avr" driver protocol), else a conservative
  // "Speaker" default. See capability-mapper.ts.
  const [registry] = useAsync(() => fetchDriverRegistry());
  const driver = device.driverId ? registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null : null;
  const kind = mediaDeviceKind(device, driver?.protocols[0] ?? null);
  const kindMeta = mediaKindMeta(kind);
  const setKind = async (next: MediaDeviceKind) => {
    const res = await client.updateDevice(device.id, { metadata: { ...device.metadata, media: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  return (
    <div className="avr-console">
      <div className="avr-main">
        <div className="avr-head-card">
          <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
          <div className="avr-head-ic">{kindMeta.icon}</div>
          <div className="avr-head-meta">
            <h2>{device.name}</h2>
            <p>{roomName}</p>
            <span className={`avr-status${device.status === "online" ? " good" : ""}`}>
              <i /> {device.status === "online" ? "Online" : device.status === "offline" ? "Offline" : "Unavailable"}
            </span>
          </div>
          <div className="avr-head-actions">
            {onoff && (
              <button className={`avr-icon-btn${power?.on ? " on" : ""}`} onClick={() => setPower(!power?.on)} aria-label="Power">⏻</button>
            )}
          </div>
        </div>

        <EntertainmentStatus items={contextItems} />

        {/* One luxury surface (§ Hero Moment): art, now-playing info, waveform, and
            transport all live inside this single card so they visually belong together,
            instead of reading as several stacked panels. */}
        <div className={`avr-now${device.status !== "online" ? " offline" : ""}`}>
          <AlbumArt url={live.artworkUrl ?? null} name={device.name} playing={playing} />
          <div className="avr-now-meta">
            <span className="avr-now-label">NOW PLAYING</span>
            <h3>{live.title ?? "Idle"}</h3>
            {live.artist && <p className="avr-now-artist">{live.artist}</p>}
            {live.album && <p className="avr-now-album">{live.album}</p>}
            <div className="avr-badges">
              {soundMode && <span className="avr-badge">{soundMode}</span>}
              {typeof advanced.audioFormat === "string" && <span className="avr-badge">{advanced.audioFormat as string}</span>}
              {typeof advanced.sampleRateKHz === "number" && <span className="avr-badge">{advanced.sampleRateKHz as number} kHz</span>}
              {typeof advanced.bitDepth === "number" && <span className="avr-badge">{advanced.bitDepth as number}-bit</span>}
            </div>
            <Waveform playing={playing} muted={live.muted ?? false} />
            {duration ? (
              <div className="avr-progress">
                <input
                  type="range" min={0} max={duration} value={position ?? 0}
                  disabled={!transportShown("seek")}
                  onChange={(e) => setSeekPreview(Number(e.target.value))}
                  onMouseUp={(e) => { const v = Number((e.target as HTMLInputElement).value); setSeekPreview(null); applyMedia({ positionSec: v }); void cmd(device.id, { capability: "media", action: "seek", positionSec: v }); }}
                />
                <div className="avr-progress-time"><span>{fmtTime(position ?? 0)}</span><span>{fmtTime(duration)}</span></div>
              </div>
            ) : null}
            <div className="avr-transport-row">
              {transportShown("previous") && <button className="avr-icon-btn lg" onClick={() => void cmd(device.id, { capability: "media", action: "previous" })}>⏮</button>}
              {(transportShown("play") || transportShown("pause")) && (
                <button className="avr-icon-btn xl on" onClick={toggle}>{playing ? "⏸" : "▶"}</button>
              )}
              {transportShown("next") && <button className="avr-icon-btn lg" onClick={() => void cmd(device.id, { capability: "media", action: "next" })}>⏭</button>}
            </div>
          </div>
        </div>

        <div className="avr-fields-row">
          <InputSelector inputs={inputs} active={live.source ?? null} pending={pendingSource} onSelect={setSource} />
          <ListeningModeSelector modes={soundModes} active={soundMode} onSelect={setSoundMode} />
          <ZoneSelector current={device} siblings={siblings} onNavigate={onNavigateDevice} />
        </div>

        <VolumeDial volume={live.volume ?? 0} volumeDb={volumeDb} muted={live.muted ?? false} onChange={setVolume} onMuteToggle={setMuted} />
      </div>

      <aside className="avr-sidebar">
        <SourceRail inputs={inputs} active={live.source ?? null} pending={pendingSource} onSelect={setSource} />
        <QuickActions muted={live.muted ?? false} onMuteToggle={setMuted} controls={advancedControls} advanced={advanced} onSetAdvanced={setAdvanced} />

        {/* § Design System — Universal Page Structure: same sections every device detail
            page shows, capability- and data-driven, never protocol-driven. */}
        <InformationSection device={device} roomName={roomName} />
        {devMode && <DiagnosticsSection device={device} />}
        <AutomationsSection device={device} />
        <HistorySection device={device} />
        <AdvancedSettingsSection device={device} onRemoved={onRemoved}>
          {/* Television/Speaker/AVR/Projector is an installer classification, not a driver-
              reported fact (§ capability-mapper.ts) — same "installer-entered" pattern as
              ClimateConsole's brand/unit type, editable right alongside rename/remove. */}
          <label className="drv-field" style={{ marginBottom: 10 }}>
            <span className="lbl">Device type</span>
            <select value={kind} onChange={(e) => void setKind(e.target.value as MediaDeviceKind)}>
              {MEDIA_KIND_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.icon} {o.label}</option>)}
            </select>
          </label>
        </AdvancedSettingsSection>
      </aside>

      <MiniPlayer device={device} media={live} position={livePosition} transportShown={(a) => transportShown(a)} onToggle={toggle} onVolume={setVolume} />
    </div>
  );
}
