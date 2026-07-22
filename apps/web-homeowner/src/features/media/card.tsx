import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Device } from "@supreme/domain-model";
import { Icon } from "@supreme/aureon-web";
import { useLive } from "../../live.js";
import { cmd, fmtTime, type AudioCapabilityConfigView, type MediaStateView } from "./detail.js";
import { inputGlyph, mediaDeviceKind, mediaKindMeta } from "./capability-mapper.js";

export interface MediaDeviceCardProps {
  device: Device;
  /** Pass the resolved driver protocol when it's already in hand (e.g. from a registry fetch
   * the caller did anyway) for the most accurate icon; omit it and installer-classified
   * devices still render correctly, just without the "avr" protocol inference. */
  driverProtocol?: string | null;
  onOpen: () => void;
  trailing?: ReactNode;
}

/** Isolated so the once-a-second tick only re-renders this small element, never the whole
 * card (§ Performance: "progress updates every second, do NOT re-render entire card"). */
function LiveProgress({ positionSec, durationSec, playing }: { positionSec: number; durationSec: number; playing: boolean }) {
  const [, forceTick] = useState(0);
  const anchor = useRef<{ value: number; at: number }>({ value: positionSec, at: Date.now() });
  useEffect(() => {
    anchor.current = { value: positionSec, at: Date.now() };
  }, [positionSec]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);
  const current = Math.min(durationSec, anchor.current.value + (playing ? (Date.now() - anchor.current.at) / 1000 : 0));
  const pct = durationSec > 0 ? Math.max(0, Math.min(100, (current / durationSec) * 100)) : 0;
  return (
    <div className="room-media-progress">
      <div className="room-media-progress-track"><div className="room-media-progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="room-media-progress-time">
        <span>{fmtTime(current)}</span>
        <span>-{fmtTime(Math.max(0, durationSec - current))}</span>
      </div>
    </div>
  );
}

/**
 * The Media module's Room Device Card (§ Room Device Card redesign) — one capability-driven,
 * genuinely live card for every media device. Reads `useLive()` itself (not a caller-computed
 * status string) so it updates in real time from the same WSS stream the detail console uses —
 * no polling. When the device reports real album art, the art fills the card with an adaptive
 * scrim for text contrast; with no art (or nothing playing), an input-themed background
 * replaces it — capability-driven from the device's own declared current input, never a blank
 * tile. Sizing is a CSS container query on the card's own rendered width, not the viewport, so
 * the same component looks right whether it's in a wide grid or a narrow sidebar.
 */
export function MediaDeviceCard({ device, driverProtocol, onOpen, trailing }: MediaDeviceCardProps) {
  const { states } = useLive();
  const meta = mediaKindMeta(mediaDeviceKind(device, driverProtocol));
  const mediaCap = device.capabilities.find((c) => c.kind === "media");
  const config = (mediaCap?.config ?? {}) as AudioCapabilityConfigView;
  const hasOnoff = device.capabilities.some((c) => c.kind === "onoff");
  const live = (states[device.id]?.media ?? (device.state as Record<string, MediaStateView> | undefined)?.media ?? {}) as Partial<MediaStateView>;
  const power = (states[device.id]?.onoff ?? (device.state as Record<string, { on?: boolean }> | undefined)?.onoff) as { on?: boolean } | undefined;

  const playing = live.playback === "playing";
  const hasArt = !!live.artworkUrl;
  const currentInput = config.inputs?.find((i) => i.id === live.source);
  const hasProgress = typeof live.positionSec === "number" && typeof live.durationSec === "number" && live.durationSec > 0;

  const setPower = (e: React.MouseEvent) => {
    e.stopPropagation();
    void cmd(device.id, { capability: "onoff", action: power?.on ? "off" : "on" });
  };
  const setMuted = (e: React.MouseEvent) => {
    e.stopPropagation();
    void cmd(device.id, { capability: "media", action: live.muted ? "unmute" : "mute" });
  };
  const setVolume = (v: number) => void cmd(device.id, { capability: "media", action: "volume", volume: v });

  return (
    <button
      className={`room-media-card${hasArt ? " has-art" : ""}${playing ? " playing" : ""}${!hasArt ? ` input-${currentInput?.type ?? "none"}` : ""}`}
      onClick={onOpen}
    >
      {hasArt ? (
        <>
          {/* Native browser caching (unchanged src -> no re-fetch) is exactly "cache album
              art, only refresh when track changes" — no extra cache layer needed. */}
          <img className="room-media-card-art" src={live.artworkUrl ?? undefined} alt="" />
          <div className="room-media-card-scrim" />
        </>
      ) : (
        <div className="room-media-card-inputbg" aria-hidden="true">
          <span className="room-media-card-inputbg-ic">{inputGlyph(currentInput?.type)}</span>
        </div>
      )}

      <div className="room-media-card-content">
        <div className="room-media-card-top">
          <span className="room-media-card-ic"><Icon name={meta.iconName} size={18} /></span>
          <span className="room-media-card-name">{device.name}</span>
          <span className={`room-media-card-status${power?.on === false ? " off" : ""}`} aria-hidden="true" />
          {trailing}
        </div>

        <div className="room-media-card-mid">
          {live.title ? (
            <>
              <span className="room-media-card-title">{live.title}</span>
              {(live.artist ?? live.album) && (
                <span className="room-media-card-artist">{[live.artist, live.album].filter(Boolean).join(" — ")}</span>
              )}
            </>
          ) : (
            <span className="room-media-card-idle">{currentInput?.label ?? "Idle"}</span>
          )}
        </div>

        {hasProgress && <LiveProgress positionSec={live.positionSec!} durationSec={live.durationSec!} playing={playing} />}

        <div className="room-media-card-controls">
          {hasOnoff && (
            <button className={`room-media-card-btn${power?.on ? " on" : ""}`} onClick={setPower} aria-label={power?.on ? "Turn off" : "Turn on"}>⏻</button>
          )}
          <button className="room-media-card-btn" onClick={setMuted} aria-label={live.muted ? "Unmute" : "Mute"}>{live.muted ? "🔇" : "🔈"}</button>
          <input
            className="room-media-card-vol"
            type="range" min={0} max={100} value={live.volume ?? 0}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
          />
          {currentInput && <span className="room-media-card-input-chip">{currentInput.label}</span>}
        </div>
      </div>
    </button>
  );
}
