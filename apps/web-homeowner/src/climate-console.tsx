import { useMemo, useState, type CSSProperties } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import { useLive } from "./live.js";

/**
 * The HVAC/Climate console (§ HVAC Detail Page) — a rich, capability-driven control
 * surface for any `temperature` device whose capability config is genuinely
 * driver-reported (ClimateCapabilityConfig, from CoolMasterProtocolDriver today; any
 * future climate driver that reports the same shape renders identically here — nothing
 * in this file is CoolMaster-specific). The driver is the ONLY source of truth: modes,
 * fan speeds, and swing positions are read entirely from `device.capabilities.find(c =>
 * c.kind === "temperature").config` — a device that declares no swing positions simply
 * has no Swing row, exactly like a unit with no fan-speed control has no Fan row.
 *
 * Deliberately excluded because the driver cannot actually command them: "Dry" mode
 * (CoolMaster's ASCII_IF supports it, but Supreme's shared temperature command has no
 * "dry" value to send — see coolmaster-parser.ts's mode-mapping notes; adding it would
 * require a cross-cutting domain-model change affecting every climate device, not just
 * this console). Deliberately excluded because they're not driver-backed at all:
 * humidity, air quality, energy usage, running cost, Wi-Fi signal, compressor status.
 */

interface ClimateAdvancedControlCfg {
  key: string;
  label: string;
  kind: "toggle" | "select" | "range" | "action";
  icon?: string;
  options?: { id: string; label: string }[];
  range?: { min: number; max: number; step: number };
}
interface ClimateCapabilityConfigView {
  source?: string;
  modes?: ("heat" | "cool" | "auto" | "fan_only")[];
  fanSpeeds?: string[];
  swingPositions?: string[];
  filterSupported?: boolean;
  demandSupported?: boolean;
  faultSupported?: boolean;
  lockSupported?: boolean;
  inhibitSupported?: boolean;
  line?: string;
  manufacturer?: string | null;
  advancedControls?: ClimateAdvancedControlCfg[];
}
interface TemperatureStateView {
  ambientC: number;
  targetC: number | null;
  mode: "off" | "heat" | "cool" | "auto" | "fan_only";
  advanced?: Record<string, unknown> | null;
}

const cmd = (id: string, c: CapabilityCommand) => client.command(id as DeviceId, c);

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // unsupported — fine
  }
}

const MIN_C = 16;
const MAX_C = 30;
const STEP_C = 0.5;
const DIAL_TICK_COUNT = 48;

const MODE_META: Record<"heat" | "cool" | "auto" | "fan_only", { label: string; icon: string }> = {
  heat: { label: "Heat", icon: "🔥" },
  cool: { label: "Cool", icon: "❄️" },
  auto: { label: "Auto", icon: "🔄" },
  fan_only: { label: "Fan", icon: "🌀" },
};

function fanSpeedGlyph(speed: string): string {
  const s = speed.toLowerCase();
  if (s === "auto") return "🔄";
  if (s === "top" || s === "turbo") return "🌀";
  return "🌀";
}

function swingGlyph(pos: string): string {
  const s = pos.toLowerCase();
  if (s === "up") return "⤒";
  if (s === "down") return "⤓";
  if (s === "left") return "⇤";
  if (s === "right") return "⇥";
  if (s === "auto") return "↕";
  return "↕";
}

function clampC(v: number): number {
  return Math.max(MIN_C, Math.min(MAX_C, Math.round(v / STEP_C) * STEP_C));
}

/** The large hero circular gauge (§ "large premium circular temperature dial as the
 * hero control") — same brushed-metal/tick-mark/reactive-glow mechanics as the AVR
 * console's VolumeDial (§ Volume Knob), mapped to the 16–30°C setpoint range instead of
 * 0–100 volume, so the two consoles share one unmistakable SupremeOS control language. */
function TemperatureDial({
  targetC, mode, onChange,
}: { targetC: number; mode: "off" | "heat" | "cool" | "auto" | "fan_only"; onChange: (v: number) => void }) {
  const r = 80;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, ((targetC - MIN_C) / (MAX_C - MIN_C)) * 100));
  const offset = c - (pct / 100) * c;
  const litTicks = Math.round((pct / 100) * DIAL_TICK_COUNT);
  const modeMeta = mode !== "off" ? MODE_META[mode] : null;

  return (
    <div className="climate-dial-col">
      <div className="climate-dial" style={{ "--climate-dial-glow": (pct / 100).toFixed(2) } as CSSProperties}>
        <div className="climate-dial-ticks">
          {Array.from({ length: DIAL_TICK_COUNT }, (_, i) => (
            <span
              key={i}
              className={`climate-dial-tick${i < litTicks ? " on" : ""}${i % 4 === 0 ? " major" : ""}`}
              style={{ transform: `rotate(${(i / DIAL_TICK_COUNT) * 360}deg)` }}
            />
          ))}
        </div>
        <svg width="208" height="208" viewBox="0 0 208 208">
          <circle cx="104" cy="104" r={r} className="climate-dial-track" />
          <circle
            cx="104" cy="104" r={r} className="climate-dial-fill"
            strokeDasharray={c} strokeDashoffset={offset}
            transform="rotate(-90 104 104)"
          />
        </svg>
        <div className="climate-dial-label">
          <span className="climate-dial-caption">SET TEMPERATURE</span>
          <span className="climate-dial-value">{targetC.toFixed(1)}<span className="climate-dial-unit">°C</span></span>
          {modeMeta && <span className="climate-dial-mode">{modeMeta.icon} {modeMeta.label}</span>}
        </div>
        <input
          className="climate-dial-input"
          type="range" min={MIN_C} max={MAX_C} step={STEP_C} value={targetC}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Set temperature"
        />
      </div>
      <div className="climate-dial-steppers">
        <button className="climate-icon-btn lg" onClick={() => onChange(clampC(targetC - STEP_C))} aria-label="Lower temperature">−</button>
        <button className="climate-icon-btn lg" onClick={() => onChange(clampC(targetC + STEP_C))} aria-label="Raise temperature">+</button>
      </div>
    </div>
  );
}

function ModeSelector({
  modes, active, onSelect,
}: { modes: ("heat" | "cool" | "auto" | "fan_only")[]; active: string; onSelect: (m: "heat" | "cool" | "auto" | "fan_only") => void }) {
  if (modes.length === 0) return null;
  return (
    <div className="climate-field">
      <span className="climate-field-label">Mode</span>
      <div className="climate-hw-row">
        {modes.map((m) => (
          <button key={m} className={`climate-hw-btn${active === m ? " on" : ""}`} onClick={() => onSelect(m)}>
            <span className="climate-hw-ic">{MODE_META[m].icon}</span>
            <span className="climate-hw-label">{MODE_META[m].label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FanSpeedSelector({ speeds, active, onSelect }: { speeds: string[]; active: string | null; onSelect: (s: string) => void }) {
  if (speeds.length === 0) return null;
  return (
    <div className="climate-field">
      <span className="climate-field-label">Fan Speed</span>
      <div className="climate-hw-row">
        {speeds.map((s) => (
          <button key={s} className={`climate-hw-btn${active === s ? " on" : ""}`} onClick={() => onSelect(s)}>
            <span className="climate-hw-ic">{fanSpeedGlyph(s)}</span>
            <span className="climate-hw-label">{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Auto-hides entirely when this unit declares no swing positions (§ "The page must
 * automatically adapt if Swing is unsupported"). */
function SwingSelector({ positions, active, onSelect }: { positions: string[]; active: string | null; onSelect: (p: string) => void }) {
  if (positions.length === 0) return null;
  return (
    <div className="climate-field">
      <span className="climate-field-label">Swing</span>
      <div className="climate-hw-row">
        {positions.map((p) => (
          <button key={p} className={`climate-hw-btn${active === p ? " on" : ""}`} onClick={() => onSelect(p)}>
            <span className="climate-hw-ic">{swingGlyph(p)}</span>
            <span className="climate-hw-label">{p}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type QuickPreset = "comfort" | "eco" | "away";

function QuickActions({
  active, onPreset, onSchedule,
}: { active: QuickPreset | null; onPreset: (p: QuickPreset) => void; onSchedule: () => void }) {
  return (
    <div className="climate-quick">
      <span className="climate-field-label">Quick Actions</span>
      <div className="climate-quick-grid">
        <button className={`climate-quick-tile${active === "comfort" ? " on" : ""}`} onClick={() => onPreset("comfort")}>
          <span className="climate-quick-ic">🌿</span><span>Comfort</span>
        </button>
        <button className={`climate-quick-tile${active === "eco" ? " on" : ""}`} onClick={() => onPreset("eco")}>
          <span className="climate-quick-ic">🍃</span><span>Eco</span>
        </button>
        <button className={`climate-quick-tile${active === "away" ? " on" : ""}`} onClick={() => onPreset("away")}>
          <span className="climate-quick-ic">🏠</span><span>Away</span>
        </button>
        <button className="climate-quick-tile" onClick={onSchedule}>
          <span className="climate-quick-ic">📅</span><span>Schedule</span>
        </button>
      </div>
    </div>
  );
}

/** Lock/Inhibit/Filter-reset — genuinely driver-backed (ClimateCapabilityConfig
 * advancedControls) but installer/secondary-facing, not part of the homeowner's primary
 * "Show only: Power, Set Temperature, Current Temperature, HVAC Mode, Fan Speed, Swing,
 * Online Status" list — surfaced behind "Advanced Settings" instead, matching the
 * reference mockup's own "Advanced Settings ›" affordance. Each row only renders when
 * this specific unit's config actually declares support (never a fixed set). */
function AdvancedSettingsModal({
  controls, advanced, onSetAdvanced, onClose,
}: {
  controls: ClimateAdvancedControlCfg[];
  advanced: Record<string, unknown>;
  onSetAdvanced: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  return (
    <div className="climate-modal-veil" onClick={onClose}>
      <div className="climate-modal" onClick={(e) => e.stopPropagation()}>
        <div className="climate-modal-head">
          <h3>Advanced Settings</h3>
          <button className="climate-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="climate-modal-body">
          {controls.length === 0 && <p className="climate-modal-empty">This unit reports no advanced controls.</p>}
          {controls.map((c) => {
            if (c.kind === "toggle") {
              const on = advanced[c.key] === true;
              return (
                <div key={c.key} className="climate-modal-row">
                  <span>{c.label}</span>
                  <button className={`climate-toggle${on ? " on" : ""}`} onClick={() => onSetAdvanced(c.key, !on)} aria-pressed={on}>
                    <span className="climate-toggle-knob" />
                  </button>
                </div>
              );
            }
            if (c.kind === "action" && c.key === "filterReset") {
              return (
                <div key={c.key} className="climate-modal-row">
                  <span>{c.label}</span>
                  <button className="climate-modal-action" onClick={() => onSetAdvanced(c.key, true)}>Reset</button>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

function AcInfoCard({
  device, roomName, brand, unitType, onEditBrand, onEditType, onOpenAdvanced,
}: {
  device: Device; roomName: string; brand: string | null; unitType: string | null;
  onEditBrand: () => void; onEditType: () => void; onOpenAdvanced: () => void;
}) {
  const online = device.status === "online";
  return (
    <aside className="climate-info-card">
      <div className="climate-info-head">
        <span className="climate-info-title">AC Unit</span>
        <span className={`climate-status${online ? " good" : ""}`}><i /> {online ? "Online" : device.status === "offline" ? "Offline" : "Unavailable"}</span>
      </div>
      <dl className="climate-info-list">
        <div className="climate-info-row" onClick={onEditBrand}>
          <dt>Brand</dt>
          <dd>{brand ?? "Not set"} <span className="climate-info-edit">✎</span></dd>
        </div>
        <div className="climate-info-row" onClick={onEditType}>
          <dt>Indoor Unit Type</dt>
          <dd>{unitType ?? "Not set"} <span className="climate-info-edit">✎</span></dd>
        </div>
        <div className="climate-info-row">
          <dt>Room</dt>
          <dd>{roomName}</dd>
        </div>
      </dl>
      <button className="climate-advanced-btn" onClick={onOpenAdvanced}>
        <span>⚙ Advanced Settings</span><span>›</span>
      </button>
    </aside>
  );
}

function MiniBar({
  device, live, onPower, powerOn, onStep,
}: { device: Device; live: TemperatureStateView; onPower: () => void; powerOn: boolean; onStep: (delta: number) => void }) {
  const modeMeta = live.mode !== "off" ? MODE_META[live.mode] : null;
  return (
    <div className="climate-mini">
      <div className="climate-mini-ic">{modeMeta?.icon ?? "❄"}</div>
      <div className="climate-mini-meta">
        <span className="climate-mini-title">{device.name}</span>
        <span className="climate-mini-sub">{powerOn ? `${(live.targetC ?? live.ambientC).toFixed(1)}°C · ${modeMeta?.label ?? "Off"}` : "Off"}</span>
      </div>
      <div className="climate-mini-transport">
        <button onClick={() => onStep(-STEP_C)} aria-label="Lower temperature">−</button>
        <button className={`climate-mini-pp${powerOn ? " on" : ""}`} onClick={onPower}>⏻</button>
        <button onClick={() => onStep(STEP_C)} aria-label="Raise temperature">+</button>
      </div>
      <span className="climate-mini-ambient">{live.ambientC.toFixed(1)}°C room</span>
    </div>
  );
}

export function ClimateConsole({
  device, roomName, onBack, onNavigateDevice, onRemoved, onDeviceUpdated, onOpenSchedule,
}: {
  device: Device;
  roomName: string;
  onBack: () => void;
  onNavigateDevice: (d: Device) => void;
  onRemoved: () => void;
  onDeviceUpdated?: (d: Device) => void;
  onOpenSchedule?: (device: Device) => void;
}) {
  void onNavigateDevice; // reserved for a future multi-zone AC selector, unused today (single unit per device)
  const { states, apply } = useLive();
  const tempCap = device.capabilities.find((c) => c.kind === "temperature");
  const config = (tempCap?.config ?? {}) as ClimateCapabilityConfigView;
  const onoffSupported = device.capabilities.some((c) => c.kind === "onoff");
  const live = (states[device.id]?.temperature ?? (device.state as Record<string, TemperatureStateView>).temperature ?? { ambientC: 21, targetC: 21, mode: "off" }) as TemperatureStateView;
  const power = (states[device.id]?.onoff ?? (device.state as Record<string, { on?: boolean }>).onoff) as { on?: boolean } | undefined;
  const powerOn = power?.on === true;

  const [menuOpen, setMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<QuickPreset | null>(null);

  const modes = config.modes ?? [];
  const fanSpeeds = config.fanSpeeds ?? [];
  const swingPositions = config.swingPositions ?? [];
  const advanced = useMemo(() => live.advanced ?? {}, [live.advanced]);
  const advancedControls = useMemo(
    () => (config.advancedControls ?? []).filter((c) => {
      if (c.key === "fanSpeed" || c.key === "swing") return false; // rendered as their own rows above, not in Advanced Settings
      if (c.key === "filterReset") return config.filterSupported === true;
      return true;
    }),
    [config.advancedControls, config.filterSupported],
  );

  const hvacMeta = (device.metadata as Record<string, unknown> | undefined)?.hvac as { brand?: string; unitType?: string } | undefined;

  const applyTemp = (patch: Partial<TemperatureStateView>) => apply(device.id, "temperature", { ...live, ...patch });

  const setTarget = (v: number) => {
    setActivePreset(null);
    applyTemp({ targetC: v });
    void cmd(device.id, { capability: "temperature", targetC: v });
  };
  const setMode = (m: "heat" | "cool" | "auto" | "fan_only") => {
    vibrate(8);
    setActivePreset(null);
    applyTemp({ mode: m });
    void cmd(device.id, { capability: "temperature", mode: m });
  };
  const setAdvanced = (key: string, value: unknown) => {
    vibrate(6);
    applyTemp({ advanced: { ...advanced, [key]: value } });
    void cmd(device.id, { capability: "temperature", advanced: { [key]: value } });
  };
  const setPower = (on: boolean) => {
    vibrate(10);
    apply(device.id, "onoff", { kind: "onoff", on });
    void cmd(device.id, { capability: "onoff", action: on ? "on" : "off" });
  };
  const applyPreset = (preset: QuickPreset) => {
    vibrate(10);
    setActivePreset(preset);
    // Quick Actions are SupremeOS-defined presets (§ "implemented by SupremeOS"), not
    // driver features — they simply compose the same real onoff/temperature commands
    // every other control on this page sends.
    if (preset === "comfort") {
      setPower(true);
      const m = modes.includes("auto") ? "auto" : (modes[0] ?? "auto");
      applyTemp({ mode: m, targetC: 22 });
      void cmd(device.id, { capability: "temperature", mode: m, targetC: 22 });
    } else if (preset === "eco") {
      setPower(true);
      const target = live.mode === "heat" ? 19 : 26;
      applyTemp({ targetC: target });
      void cmd(device.id, { capability: "temperature", targetC: target });
    } else if (preset === "away") {
      const target = live.mode === "heat" ? 16 : 28;
      applyTemp({ targetC: target });
      void cmd(device.id, { capability: "temperature", targetC: target });
    }
  };

  const editMeta = async (field: "brand" | "unitType", label: string) => {
    const current = hvacMeta?.[field] ?? "";
    const next = window.prompt(`${label} (installer-entered, not read from the driver)`, current);
    if (next === null) return;
    const trimmed = next.trim();
    const res = await client.updateDevice(device.id, { metadata: { hvac: { ...hvacMeta, [field]: trimmed || undefined } } });
    onDeviceUpdated?.(res.device);
  };

  const rename = async () => {
    const name = window.prompt("Rename device", device.name);
    if (name && name.trim() && name !== device.name) {
      const res = await client.updateDevice(device.id, { name: name.trim() });
      onDeviceUpdated?.(res.device);
    }
    setMenuOpen(false);
  };
  const remove = async () => {
    if (!window.confirm(`Remove "${device.name}"? This can't be undone.`)) return;
    await client.deleteDevice(device.id);
    onRemoved();
  };

  return (
    <div className="climate-console">
      <div className="climate-main">
        <div className="climate-head-card">
          <button className="climate-back" onClick={onBack} aria-label="Back">←</button>
          <div className="climate-head-ic">❄</div>
          <div className="climate-head-meta">
            <h2>{device.name}</h2>
            <p>{hvacMeta?.brand ? `${hvacMeta.brand} HVAC` : "HVAC"}</p>
          </div>
          <div className="climate-head-actions">
            <div className="climate-menu-wrap">
              <button className="climate-icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="More">⋮</button>
              {menuOpen && (
                <div className="climate-menu">
                  <button onClick={() => void rename()}>Rename</button>
                  <button className="danger" onClick={() => void remove()}>Remove device</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={`climate-hero${device.status !== "online" ? " offline" : ""}`}>
          <TemperatureDial targetC={live.targetC ?? live.ambientC} mode={live.mode} onChange={setTarget} />
          {onoffSupported && (
            <button className={`climate-power-btn${powerOn ? " on" : ""}`} onClick={() => setPower(!powerOn)}>
              <span className="climate-power-ic">⏻</span> Power {powerOn ? "ON" : "OFF"}
            </button>
          )}
          <div className="climate-status-row">
            <span className="climate-status-cell"><span className="climate-status-ic">🌡</span>Room Temperature<b>{live.ambientC.toFixed(1)}°C</b></span>
            <span className="climate-status-cell"><span className="climate-status-ic">📶</span>Status<b className={device.status === "online" ? "good" : ""}>{device.status === "online" ? "Online" : "Offline"}</b></span>
          </div>
        </div>
      </div>

      <div className="climate-fields-col">
        <ModeSelector modes={modes} active={live.mode} onSelect={setMode} />
        <FanSpeedSelector speeds={fanSpeeds} active={typeof advanced.fanSpeed === "string" ? advanced.fanSpeed as string : null} onSelect={(s) => setAdvanced("fanSpeed", s)} />
        <SwingSelector positions={swingPositions} active={typeof advanced.swing === "string" ? advanced.swing as string : null} onSelect={(p) => setAdvanced("swing", p)} />
        <QuickActions active={activePreset} onPreset={applyPreset} onSchedule={() => onOpenSchedule?.(device)} />
      </div>

      <AcInfoCard
        device={device} roomName={roomName}
        brand={hvacMeta?.brand ?? null} unitType={hvacMeta?.unitType ?? null}
        onEditBrand={() => void editMeta("brand", "Brand")}
        onEditType={() => void editMeta("unitType", "Indoor Unit Type")}
        onOpenAdvanced={() => setAdvancedOpen(true)}
      />

      {advancedOpen && (
        <AdvancedSettingsModal
          controls={advancedControls}
          advanced={advanced}
          onSetAdvanced={setAdvanced}
          onClose={() => setAdvancedOpen(false)}
        />
      )}

      <MiniBar device={device} live={live} powerOn={powerOn} onPower={() => setPower(!powerOn)} onStep={(d) => setTarget(clampC((live.targetC ?? live.ambientC) + d))} />
    </div>
  );
}
