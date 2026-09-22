import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Device } from "@supreme/domain-model";
import { Card, CapabilityGate, Icon, QuickActions } from "@supreme/aureon-web";
import { useLive } from "../../live.js";
import {
  AdvancedSettingsSection,
  AutomationsSection,
  DiagnosticsSection,
  HistorySection,
  InformationSection,
} from "../../device-detail-sections.js";
import { client } from "../../api.js";
import { capabilityAvailability } from "../_shared/capability-availability.js";
import { cmd, type AudioCapabilityConfigView, type MediaStateView } from "./detail.js";
import { MEDIA_KIND_OPTIONS, mediaDeviceKind, mediaKindMeta, type MediaDeviceKind } from "./capability-mapper.js";

/**
 * The Media Player master page (§ Media Player Remote) — the permanent premium detail page
 * for `media_player`/`apple_tv` kind devices (Apple TV, and anything else classified the same
 * way), replacing the AVR/receiver console for this kind. An AVR console (zones, tone
 * controls, listening-mode DSP, input matrix) is the wrong shape for a streaming box — it has
 * none of that; what it has is exactly what a physical remote has: a directional pad, a
 * select/menu/home button, and play/pause. Modeled on the 3rd-generation Apple TV remote's
 * layout (circular touch D-pad, Menu bottom-left, Play/Pause bottom-right) since that's the
 * first and reference `remote`-capability driver (apple-tv-driver.ts), but nothing here names
 * Apple TV specifically — any driver that binds `remote` + `media` renders the identical page.
 *
 * Capability-driven, not protocol-driven (§ Development principles): the whole D-pad/Menu/Home
 * block gates on the device actually having a `remote` capability binding, and Play/Pause/
 * Previous/Next each gate on `media`'s own transport config exactly like AvrConsole's
 * `transportShown` — a device with `remote` but no `media` (or vice versa) simply shows the
 * half it has, never a fabricated control for the half it doesn't.
 */
export function MediaPlayerRemote({
  device, roomName, onBack, onRemoved, onDeviceUpdated, devMode = false,
}: {
  device: Device;
  roomName: string;
  onBack: () => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  devMode?: boolean;
}) {
  const { states } = useLive();
  const kind = mediaDeviceKind(device, null);
  const kindMeta = mediaKindMeta(kind);

  const mediaCap = device.capabilities.find((c) => c.kind === "media");
  const config = (mediaCap?.config ?? {}) as AudioCapabilityConfigView;
  const transportCfg = config.transport;
  const transportShown = (action: "play" | "pause" | "next" | "previous") => (transportCfg ? transportCfg[action] !== false : true);

  const live = (states[device.id]?.media ?? (device.state as Record<string, MediaStateView>).media ?? {}) as MediaStateView;
  const remoteAvail = capabilityAvailability(device, "remote");
  const mediaAvail = capabilityAvailability(device, "media");
  const playing = live.playback === "playing";

  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const press = (action: "up" | "down" | "left" | "right" | "select" | "menu" | "home") => {
    setFlash(action);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 280);
    void cmd(device.id, { capability: "remote", action });
  };

  const setKind = async (next: MediaDeviceKind) => {
    const res = await client.updateDevice(device.id, { metadata: { ...device.metadata, media: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="avr-back" onClick={onBack} aria-label="Back">←</button>
        <span className="muted">{roomName}</span>
      </div>

      <div className="aureon-detail-grid">
        <div className="aureon-detail-main">
          <div className="avr-now avr-now--wash" style={{ "--hero-wash-tint": "var(--aureon-color-gold-400)" } as CSSProperties}>
            <div className="avr-art-wrap" style={{ width: 128, height: 128 }}>
              <div className={`avr-halo${playing ? " on" : ""}`} style={{ "--avr-halo-tint": "var(--aureon-color-gold-400)" } as CSSProperties} />
              <div className={`avr-art-float${playing ? " on" : ""}`}>
                {live.artworkUrl ? (
                  <img className="avr-art" src={live.artworkUrl} alt="" style={{ width: 128, height: 128, borderRadius: 16 }} />
                ) : (
                  <div className="avr-art avr-art-placeholder hero-ic-plate" style={{ width: 128, height: 128, borderRadius: 16 }}>
                    <Icon name={kindMeta.iconName} size={44} />
                  </div>
                )}
              </div>
            </div>
            <div className="avr-now-meta">
              <span className="avr-now-label">{playing ? "NOW PLAYING" : live.playback === "paused" ? "PAUSED" : "IDLE"}</span>
              <h3>{live.title ?? device.name}</h3>
              {live.artist && <p className="avr-now-artist">{live.artist}</p>}
              <div className="avr-badges">
                <span className="avr-badge"><Icon name={kindMeta.iconName} size={13} /> {kindMeta.label}</span>
                {device.status === "online" && <span className="avr-badge">Online</span>}
              </div>
            </div>
          </div>

          <CapabilityGate available={remoteAvail.available} reason={remoteAvail.available ? undefined : remoteAvail.reason}>
            <Card>
              <div className="media-remote-body">
                <div className="media-remote-pad">
                  <button className="media-remote-up" aria-label="Up" onClick={() => press("up")}><Icon name="chevron-up" size={22} /></button>
                  <button className="media-remote-left" aria-label="Left" onClick={() => press("left")}><Icon name="chevron-left" size={22} /></button>
                  <button className={`media-remote-select${flash === "select" ? " flash" : ""}`} aria-label="Select" onClick={() => press("select")} />
                  <button className="media-remote-right" aria-label="Right" onClick={() => press("right")}><Icon name="chevron-right" size={22} /></button>
                  <button className="media-remote-down" aria-label="Down" onClick={() => press("down")}><Icon name="chevron-down" size={22} /></button>
                </div>
                <div className="media-remote-row">
                  <button className="avr-icon-btn lg" aria-label="Menu" onClick={() => press("menu")}><Icon name="menu-lines" size={18} /></button>
                  <CapabilityGate available={mediaAvail.available && transportShown(playing ? "pause" : "play")} reason={mediaAvail.available ? "Not supported by current driver" : mediaAvail.reason}>
                    <button
                      className="avr-icon-btn lg on"
                      aria-label={playing ? "Pause" : "Play"}
                      onClick={() => void cmd(device.id, { capability: "media", action: playing ? "pause" : "play" })}
                    >
                      <Icon name={playing ? "pause" : "play"} size={18} />
                    </button>
                  </CapabilityGate>
                </div>
              </div>
            </Card>
          </CapabilityGate>

          <QuickActions
            actions={[
              { key: "home", icon: <Icon name="home" size={16} />, label: "Home", onClick: () => press("home"), disabled: !remoteAvail.available },
              ...(transportShown("previous") ? [{ key: "previous", icon: <Icon name="skip-back" size={16} />, label: "Previous", onClick: () => void cmd(device.id, { capability: "media", action: "previous" }), disabled: !mediaAvail.available }] : []),
              ...(transportShown("next") ? [{ key: "next", icon: <Icon name="skip-forward" size={16} />, label: "Next", onClick: () => void cmd(device.id, { capability: "media", action: "next" }), disabled: !mediaAvail.available }] : []),
            ]}
          />
        </div>

        {/* § Design System — Universal Page Structure, same as every other device detail page. */}
        <div className="aureon-detail-side sheet-sections">
          <InformationSection device={device} roomName={roomName} />
          {devMode && <DiagnosticsSection device={device} />}
          <AutomationsSection device={device} />
          <HistorySection device={device} />
          <AdvancedSettingsSection device={device} onRemoved={onRemoved}>
            <label className="drv-field" style={{ marginBottom: 10 }}>
              <span className="lbl">Device type</span>
              <select value={kind} onChange={(e) => void setKind(e.target.value as MediaDeviceKind)}>
                {MEDIA_KIND_OPTIONS.map((o) => <option key={o.kind} value={o.kind}>{o.icon} {o.label}</option>)}
              </select>
            </label>
          </AdvancedSettingsSection>
        </div>
      </div>
    </div>
  );
}
