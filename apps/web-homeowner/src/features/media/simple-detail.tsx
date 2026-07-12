import { useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { Button, CapabilityGate, Card, Grid, Stack } from "@supreme/aureon-web";
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
import { capabilityAvailability } from "../_shared/capability-availability.js";
import { MEDIA_KIND_OPTIONS, mediaDeviceKind, mediaKindMeta, type MediaDeviceKind } from "./capability-mapper.js";

interface SimpleMediaState {
  volume?: number;
  source?: string | null;
}
interface MediaInput {
  id: string;
  label: string;
}

/**
 * Television / Projector premium detail page (§ Premium Device Experience Library). Both are
 * the same real `media` capability as AVR/Speaker, but the receiver-shaped AvrConsole (zones,
 * tone controls, listening-mode DSP) is the wrong UI for either — a TV has none of that. This
 * is the consumer-facing shape instead: Power/Volume/Source as real controls when the driver
 * backs them, plus the rest of a television's expected control set (Apps, Picture Mode, Audio
 * Output, Channel, Remote Control) shown as capability-gated placeholders — the full design is
 * here from day one; drivers fill in the gates over time (§ "the UI is the contract").
 */
export function SimpleMediaDetail({
  device, roomName, onBack, onRemoved, onDeviceUpdated, devMode = false,
}: {
  device: Device;
  roomName: string;
  onBack: () => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  devMode?: boolean;
}) {
  const { states, apply } = useLive();
  const [registry] = useAsync(() => fetchDriverRegistry());
  const driver = device.driverId ? registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null : null;
  const kind = mediaDeviceKind(device, driver?.protocols[0] ?? null);
  const kindMeta = mediaKindMeta(kind);

  const mediaCap = device.capabilities.find((c) => c.kind === "media");
  const config = (mediaCap?.config ?? {}) as Record<string, unknown>;
  const inputs = Array.isArray(config.inputs) ? (config.inputs as MediaInput[]) : [];

  const live = (states[device.id]?.media ?? (device.state as Record<string, SimpleMediaState>).media ?? {}) as SimpleMediaState;
  const power = (states[device.id]?.onoff ?? (device.state as Record<string, { on?: boolean }>).onoff) as { on?: boolean } | undefined;
  const on = power?.on ?? false;

  const powerAvail = capabilityAvailability(device, "onoff");
  const volumeAvail = capabilityAvailability(device, "media");
  const sourceAvail = inputs.length > 0 ? capabilityAvailability(device, "media") : capabilityAvailability(device, "media", "inputs");
  const appsAvail = capabilityAvailability(device, "media", "apps");
  const pictureModeAvail = capabilityAvailability(device, "media", "pictureModes");
  const audioOutputAvail = capabilityAvailability(device, "media", "audioOutputs");
  const channelAvail = capabilityAvailability(device, "media", "channels");
  const remoteAvail = capabilityAvailability(device, "media", "remoteKeys");

  const setPower = (next: boolean) => {
    apply(device.id, "onoff", { kind: "onoff", on: next });
    void client.command(device.id as DeviceId, { capability: "onoff", action: next ? "on" : "off" });
  };
  const setVolume = (v: number) => {
    apply(device.id, "media", { ...live, volume: v });
    void client.command(device.id as DeviceId, { capability: "media", action: "volume", volume: v });
  };
  const setSource = (id: string) => {
    apply(device.id, "media", { ...live, source: id });
    void client.command(device.id as DeviceId, { capability: "media", action: "source", source: id });
  };
  const setKind = async (next: MediaDeviceKind) => {
    const res = await client.updateDevice(device.id as DeviceId, { metadata: { ...device.metadata, media: { kind: next } } });
    onDeviceUpdated?.(res.device);
  };

  return (
    <div className="page">
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
      </div>

      <Stack gap="lg" style={{ marginTop: 20 }}>
        <CapabilityGate available={powerAvail.available} reason={powerAvail.available ? undefined : powerAvail.reason}>
          <Button variant={on ? "primary" : "secondary"} size="lg" onClick={() => setPower(!on)}>⏻ {on ? "On" : "Off"}</Button>
        </CapabilityGate>

        <CapabilityGate available={volumeAvail.available} reason={volumeAvail.available ? undefined : volumeAvail.reason}>
          <Card>
            <span className="avr-field-label">Volume</span>
            <input
              className="cover-slider" type="range" min={0} max={100} value={live.volume ?? 0}
              onChange={(e) => setVolume(Number(e.target.value))} style={{ marginTop: 10 }}
            />
          </Card>
        </CapabilityGate>

        <CapabilityGate available={sourceAvail.available} reason={sourceAvail.available ? undefined : sourceAvail.reason}>
          <Card>
            <span className="avr-field-label">Source</span>
            <div style={{ marginTop: 10 }}>
              <Grid minItemWidth={130} gap="sm">
                {inputs.map((i) => (
                  <Button key={i.id} variant={live.source === i.id ? "primary" : "secondary"} onClick={() => setSource(i.id)}>{i.label}</Button>
                ))}
              </Grid>
            </div>
          </Card>
        </CapabilityGate>
      </Stack>

      <h2 className="section">More controls</h2>
      <Grid minItemWidth={130} gap="sm">
        <CapabilityGate available={appsAvail.available} reason={appsAvail.available ? undefined : appsAvail.reason}>
          <Card interactive>📱 Apps</Card>
        </CapabilityGate>
        <CapabilityGate available={pictureModeAvail.available} reason={pictureModeAvail.available ? undefined : pictureModeAvail.reason}>
          <Card interactive>🖼️ Picture Mode</Card>
        </CapabilityGate>
        <CapabilityGate available={audioOutputAvail.available} reason={audioOutputAvail.available ? undefined : audioOutputAvail.reason}>
          <Card interactive>🔈 Audio Output</Card>
        </CapabilityGate>
        <CapabilityGate available={channelAvail.available} reason={channelAvail.available ? undefined : channelAvail.reason}>
          <Card interactive>📡 Channel</Card>
        </CapabilityGate>
        <CapabilityGate available={remoteAvail.available} reason={remoteAvail.available ? undefined : remoteAvail.reason}>
          <Card interactive>🎛️ Remote Control</Card>
        </CapabilityGate>
      </Grid>

      {/* § Design System — Universal Page Structure: same sections every device detail page
          shows, capability- and data-driven, never protocol-driven. */}
      <div className="sheet-sections">
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
  );
}
